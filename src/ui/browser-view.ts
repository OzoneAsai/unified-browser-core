import { bindAddressSuggestions } from "./address-suggestions";
import { observeGuestInteraction } from "../adapters/guest-interaction";
import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { BrowserOpenRequest } from "../main";
import { createId } from "../core/id";
import type {
  BookmarkEntry,
  BrowserLeafRecord,
  BrowserLeafViewState,
  ContainerId,
  FormRecoveryField,
  HistoryNode,
  NavigationNode,
} from "../core/model";
import { hostZoomFactor } from "../adapters/electron-zoom";
import { ElectronNavigationHistoryAdapter } from "../adapters/electron-navigation-history";
import { historyDayKey } from "../history/day-key";
import { classifyInPageNavigation } from "../history/navigation-classifier";
import {
  showFavoritesBarMenu,
  showBookmarkFolderMenu,
  showBookmarkMenu,
  showPageMenu,
  showWebContentMenu,
} from "./context-menus";
import type {
  WebviewContextMenuEvent,
  WebviewElement,
  WebviewFaviconEvent,
  WebviewNavigateEvent,
  WebviewTitleEvent,
} from "./webview-types";
import type { BrowserTransientHistoryEntry } from "../core/model";
import { showRecoveryDetails } from "./recovery-details-modal";
import { showFormRecoveryCandidates } from "./form-recovery-candidates-modal";
import { confirmAction } from "./confirm-modal";
import { resolveTabLayoutPolicy } from "../tabs/tab-layout-policy";
import { normalizeBrowserAddress } from "../navigation/address-normalizer";
import type { VaultHomeFile } from "../adapters/obsidian-home";
import { buildWebContentMenuEntries } from "./web-content-menu-model";
import { editBookmark } from "./bookmark-editor";
import { pickBookmarkFolder } from "./folder-picker-modal";
import { showBookmarkPopover } from "./bookmark-popover";
import { BOOKMARK_MEDIA, classifyBookmark } from "../bookmarks/bookmark-media";
import { t } from "../i18n";
import { promptText } from "./text-prompt";
import { permissionDecisionLabel, permissionLabel } from "./permission-label";
import { fallbackFaviconUrl, renderBookmarkVisual } from "./bookmark-visual";
import { resolveBookmarkUrl } from "../bookmarks/bookmark-url";
import { dismissOpenMenus, showDismissibleMenu, trackDismissibleMenu } from "./popup-dismissal";

export const BROWSER_VIEW_TYPE = "unified-browser-core-view";

type HistoryIntent = "back" | "forward" | null;
type NavigationStatus = "idle" | "waiting" | "loading" | "loaded" | "failed" | "offline" | "stopped" | "restored";
export type WebEditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll";
export class BrowserView extends ItemView {
  private rootEl!: HTMLDivElement;
  private toolbarEl!: HTMLDivElement;
  private backButtonEl!: HTMLButtonElement;
  private forwardButtonEl!: HTMLButtonElement;
  private reloadButtonEl!: HTMLButtonElement;
  private favoritesBarEl!: HTMLDivElement;
  private bookmarkButtonEl!: HTMLButtonElement;
  private recoveryBannerEl!: HTMLDivElement;
  private browserContentEl!: HTMLDivElement;
  private webLayerEl!: HTMLDivElement;
  private internalLayerEl!: HTMLDivElement;
  private loadingShieldEl!: HTMLDivElement;
  private addressEl!: HTMLInputElement;
  private containerButtonEl!: HTMLButtonElement;
  private activeContainerMenu: Menu | null = null;
  private statusEl!: HTMLSpanElement;
  private browserHeaderTitleEl: HTMLElement | null = null;
  private browserHeaderEl: HTMLElement | null = null;
  private historySearchEl: HTMLInputElement | null = null;
  private webview: WebviewElement | null = null;
  private webviewDomReady = false;
  private internalSurface: BrowserLeafViewState["internalSurface"] | null = null;
  private containerId: ContainerId = "default";
  private siteAssignmentBypassOrigin: string | undefined;
  private siteAssignmentBypassReason: "explicit" | "opener" | undefined;
  private faviconDataUrl: string | undefined;
  private faviconSourceUrl: string | undefined;
  private currentTitle = "New tab";
  private currentUrlValue = "browser://home";
  private pendingHistoryIntent: HistoryIntent = null;
  private lastNavigatedUrl = "";
  private lifecycleId = createId("leaf");
  private pinned = false;
  private stateInitialized = false;
  private pendingViewState: BrowserLeafViewState | undefined;
  private manualRetention: "default" | "preserve" = "default";
  private restoredFromLeafId: string | undefined;
  private restoreTargetUrl: string | undefined;
  private restoreTargetIndex: number | undefined;
  private checkpointTimer: number | undefined;
  private popupDisposer: (() => void) | undefined;
  private contextMenuDisposer: (() => void) | undefined;
  private formRecoveryWatchEnabled = false;
  private richRestoreAttempted = false;
  private restoreIntentGeneration = 0;
  private pendingInitialWebUrl: string | undefined;
  private ignoreBootstrapAboutBlank = false;
  private clearBootstrapHistoryAfterFallback = false;
  private transientHistory: BrowserTransientHistoryEntry[] = [];
  private transientIndex = -1;
  private pendingTransientTraversalIndex: number | null = null;
  private historyObserver: IntersectionObserver | null = null;
  private historyRevealNodeId: string | undefined;
  private closeReasonOverride: BrowserLeafRecord["closeReason"] | undefined;
  private readonly expandedHistoryBranches = new Set<string>();
  private readonly expandedResidualParents = new Set<string>();
  private readonly collapsedBookmarkFolders = new Set<string>();
  private bookmarkSearchQuery = "";
  private bookmarkLayout: "type" | "folder" | "selected" = "type";
  private bookmarkPopoverClose?: () => void;
  private recoveryInteractionDisposer?: () => void;
  private popupInteractionDisposer?: () => void;
  private readonly navigationHistoryAdapter = new ElectronNavigationHistoryAdapter();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(leaf);
    this.navigation = true;
  }

  private leafId(): string {
    return this.lifecycleId;
  }

  private refreshLeafHeader(): void {
    const container = this.leaf.getContainer();
    const activeInWindow = this.plugin.app.workspace.getMostRecentLeaf(container) === this.leaf;
    this.plugin.tabStripAdapter.refreshLeafHeader(this.leaf, activeInWindow);
    window.requestAnimationFrame(() => {
      this.applyTabStyle();
    });
  }

  getViewType(): string {
    return BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentTitle || "Browser";
  }

  getIcon(): string {
    return "globe";
  }

  async onOpen(): Promise<void> {
    this.rootEl = this.contentEl as HTMLDivElement;
    this.rootEl.empty();
    this.rootEl.addClass("ubc-browser-view");
    this.applyAccessibility();
    this.registerDomEvent(this.rootEl.ownerDocument, "pointerdown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu")) return;
      this.dismissTransientPopups();
    }, true);

    this.registerEvent(this.leaf.on("pinned-change", (pinned) => {
      this.pinned = pinned;
      this.plugin.core.history.touchLeaf(this.leafId(), { pinned });
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      this.applyTabStyle();
    }));

    this.buildChrome();
    this.applyTabStyle();

    if (this.pendingViewState) {
      const pending = this.pendingViewState;
      this.pendingViewState = undefined;
      this.applyViewState(pending);
    }
  }

  async onClose(): Promise<void> {
    this.activeContainerMenu?.hide();
    await this.captureRecoveryState();
    this.disconnectHistoryObserver();
    if (this.webview) await this.teardownFormRecoveryInstrumentation(this.webview);
    this.destroyWebview();
    this.clearTabStyle();
    this.browserHeaderTitleEl?.removeClass("ubc-browser-title-container");
    this.browserHeaderEl?.removeClass("ubc-browser-view-header");
    this.browserHeaderTitleEl = null;
    this.browserHeaderEl = null;

    if (this.plugin.isUnloading()) {
      this.finalizeClose("shutdown");
      return;
    }
    if (this.closeReasonOverride) {
      this.finalizeClose(this.closeReasonOverride);
      return;
    }

    // Obsidian calls onClose() before the leaf replacement/detach is fully
    // reflected in workspace state. Defer unmarked closure classification by
    // one event-loop turn so Quick Switcher/file opens can be distinguished
    // from actually closing the tab.
    window.setTimeout(() => {
      let leafStillExists = false;
      this.plugin.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf === this.leaf) leafStillExists = true;
      });
      const reason: BrowserLeafRecord["closeReason"] =
        leafStillExists && this.leaf.view !== this ? "view-replaced" : "user";
      this.finalizeClose(reason);
    }, 0);
  }

  private finalizeClose(reason: BrowserLeafRecord["closeReason"]): void {
    this.plugin.core.history.closeLeaf(this.leafId(), reason);
    this.plugin.core.scheduleSave();
  }

  getState(): BrowserLeafViewState {
    return {
      lifecycleId: this.lifecycleId,
      bookmarkLayout: this.bookmarkLayout,
      title: this.currentTitle,
      faviconDataUrl: this.faviconDataUrl,
      url: this.currentUrlValue,
      containerId: this.containerId,
      siteAssignmentBypassOrigin: this.siteAssignmentBypassOrigin,
      siteAssignmentBypassReason: this.siteAssignmentBypassReason,
      pinned: this.pinned,
      manualRetention: this.manualRetention,
      restoredFromLeafId: this.restoredFromLeafId,
      internalSurface: this.internalSurface ?? undefined,
      transientHistory: [...this.transientHistory],
      transientIndex: this.transientIndex,
    };
  }

  async setState(state: BrowserLeafViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (!this.rootEl) {
      this.pendingViewState = { ...state };
      return;
    }
    this.applyViewState(state);
  }

  private applyViewState(state: BrowserLeafViewState): void {
    if (state.bookmarkLayout) this.bookmarkLayout = state.bookmarkLayout;
    const url = state.url || (state.internalSurface ? "browser://" + state.internalSurface : "browser://home");
    const requestedContainer = this.plugin.core.normalizeContainer(state.containerId);
    const initialState = !this.stateInitialized;

    if (!initialState && requestedContainer !== this.containerId) {
      void this.replaceCurrentTab({
        url,
        containerId: requestedContainer,
        state: {
          pinned: state.pinned,
          manualRetention: state.manualRetention ?? this.manualRetention,
          siteAssignmentBypassOrigin: state.siteAssignmentBypassOrigin,
          siteAssignmentBypassReason: state.siteAssignmentBypassReason,
          restoreTargetUrl: state.restoreTargetUrl,
          restoreTargetIndex: state.restoreTargetIndex,
          internalSurface: state.internalSurface,
          transientHistory: state.transientHistory,
          transientIndex: state.transientIndex,
        },
      });
      return;
    }

    if (initialState) {
      const savedLeaf = this.plugin.core.state.history.leaves[state.lifecycleId ?? state.restoredFromLeafId ?? ""];
      const savedEntry = state.transientHistory?.[state.transientIndex ?? state.transientHistory.length - 1];
      const savedTitle = state.title ?? (savedEntry?.kind === "web" ? savedEntry.title : undefined) ?? savedLeaf?.lastTitle;
      this.currentTitle = savedTitle?.trim() || url;
      this.faviconDataUrl = validSavedFavicon(state.faviconDataUrl);
      this.refreshLeafHeader();
      if (state.lifecycleId) this.lifecycleId = state.lifecycleId;
      this.containerId = requestedContainer;
      this.pinned = state.pinned ?? this.pinned;
    }

    this.manualRetention = state.manualRetention ?? this.manualRetention;
    this.siteAssignmentBypassOrigin = state.siteAssignmentBypassOrigin;
    this.siteAssignmentBypassReason = state.siteAssignmentBypassReason ?? (
      state.siteAssignmentBypassOrigin ? "explicit" : undefined
    );
    this.restoredFromLeafId = state.restoredFromLeafId;
    this.restoreTargetUrl = state.restoreTargetUrl;
    this.restoreTargetIndex = state.restoreTargetIndex;

    if (state.transientHistory) this.transientHistory = [...state.transientHistory];
    else if (initialState) this.transientHistory = [];
    this.transientIndex = typeof state.transientIndex === "number"
      ? state.transientIndex
      : this.transientHistory.length - 1;

    if (initialState) {
      this.plugin.core.history.beginLeaf({
        leafId: this.leafId(),
        containerId: this.containerId,
        pinned: this.pinned,
        manualRetention: this.manualRetention,
        restoredFromLeafId: this.restoredFromLeafId,
        url,
      });
      this.stateInitialized = true;
    } else {
      this.plugin.core.history.touchLeaf(this.leafId(), {
        containerId: this.containerId,
        pinned: this.pinned,
        manualRetention: this.manualRetention,
        restoredFromLeafId: this.restoredFromLeafId,
        lastUrl: url,
      });
    }

    if (url.startsWith("browser://")) {
      this.showInternal(
        (url.slice("browser://".length) || "home") as BrowserLeafViewState["internalSurface"],
        this.transientHistory.length === 0,
        false,
      );
    } else {
      this.navigate(url);
    }
    this.refreshNavigationButtons();
  }

  currentUrl(): string {
    return this.currentUrlValue;
  }

  zoomIn(): void {
    this.applyZoom(this.plugin.core.zoom.adjust(this.currentUrlValue, 0.1));
  }

  zoomOut(): void {
    this.applyZoom(this.plugin.core.zoom.adjust(this.currentUrlValue, -0.1));
  }

  resetZoom(): void {
    this.plugin.core.zoom.reset(this.currentUrlValue);
    this.applyZoom(this.plugin.core.zoom.factorForUrl(this.currentUrlValue));
  }

  refreshZoom(): void {
    const webview = this.readyWebview();
    if (!webview) return;
    const desired = hostZoomFactor(this.rootEl.ownerDocument) * this.plugin.core.zoom.factorForUrl(this.currentUrlValue);
    if (!webview.getZoomFactor || Math.abs(webview.getZoomFactor() - desired) > .001) webview.setZoomFactor?.(desired);
  }

  inspectPage(): void {
    this.readyWebview()?.openDevTools?.();
  }

  executeWebEdit(command: WebEditCommand): void {
    this.readyWebview()?.[command]?.();
  }

  copyWebImageAt(x: number, y: number): void {
    this.readyWebview()?.copyImageAt?.(x, y);
  }

  downloadWebResource(url: string): void {
    this.readyWebview()?.downloadURL?.(url);
  }

  refreshBookmarks(): void {
    this.renderFavoritesBar();
    this.updateBookmarkButton();
    if (this.internalSurface === "bookmarks") this.showInternal("bookmarks", false);
  }

  showHistoryQuery(query: string): void {
    this.showInternal("history");
    window.requestAnimationFrame(() => {
      if (!this.historySearchEl) return;
      this.historySearchEl.value = query;
      this.historySearchEl.dispatchEvent(new Event("input"));
      this.historySearchEl.focus();
    });
  }

  openBookmarkSet(bookmarks: BookmarkEntry[], containerId?: ContainerId, useCurrent = false): void {
    if (!bookmarks.length) return;
    let start = 0;
    if (useCurrent) {
      const first = bookmarks[0];
      if (first) {
        if (containerId && containerId !== this.containerId) {
          void this.plugin.openBrowser({ url: resolveBookmarkUrl(first.url, this.plugin.app), containerId });
        }
        else this.navigate(resolveBookmarkUrl(first.url, this.plugin.app));
        start = 1;
      }
    }
    for (let index = start; index < bookmarks.length; index++) {
      const bookmark = bookmarks[index];
      if (bookmark) void this.plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, this.plugin.app), containerId });
    }
  }

  bookmarkAllOpenTabs(): void {
    const views = this.plugin.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) =>
      leaf.view instanceof BrowserView ? [leaf.view] : [],
    );
    const webViews = views.filter((view) => !view.currentUrl().startsWith("browser://"));
    if (!webViews.length) {
      new Notice(t("There are no web pages to bookmark."));
      return;
    }
    const newViews = webViews.filter((view) => !this.plugin.core.bookmarks.isBookmarked(view.currentUrl()));
    if (!newViews.length) {
      new Notice(t("All open web pages are already bookmarked."));
      return;
    }
    const folder = this.plugin.core.bookmarks.addFolder(
      "Open tabs " + new Date().toLocaleString([], { dateStyle: "short", timeStyle: "short" }),
    );
    for (const view of newViews) {
      this.plugin.core.bookmarks.addBookmark({
        title: view.getDisplayText(),
        url: view.currentUrl(),
        parentId: folder.id,
      });
    }
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    new Notice("Bookmarked " + newViews.length + " open browser tab(s)." + (newViews.length < webViews.length ? " Existing bookmarks were skipped." : ""));
  }

  currentPageBookmarked(): boolean {
    return !this.currentUrlValue.startsWith("browser://") && this.plugin.core.bookmarks.isBookmarked(this.currentUrlValue);
  }

  focusAddressBar(): void {
    this.addressEl?.focus();
    this.addressEl?.select();
  }

  focusHistorySearch(): void {
    if (this.internalSurface !== "history") this.showInternal("history");
    window.requestAnimationFrame(() => {
      this.historySearchEl?.focus();
      this.historySearchEl?.select();
    });
  }

  focusHomeSearch(): void {
    if (this.internalSurface !== "home") return;
    window.requestAnimationFrame(() => {
      this.internalLayerEl.querySelector<HTMLInputElement>(".ubc-home-search")?.focus();
    });
  }

  openContainerPicker(): void {
    if (!this.containerButtonEl || this.plugin.core.settings().containerMode === "off") return;
    const rect = this.containerButtonEl.getBoundingClientRect();
    this.showContainerMenuAt({ x: rect.left, y: rect.bottom });
  }

  lifecycleIdentity(): string {
    return this.lifecycleId;
  }

  currentInternalSurface(): BrowserLeafViewState["internalSurface"] | null {
    return this.internalSurface;
  }

  applyTabStyle(): void {
    const enabled = this.plugin.core.settings().tabStripIntegrationEnabled;
    const containerColor = this.plugin.core.settings().containerMode === "off"
      ? undefined
      : this.plugin.core.containers.get(this.containerId).color;
    this.plugin.tabStripAdapter.applyLeafStyle(
      this.leaf,
      resolveTabLayoutPolicy(this.plugin.core.settings().tabStyle),
      enabled,
      this.pinned,
      containerColor,
    );
    if (enabled) this.plugin.tabStripAdapter.applyLeafFavicon(this.leaf, this.faviconDataUrl);
  }

  applyAccessibility(): void {
    this.rootEl?.toggleClass("ubc-reduced-motion", this.plugin.core.settings().reducedMotion);
  }

  hasRecoverableFormValues(): boolean {
    return this.plugin.core.formRecovery.hasForDocument(this.containerId, this.currentUrlValue);
  }

  formRecoveryEnabledForSite(): boolean {
    return this.plugin.core.settings().formRecoveryEnabled &&
      this.plugin.core.formRecovery.isEnabledForUrl(this.containerId, this.currentUrlValue);
  }

  formRecoveryMasterEnabled(): boolean {
    return this.plugin.core.settings().formRecoveryEnabled;
  }

  refreshContainerPresentation(): void {
    this.updateContainerIndicator();
    this.applyTabStyle();
  }

  enableFormRecoveryForSite(): void {
    if (!this.plugin.core.formRecovery.enableSite(this.containerId, this.currentUrlValue)) {
      new Notice(t("Form recovery is only available for web pages."));
      return;
    }
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new Notice(t("Form recovery enabled for this site."));
  }

  showRecoveryCandidates(): void {
    const fields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    if (!fields.length) {
      new Notice(t("No saved form values are available for this page."));
      return;
    }
    showFormRecoveryCandidates(
      this.plugin.app,
      fields,
      () => void this.restoreFormValues({ watchNextSteps: true }),
    );
  }

  disableFormRecoveryForSite(): void {
    if (!this.plugin.core.formRecovery.disableSite(this.containerId, this.currentUrlValue, true)) {
      new Notice(t("Form recovery is only available for web pages."));
      return;
    }
    this.formRecoveryWatchEnabled = false;
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new Notice(t("Form recovery disabled and stored form values cleared for this site."));
  }

  async syncFormRecoveryInstrumentation(): Promise<void> {
    const webview = this.readyWebview();
    if (!webview) return;
    if (this.formRecoveryEnabledForSite()) {
      await this.installFormRecoveryInstrumentation(webview);
      return;
    }
    await this.teardownFormRecoveryInstrumentation(webview);
  }

  async resetFormRecoveryCaptureBaseline(): Promise<void> {
    const webview = this.readyWebview();
    if (!webview?.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        const capture = window.__ubcFormRecoveryCaptureV1;
        if (!capture) return false;
        capture.fields = Object.create(null);
        capture.dirty = false;
        return true;
      })()`);
    } catch {
      // Clearing recovery data must not disturb browsing if the guest is navigating.
    }
  }

  async disableFocusedFormRecoveryField(): Promise<void> {
    const field = await this.focusedFormField();
    if (!field || !this.plugin.core.formRecovery.excludeField(this.containerId, this.currentUrlValue, field)) {
      new Notice(t("Could not identify the focused form field."));
      return;
    }
    this.plugin.core.scheduleSave();
    new Notice(t("This form field is excluded from recovery on this site."));
  }

  async restoreFocusedFormValue(): Promise<void> {
    const saved = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!saved.length || !webview?.executeJavaScript) {
      new Notice(t("No saved form value is available for this page."));
      return;
    }
    const payload = JSON.stringify(saved);
    const restored = await webview.executeJavaScript<boolean>(`(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
      const saved = ${payload};
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
      const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
      const nearby = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
      let best = null;
      let bestScore = 0;
      for (const old of saved) {
        let score = old.type === type ? 1 : 0;
        if (old.id && el.id === old.id) score += 8;
        if (old.name && el.getAttribute('name') === old.name) score += 6;
        if (old.autocomplete && el.getAttribute('autocomplete') === old.autocomplete) score += 5;
        if (old.ariaLabel && el.getAttribute('aria-label') === old.ariaLabel) score += 5;
        if (old.label && old.label === label) score += 5;
        if (old.placeholder && el.getAttribute('placeholder') === old.placeholder) score += 3;
        if (old.nearbyText && old.nearbyText === nearby) score += 3;
        if (score > bestScore) { best = old; bestScore = score; }
      }
      if (!best || bestScore < 6) return false;
      if (type === 'checkbox' || type === 'radio') el.checked = Boolean(best.checked);
      else if (el instanceof HTMLSelectElement && Array.isArray(best.values)) {
        for (const option of el.options) option.selected = best.values.includes(option.value);
      } else if (typeof best.value === 'string') {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, best.value);
        else el.value = best.value;
      } else return false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    new Notice(restored ? t("Restored the previous value for this field.") : t("No matching saved value was found for this field."));
  }

  async restoreFormValues(options: { silent?: boolean; watchNextSteps?: boolean } = {}): Promise<void> {
    const recoveryFields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!recoveryFields.length || !webview?.executeJavaScript) {
      if (!options.silent) new Notice(t("No saved form values for this page."));
      return;
    }
    const watchNextSteps = options.watchNextSteps ?? true;
    if (watchNextSteps) this.formRecoveryWatchEnabled = true;
    const payload = JSON.stringify(recoveryFields);
    const restored = await webview.executeJavaScript<number>(`(() => {
      const saved = ${payload};
      const stateKey = '__ubcFormRecoveryAssistV1';
      const state = window[stateKey] || (window[stateKey] = { touched: new WeakSet(), observer: null, scheduled: false, listening: false, markTouched: null });
      const labelOf = (el) => (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
      const nearbyOf = (el) => {
        const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
        return (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
      };
      const setNativeValue = (el, value) => {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      };
      if (!state.listening) {
        state.markTouched = (event) => {
          if (event.isTrusted && event.target instanceof Element) state.touched.add(event.target);
        };
        document.addEventListener('input', state.markTouched, true);
        document.addEventListener('change', state.markTouched, true);
        state.listening = true;
      }
      const apply = (conservative) => {
        const fields = Array.from(document.querySelectorAll('input, textarea, select'));
        let count = 0;
        for (const old of saved) {
          let best = null;
          let bestScore = 0;
          for (const el of fields) {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          let score = 0;
          if (old.id && el.id === old.id) score += 8;
          if (old.name && el.getAttribute('name') === old.name) score += 6;
          if (old.autocomplete && el.getAttribute('autocomplete') === old.autocomplete) score += 5;
          if (old.ariaLabel && el.getAttribute('aria-label') === old.ariaLabel) score += 5;
          if (old.label && labelOf(el) === old.label) score += 5;
          if (old.placeholder && el.getAttribute('placeholder') === old.placeholder) score += 3;
          if (old.nearbyText && nearbyOf(el) === old.nearbyText) score += 3;
          if (old.value && typeof el.value === 'string' && el.value === old.value) score += 4;
          if (old.type === type) score += 1;
          if (score > bestScore) { bestScore = score; best = el; }
          }
          if (!best || bestScore < 6 || (conservative && state.touched.has(best))) continue;
          const type = (best.getAttribute('type') || best.tagName).toLowerCase();
          if (conservative && type !== 'checkbox' && type !== 'radio' && best.tagName !== 'SELECT' && best.value) continue;
          if (type === 'checkbox' || type === 'radio') {
            best.checked = Boolean(old.checked);
          } else if (best.tagName === 'SELECT' && Array.isArray(old.values)) {
            for (const option of best.options) option.selected = old.values.includes(option.value);
          } else if (typeof old.value === 'string') {
            setNativeValue(best, old.value);
          }
          best.dispatchEvent(new Event('input', { bubbles: true }));
          best.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        return count;
      };
      const initialCount = apply(false);
      if (${watchNextSteps ? "true" : "false"} && !state.observer) {
        state.observer = new MutationObserver(() => {
          if (state.scheduled) return;
          state.scheduled = true;
          requestAnimationFrame(() => {
            state.scheduled = false;
            apply(true);
          });
        });
        state.observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      return initialCount;
    })()`);
    if (!options.silent) {
      new Notice(
        restored > 0
          ? t("Restored {v0} form field(s).{v1}", { v0: restored, v1: watchNextSteps ? " Matching fields in later form steps will also be restored when they appear." : "" })
          : t("No matching fields were found for the saved form values."),
      );
    }
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    trackDismissibleMenu(menu, this.rootEl?.ownerDocument ?? document);
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Home")).setIcon("home").onClick(() => this.showInternal("home")));
    menu.addItem((item) => item.setTitle(t("History")).setIcon("history").onClick(() => this.showInternal("history")));
    menu.addItem((item) => item.setTitle(t("Bookmarks")).setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
    const closed = this.plugin.core.history.recentlyClosed(1)[0];
    menu.addItem((item) => item.setTitle(t("Reopen closed tab")).setIcon("rotate-ccw").setDisabled(!closed)
      .onClick(() => { if (closed) void this.plugin.restoreLeaf(closed.id); }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Site permissions…")).setIcon("shield-check")
      .onClick((event) => this.showPermissionMenu(event)));
    menu.addItem((item) => item.setTitle(t("Zoom in")).setIcon("zoom-in").onClick(() => this.zoomIn()));
    menu.addItem((item) => item.setTitle(t("Zoom out")).setIcon("zoom-out").onClick(() => this.zoomOut()));
    menu.addItem((item) => item.setTitle(t("Reset site zoom")).onClick(() => this.resetZoom()));
    menu.addItem((item) => item.setTitle(t("Settings")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    menu.addItem((item) => item.setTitle(t("Inspect page")).setIcon("code").onClick(() => this.inspectPage()));
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("Reload"))
        .setIcon("rotate-cw")
        .onClick(() => this.reload()),
    );

    const pinned = this.pinned;
    menu.addItem((item) =>
      item
        .setTitle(pinned ? t("Unpin browser tab") : t("Pin browser tab"))
        .setIcon("pin")
        .onClick(() => {
          this.leaf.setPinned(!pinned);
          this.plugin.core.history.touchLeaf(this.leafId(), { pinned: !pinned });
          this.plugin.core.scheduleSave();
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle(this.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data"))
        .setIcon("archive-restore")
        .onClick(() => {
          this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
          this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
          this.plugin.core.scheduleSave();
          this.plugin.scheduleSessionCheckpoint();
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle(t("Duplicate browser tab"))
        .setIcon("copy")
        .onClick(() => this.plugin.openBrowser({ url: this.currentUrlValue, containerId: this.containerId })),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Move browser tab to new window"))
        .setIcon("picture-in-picture")
        .onClick(() => {
          try {
            this.plugin.app.workspace.moveLeafToPopout(this.leaf);
          } catch {
            new Notice(t("This Obsidian build cannot move the tab to a new window."));
          }
        }),
    );

    for (const container of this.plugin.core.containers.list()) {
      if (container.id === this.containerId) continue;
      menu.addItem((item) =>
        item
          .setTitle(t("Reopen in {v0}", { v0: container.name }))
          .setIcon("box")
          .onClick(() => this.reopenInContainer(container.id)),
      );
    }

    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem((item) =>
        item
          .setTitle(t("Bookmark current page"))
          .setIcon("bookmark")
          .onClick(() => this.bookmarkCurrentPage()),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("Copy page URL"))
          .setIcon("copy")
          .onClick(() => void navigator.clipboard.writeText(this.currentUrlValue)),
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("Search browser tabs"))
        .setIcon("search")
        .onClick(() => this.plugin.openBrowserTabSearch()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Open Quick Switcher"))
        .setIcon("file-search-2")
        .onClick(() => this.plugin.openQuickSwitcher()),
    );
    menu.addSeparator();
    const siblings = this.plugin.tabStripAdapter
      .leavesInSameGroup(this.leaf)
      .filter((leaf) => leaf.view instanceof BrowserView);
    const selfIndex = siblings.indexOf(this.leaf);
    menu.addItem((item) =>
      item
        .setTitle(t("Close browser tabs to the left"))
        .setIcon("panel-left-close")
        .setDisabled(selfIndex <= 0)
        .onClick(() => {
          for (const leaf of siblings.slice(0, selfIndex)) leaf.detach();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Close browser tabs to the right"))
        .setIcon("panel-right-close")
        .setDisabled(selfIndex < 0 || selfIndex >= siblings.length - 1)
        .onClick(() => {
          for (const leaf of siblings.slice(selfIndex + 1)) leaf.detach();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Close other browser tabs"))
        .setIcon("x")
        .onClick(() => {
          for (const leaf of siblings) if (leaf !== this.leaf) leaf.detach();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Close unpinned browser tabs"))
        .setIcon("x-circle")
        .onClick(() => {
          for (const leaf of siblings) {
            if (leaf.view instanceof BrowserView && !leaf.view.getState().pinned) leaf.detach();
          }
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Close browser tab"))
        .setIcon("x")
        .onClick(() => this.leaf.detach()),
    );
  }

  private buildChrome(): void {
    // Match Surfing's strongest piece of browser chrome integration: use
    // Obsidian's existing view header instead of stacking a second toolbar
    // underneath it. BrowserTab ≈ WorkspaceLeaf should also look that way.
    const privateTitleContainer = (this as unknown as { titleContainerEl?: HTMLElement }).titleContainerEl;
    this.browserHeaderTitleEl = privateTitleContainer
      ?? this.containerEl.querySelector<HTMLElement>(".view-header-title-container");
    this.browserHeaderEl = this.browserHeaderTitleEl?.parentElement ?? null;
    const toolbarHost = this.browserHeaderTitleEl ?? this.rootEl;
    if (this.browserHeaderTitleEl) {
      this.browserHeaderTitleEl.empty();
      this.browserHeaderTitleEl.addClass("ubc-browser-title-container");
      this.browserHeaderEl?.addClass("ubc-browser-view-header");
    }
    this.toolbarEl = toolbarHost.createDiv({ cls: "ubc-toolbar" });
    this.backButtonEl = this.addToolbarButton("arrow-left", t("Back"), () => this.goBack());
    this.backButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(-1, event);
    });
    this.forwardButtonEl = this.addToolbarButton("arrow-right", t("Forward"), () => this.goForward());
    this.forwardButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(1, event);
    });
    this.reloadButtonEl = this.addToolbarButton("rotate-cw", t("Reload"), () => {
      if (this.rootEl.hasClass("ubc-is-loading")) this.stopLoading();
      else this.reload();
    });
    this.reloadButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(t("Reload")).setIcon("rotate-cw").onClick(() => this.reload()));
      menu.addItem((item) => item.setTitle(t("Hard reload")).onClick(() => this.hardReload()));
      menu.addItem((item) => item.setTitle(t("Stop loading")).onClick(() => this.stopLoading()));
      showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    });

    this.addressEl = this.toolbarEl.createEl("input", {
      cls: "ubc-address",
      attr: { type: "text", spellcheck: "false", "aria-label": t("Address and search") },
    });
    this.register(bindAddressSuggestions(this.addressEl, this.plugin.core, (value) => this.navigate(value)));
    this.addressEl.addEventListener("keydown", (event) => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      this.navigate(this.normalizeAddress(this.addressEl.value));
    });
    this.addressEl.addEventListener("focus", () => this.addressEl.select());
    this.addressEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showAddressMenu(event);
    });
    this.statusEl = this.toolbarEl.createSpan({
      cls: "ubc-navigation-status",
      text: t("Ready"),
      attr: { "aria-live": "polite", "aria-atomic": "true", title: t("Navigation status") },
    });

    this.bookmarkButtonEl = this.addToolbarButton("bookmark", t("Bookmark page"), () => this.bookmarkCurrentPage());

    this.containerButtonEl = this.addToolbarButton("box", t("Container"), (event) => this.showContainerMenu(event));
    this.containerButtonEl.addClass("ubc-container-button");
    this.updateContainerIndicator();

    this.favoritesBarEl = this.rootEl.createDiv({ cls: "ubc-favorites-bar" });
    this.favoritesBarEl.addEventListener("contextmenu", (event) => {
      if (event.target !== this.favoritesBarEl) return;
      event.preventDefault();
      showFavoritesBarMenu(this.plugin, this, event);
    });
    this.recoveryBannerEl = this.rootEl.createDiv({ cls: "ubc-recovery-banner is-hidden", attr: { role: "status" } });
    this.browserContentEl = this.rootEl.createDiv({ cls: "ubc-content" });
    this.browserContentEl.appendChild(this.recoveryBannerEl);
    for (const event of ["pointerdown", "wheel", "keydown"]) {
      this.browserContentEl.addEventListener(event, (input) => {
        if (!this.recoveryBannerEl.contains(input.target as Node)) this.hideRecoveryBanner();
      }, { capture: true, passive: true });
    }
    this.webLayerEl = this.browserContentEl.createDiv({ cls: "ubc-web-layer is-hidden" });
    this.loadingShieldEl = this.webLayerEl.createDiv({
      cls: "ubc-loading-shield is-hidden",
      attr: { "aria-hidden": "true" },
    });
    this.internalLayerEl = this.browserContentEl.createDiv({ cls: "ubc-internal-layer is-hidden" });
    this.browserContentEl.addEventListener("contextmenu", (event) => {
      if (this.internalSurface) return;
      if (this.webview && event.composedPath().includes(this.webview)) return;
      event.preventDefault();
      showPageMenu(this.plugin, this, event);
    });
    this.renderFavoritesBar();
    this.updateBookmarkButton();
    this.refreshNavigationButtons();
  }

  private addToolbarButton(icon: string, label: string, callback: (event: MouseEvent) => void): HTMLButtonElement {
    const button = this.toolbarEl.createEl("button", {
      cls: "ubc-toolbar-button clickable-icon",
      attr: { "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", callback);
    return button;
  }

  private applyZoom(factor: number): void {
    this.readyWebview()?.setZoomFactor?.(hostZoomFactor(this.rootEl.ownerDocument) * factor);
    this.plugin.core.scheduleSave();
    this.setNavigationStatus("loaded", `Zoom ${Math.round(factor * 100)}%`);
  }

  private setNavigationStatus(status: NavigationStatus, detail?: string): void {
    const label = detail ?? ({
      idle: "Ready",
      waiting: "Waiting…",
      loading: "Loading…",
      loaded: "Loaded",
      failed: "Load failed",
      offline: "Offline",
      stopped: "Stopped",
      restored: "Restored",
    } satisfies Record<NavigationStatus, string>)[status];
    const header = (this.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
    header?.toggleClass("ubc-browser-tab-pending", status === "waiting" || status === "loading" || status === "failed" || status === "offline" || status === "stopped");
    if (this.statusEl) {
      this.statusEl.textContent = t(label);
      this.statusEl.dataset.status = status;
      this.statusEl.title = t(label);
    }
    if (this.reloadButtonEl) {
      const loading = status === "waiting" || status === "loading";
      setIcon(this.reloadButtonEl, loading ? "x" : "rotate-cw");
      const actionLabel = t(loading ? "Stop loading" : "Reload");
      this.reloadButtonEl.setAttribute("aria-label", actionLabel);
      this.reloadButtonEl.title = actionLabel;
    }
  }

  renderFavoritesBar(): void {
    if (!this.favoritesBarEl) return;
    this.rootEl.toggleClass("ubc-native-background", !this.plugin.core.settings().initialBackgroundOverride);
    const backgroundSettings = this.plugin.core.settings();
    if (backgroundSettings.initialBackgroundOverride && backgroundSettings.initialBackgroundSource === "custom") {
      this.rootEl.style.setProperty("--ubc-initial-background", backgroundSettings.initialBackgroundColor);
    } else this.rootEl.style.removeProperty("--ubc-initial-background");
    this.updateBookmarkButton();
    this.favoritesBarEl.empty();
    const visible = this.plugin.core.settings().showFavoritesBar;
    const favorites = this.plugin.core.settings().bookmarkBarMode === "all"
      ? this.plugin.core.bookmarks.children(null)
      : this.plugin.core.bookmarks.favorites();
    this.favoritesBarEl.toggleClass("is-hidden", !visible);
    if (!visible) return;
    const library = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item ubc-bar-library", attr: { title: t("Open bookmarks"), "aria-label": t("Open bookmarks") } });
    setIcon(library, "book-open");
    library.addEventListener("click", () => this.showInternal("bookmarks"));
    if (!favorites.length && this.plugin.core.settings().bookmarkBarMode === "selected") {
      const choose = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item", text: t("Choose members") });
      choose.addEventListener("click", () => { this.bookmarkLayout = "selected"; this.showInternal("bookmarks"); });
    }
    for (const item of favorites) {
      if (item.kind === "folder") {
        const folder = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item" });
        setIcon(folder.createSpan(), "folder");
        folder.createSpan({ text: item.title });
        folder.addEventListener("click", () => {
          const menu = new Menu();
          const append = (parentId: string, target: Menu) => {
            for (const child of this.plugin.core.bookmarks.children(parentId)) {
              target.addItem((entry) => {
                entry.setTitle(child.title).setIcon(child.kind === "folder" ? "folder" : "bookmark");
                if (child.kind === "folder") {
                  const item = entry as unknown as { setSubmenu?: () => Menu };
                  if (item.setSubmenu) append(child.id, item.setSubmenu());
                  else entry.onClick(() => { this.bookmarkLayout = "folder"; this.showInternal("bookmarks"); });
                } else entry.onClick(() => this.navigate(resolveBookmarkUrl(child.url, this.plugin.app)));
              });
            }
          };
          append(item.id, menu);
          const rect = folder.getBoundingClientRect();
          this.openContainerMenu(menu, { x: rect.left, y: rect.bottom });
        });
        folder.addEventListener("contextmenu", (event) => { event.preventDefault(); showBookmarkFolderMenu(this.plugin, this, item, event); });
        continue;
      }
      const bookmark = this.favoritesBarEl.createEl("button", {
        cls: "ubc-favorite-item",
        attr: { title: `${item.title || item.url}\n${item.url}` },
      });
      renderBookmarkVisual(bookmark, item, "ubc-favorite-visual", this.plugin.app);
      bookmark.createSpan({ cls: "ubc-favorite-title", text: item.title || item.url });
      bookmark.addEventListener("click", (event) => this.openWebTargetFromPointer(item.url, event));
      bookmark.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        this.openWebTargetFromPointer(item.url, event);
      });
      bookmark.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showBookmarkMenu(this.plugin, this, item, event);
      });
    }
  }

  navigate(rawUrl: string): void {
    this.bookmarkPopoverClose?.();
    this.discardPendingRestore();
    const url = this.normalizeAddress(rawUrl);
    if (url.startsWith("browser://")) {
      this.showInternal((url.slice("browser://".length) || "home") as BrowserLeafViewState["internalSurface"]);
      return;
    }

    const origin = webOrigin(url);
    const bypassAssignment = Boolean(origin && origin === this.siteAssignmentBypassOrigin);
    const assignedContainer = bypassAssignment
      ? this.containerId
      : this.plugin.core.resolveContainerForNavigation(url, this.containerId);
    if (assignedContainer !== this.containerId) {
      void this.replaceCurrentTab({ url, containerId: assignedContainer });
      return;
    }
    if (!bypassAssignment) {
      this.siteAssignmentBypassOrigin = undefined;
      this.siteAssignmentBypassReason = undefined;
    }

    this.internalSurface = null;
    this.setNavigationStatus("waiting");
    this.showLoadingShield();
    this.currentUrlValue = url;
    this.addressEl.value = url;
    this.internalLayerEl.addClass("is-hidden");
    this.webLayerEl.removeClass("is-hidden");
    this.ensureWebview(url);
  }

  showInternal(
    surface: BrowserLeafViewState["internalSurface"] = "home",
    recordTransient = true,
    discardRestore = true,
  ): void {
    if (discardRestore) this.discardPendingRestore();
    const resolvedSurface = surface ?? "home";
    this.disconnectHistoryObserver();
    this.internalSurface = resolvedSurface;
    this.siteAssignmentBypassOrigin = undefined;
    this.siteAssignmentBypassReason = undefined;
    this.faviconDataUrl = undefined;
    this.faviconSourceUrl = undefined;
    this.currentUrlValue = `browser://${resolvedSurface}`;
    this.addressEl.value = this.currentUrlValue;
    this.updateBookmarkButton();
    this.webLayerEl.addClass("is-hidden");
    this.hideLoadingShield();
    this.internalLayerEl.removeClass("is-hidden");
    this.internalLayerEl.empty();
    if (resolvedSurface === "history") this.renderHistory();
    else if (resolvedSurface === "bookmarks") this.renderBookmarks();
    else this.renderHome();
    this.currentTitle = t(resolvedSurface === "history" ? "History" : resolvedSurface === "bookmarks" ? "Bookmarks" : "Home");
    this.plugin.core.history.touchLeaf(this.leafId(), {
      lastUrl: this.currentUrlValue,
      lastTitle: this.currentTitle,
    });
    this.plugin.core.scheduleSave();
    if (recordTransient) {
      this.pushTransient({ kind: "internal", url: this.currentUrlValue, surface: resolvedSurface });
    }
    this.refreshNavigationButtons();
    this.refreshLeafHeader();
    this.plugin.scheduleSessionCheckpoint();
  }

  goBack(): void {
    if (this.traverseTransient(-1)) return;
    const webview = this.readyWebview();
    if (!webview || !this.safeCanGoBack(webview)) return;
    this.pendingHistoryIntent = "back";
    webview.goBack?.();
  }

  goForward(): void {
    if (this.traverseTransient(1)) return;
    const webview = this.readyWebview();
    if (!webview || !this.safeCanGoForward(webview)) return;
    this.pendingHistoryIntent = "forward";
    webview.goForward?.();
  }

  canGoBack(): boolean {
    const webview = this.readyWebview();
    return this.transientIndex > 0 || Boolean(webview && this.safeCanGoBack(webview));
  }

  canGoForward(): boolean {
    const webview = this.readyWebview();
    return (
      (this.transientIndex >= 0 && this.transientIndex < this.transientHistory.length - 1)
      || Boolean(webview && this.safeCanGoForward(webview))
    );
  }

  reload(): void {
    const webview = this.readyWebview();
    if (!webview) return;
    this.plugin.core.history.addResidual({
      leafId: this.leafId(),
      residualKind: "reload",
      fromUrl: this.currentUrlValue,
      toUrl: this.currentUrlValue,
    });
    this.plugin.core.scheduleSave();
    webview.reload();
  }

  hardReload(): void {
    const webview = this.readyWebview();
    if (!webview) return;
    this.plugin.core.history.addResidual({
      leafId: this.leafId(),
      residualKind: "reload",
      fromUrl: this.currentUrlValue,
      toUrl: this.currentUrlValue,
      detail: "hard-reload",
    });
    this.plugin.core.scheduleSave();
    if (webview.reloadIgnoringCache) webview.reloadIgnoringCache();
    else webview.reload();
  }

  stopLoading(): void {
    this.readyWebview()?.stop();
    this.rootEl.removeClass("ubc-is-loading");
    this.hideLoadingShield();
    this.setNavigationStatus("stopped");
  }

  bookmarkCurrentPage(): void {
    if (!this.currentUrlValue || this.currentUrlValue.startsWith("browser://")) return;
    this.bookmarkPopoverClose?.();
    const bookmark = this.plugin.core.bookmarks.addBookmark({
      title: this.currentTitle || this.currentUrlValue,
      url: this.currentUrlValue,
      faviconUrl: this.faviconSourceUrl ?? fallbackFaviconUrl(this.currentUrlValue),
    });
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    this.bookmarkPopoverClose = showBookmarkPopover(this.plugin, bookmark, this.bookmarkButtonEl, this.browserContentEl);
  }

  favoriteCurrentPage(): void {
    if (!this.currentUrlValue || this.currentUrlValue.startsWith("browser://")) return;
    const bookmark = this.plugin.core.bookmarks.addBookmark({
      title: this.currentTitle || this.currentUrlValue,
      url: this.currentUrlValue,
      favorite: true,
      faviconUrl: this.faviconSourceUrl ?? fallbackFaviconUrl(this.currentUrlValue),
    });
    this.plugin.core.bookmarks.setFavorite(bookmark.id, true);
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    new Notice(t("Added to favorites."));
  }

  private updateBookmarkButton(): void {
    if (!this.bookmarkButtonEl) return;
    const bookmark = !this.currentUrlValue.startsWith("browser://")
      ? this.plugin.core.bookmarks.findByUrl(this.currentUrlValue)
      : undefined;
    setIcon(this.bookmarkButtonEl, "star");
    const label = bookmark ? t("Edit bookmark") : t("Bookmark page");
    this.bookmarkButtonEl.setAttribute("aria-label", label);
    this.bookmarkButtonEl.title = label;
    this.bookmarkButtonEl.toggleClass("is-active", Boolean(bookmark));
  }

  reopenInContainer(containerId: ContainerId): void {
    void this.replaceCurrentTab({
      url: this.currentUrlValue,
      containerId,
    });
  }

  private async replaceCurrentTab(
    request: Omit<BrowserOpenRequest, "restoredFromLeafId">,
  ): Promise<void> {
    await this.captureRecoveryState();
    await this.plugin.openBrowser({
      ...request,
      restoredFromLeafId: this.leafId(),
    });
    this.closeReasonOverride = "replaced";
    this.leaf.detach();
  }

  private ensureWebview(url: string): void {
    if (!this.webview) {
      const webview = this.plugin.managedWebviewBackend.create(
        this.plugin.core.containers.get(this.containerId).partition,
        () => this.plugin.core.settings(),
        this.rootEl.ownerDocument,
      );
      this.webview = webview;
      this.webviewDomReady = false;
      this.bindWebview(webview);
      this.webLayerEl.appendChild(webview);

      if (this.plugin.core.settings().blockPasskeyRequests || (!this.richRestoreAttempted && this.restoredFromLeafId)) {
        // Bootstrap first so guest-scoped response policies are ready.
        // A webview without src never creates a guest, so waiting for
        // did-attach before setting the first URL deadlocks. Use about:blank
        // only to bootstrap an attached guest when rich restore needs to run
        // before the real navigation.
        this.pendingInitialWebUrl = url;
        this.ignoreBootstrapAboutBlank = true;
        webview.src = "about:blank";
      } else {
        this.pendingInitialWebUrl = undefined;
        // For normal browsing the real URL itself bootstraps the guest.
        webview.src = url;
      }
      return;
    }
    const webview = this.webview;
    if (this.readyWebview() && webview.loadURL) void webview.loadURL(url);
    else webview.src = url;
  }

  private bindWebview(webview: WebviewElement): void {
    webview.addEventListener("will-navigate", () => {
      void this.captureRecoveryState();
    });
    webview.addEventListener("did-attach", () => {
      this.bindGuestRuntime(webview, false);
      void this.initializeAttachedWebview(webview);
    });
    webview.addEventListener("did-navigate", (rawEvent: Event) => {
      const event = rawEvent as WebviewNavigateEvent;
      if (event.isMainFrame === false) return;
      const url = event.url || this.safeWebviewUrl(webview) || this.currentUrlValue;
      if (this.ignoreBootstrapAboutBlank && url === "about:blank") return;
      if (url !== "about:blank") this.ignoreBootstrapAboutBlank = false;
      if (this.clearBootstrapHistoryAfterFallback && url !== "about:blank") {
        this.navigationHistoryAdapter.clear(webview);
        this.clearBootstrapHistoryAfterFallback = false;
      }
      this.handleCommittedNavigation(url);
    });
    webview.addEventListener("did-navigate-in-page", (rawEvent: Event) => {
      const event = rawEvent as WebviewNavigateEvent;
      if (event.isMainFrame === false) return;
      const url = event.url || this.safeWebviewUrl(webview) || this.currentUrlValue;
      const previousUrl = this.currentUrlValue;
      const currentTransient = this.transientHistory[this.transientIndex];
      const previousWebIndex = currentTransient?.kind === "web" ? currentTransient.webIndex : undefined;
      this.currentUrlValue = url;
      this.addressEl.value = url;
      const reason = this.pendingHistoryIntent || "in-page";
      this.pendingHistoryIntent = null;
      const webIndex = this.navigationHistoryAdapter.activeIndex(webview);
      const classification = classifyInPageNavigation(previousWebIndex, webIndex, reason);
      if (this.pendingTransientTraversalIndex !== null) {
        const target = this.transientHistory[this.pendingTransientTraversalIndex];
        if (target?.kind === "web") {
          target.url = url;
          target.webIndex = webIndex;
        }
        this.pendingTransientTraversalIndex = null;
      } else if (classification === "navigation") {
        this.pushTransient({ kind: "web", url, webIndex });
      } else if (currentTransient?.kind === "web") {
        currentTransient.url = url;
        currentTransient.webIndex = webIndex;
      }
      if (classification === "navigation") {
        this.plugin.core.history.addNavigation({
          leafId: this.leafId(),
          containerId: this.containerId,
          url,
          title: this.currentTitle,
          reason,
          sessionEntryIndex: webIndex,
        });
      } else {
        this.plugin.core.history.addResidual({
          leafId: this.leafId(),
          residualKind: "in-page",
          fromUrl: previousUrl,
          toUrl: url,
        });
        this.plugin.core.history.updateCurrentNavigation(this.leafId(), {
          url,
          title: this.currentTitle,
          sessionEntryIndex: webIndex,
        });
      }
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      void this.captureRecoveryState();
      if (this.formRecoveryWatchEnabled && this.hasRecoverableFormValues()) {
        void this.restoreFormValues({ silent: true, watchNextSteps: true });
      }
    });
    webview.addEventListener("did-redirect-navigation", (rawEvent: Event) => {
      const event = rawEvent as WebviewNavigateEvent;
      if (!event.url) return;
      this.plugin.core.history.addResidual({
        leafId: this.leafId(),
        residualKind: "redirect",
        fromUrl: this.lastNavigatedUrl || this.currentUrlValue,
        toUrl: event.url,
      });
      this.plugin.core.scheduleSave();
    });
    webview.addEventListener("page-title-updated", (rawEvent: Event) => {
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      const event = rawEvent as WebviewTitleEvent;
      this.syncWebviewTitle(webview, event.title);
    });
    webview.addEventListener("page-favicon-updated", (rawEvent: Event) => {
      const event = rawEvent as WebviewFaviconEvent;
      this.rememberFaviconSource(event.favicons ?? []);
      void this.captureFavicon(webview, event.favicons ?? []);
    });
    webview.addEventListener("context-menu", (rawEvent: Event) => {
      if (this.contextMenuDisposer) return;
      const event = rawEvent as WebviewContextMenuEvent;
      if (!event.params) return;
      rawEvent.preventDefault();
      const rect = webview.getBoundingClientRect();
      showWebContentMenu(this.plugin, this, event.params, {
        x: rect.left + event.params.x,
        y: rect.top + event.params.y,
      });
    });
    webview.addEventListener("did-start-loading", () => {
      this.rootEl.addClass("ubc-is-loading");
      this.showLoadingShield();
      this.setNavigationStatus("loading");
    });
    webview.addEventListener("did-stop-loading", () => {
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      this.rootEl.removeClass("ubc-is-loading");
      this.hideLoadingShield();
      this.setNavigationStatus("loaded");
      this.syncWebviewTitle(webview);
    });
    webview.addEventListener("did-fail-load", (rawEvent: Event) => {
      const event = rawEvent as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (event.isMainFrame === false || event.errorCode === -3) return;
      this.rootEl.addClass("did-fail-load");
      this.hideLoadingShield();
      const offline = event.errorCode === -106 || /INTERNET_DISCONNECTED/i.test(event.errorDescription || "");
      this.setNavigationStatus(offline ? "offline" : "failed", event.errorDescription || undefined);
    });
    webview.addEventListener("dom-ready", () => {
      if (this.webview !== webview || !webview.isConnected) return;
      this.webviewDomReady = true;
      // Surfing binds guest WebContents handlers at dom-ready. The guest id
      // can exist during did-attach while remote WebContents lookup is still
      // unavailable, so retry here before deciding popup control is missing.
      this.bindGuestRuntime(webview, true);
      this.refreshNavigationButtons();
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      this.rootEl.removeClass("did-fail-load");
      // Match Surfing's proven ordering: install the guest WebContents
      // context-menu handler only after dom-ready, when host listeners have
      // already been attached. Rebinding here ensures Browser Core's native
      // menu wins the final popup layer instead of the compact host Copy menu.
      this.contextMenuDisposer?.();
      this.contextMenuDisposer = this.plugin.contextMenuAdapter.bind(
        webview,
        (params) => buildWebContentMenuEntries(this.plugin, this, params),
      );
      void this.handleDomReady();
    });
  }

  private discardPendingRestore(): void {
    this.restoreIntentGeneration += 1;
    this.restoredFromLeafId = undefined;
    this.restoreTargetUrl = undefined;
    this.restoreTargetIndex = undefined;
    this.richRestoreAttempted = true;
    this.pendingInitialWebUrl = undefined;
    this.ignoreBootstrapAboutBlank = false;
    this.clearBootstrapHistoryAfterFallback = false;
    this.hideRecoveryBanner();
  }

  private async initializeAttachedWebview(webview: WebviewElement): Promise<void> {
    const restoreGeneration = this.restoreIntentGeneration;
    const fallbackUrl = this.pendingInitialWebUrl;
    this.pendingInitialWebUrl = undefined;
    if (!this.richRestoreAttempted && this.restoredFromLeafId) {
      this.richRestoreAttempted = true;
      const capsule = this.plugin.core.restore.get(this.restoredFromLeafId);
      const targetIndex =
        this.restoreTargetUrl && typeof this.restoreTargetIndex === "number"
          ? (
            capsule &&
            this.navigationHistoryAdapter.entryMatches(
              capsule,
              this.restoreTargetIndex,
              this.restoreTargetUrl,
            )
              ? this.restoreTargetIndex
              : undefined
          )
          : capsule?.index;
      const targetIsRestorable =
        !this.restoreTargetUrl || typeof targetIndex === "number";
      const restored = Boolean(
        capsule &&
        targetIsRestorable &&
        typeof targetIndex === "number" &&
        await this.navigationHistoryAdapter.restore(webview, capsule, targetIndex)
      );
      if (restoreGeneration !== this.restoreIntentGeneration) {
        // A user navigation won while session recovery was awaiting Electron.
        // Reassert that requested URL after the stale history restore settles.
        const currentUrl = this.currentUrlValue;
        if (!currentUrl.startsWith("browser://")) {
          if (this.isReadyWebview(webview) && webview.loadURL) void webview.loadURL(currentUrl);
          else webview.src = currentUrl;
        }
        return;
      }
      if (
        capsule &&
        targetIsRestorable &&
        typeof targetIndex === "number" &&
        restored
      ) {
        if (this.transientHistory.length === 0) {
          this.transientHistory = capsule.entries.map((entry, index) => ({
            kind: "web" as const,
            url: typeof entry.url === "string" ? entry.url : "about:blank",
            title: typeof entry.title === "string" ? entry.title : undefined,
            webIndex: index,
          }));
          this.transientIndex = Math.min(Math.max(targetIndex, 0), this.transientHistory.length - 1);
        }
        this.restoreTargetUrl = undefined;
        this.restoreTargetIndex = undefined;
        this.setNavigationStatus("restored", "Restored navigation state");
        this.showRecoveryBanner("Navigation state restored from the closed tab. Some live page state may still need to reload.", "success");
        return;
      }
      this.restoreTargetUrl = undefined;
      this.restoreTargetIndex = undefined;
      this.setNavigationStatus("waiting", "Reloading saved URL");
      if (this.ignoreBootstrapAboutBlank) this.clearBootstrapHistoryAfterFallback = true;
      this.showRecoveryBanner(
        capsule
          ? "Detailed tab recovery could not be applied. Browser Core is reopening the saved URL and can still use form recovery or the website's own saved state."
          : "Detailed tab recovery is no longer available. Browser Core is reopening the saved URL from browsing history.",
        "warning",
      );
    }

    if (!fallbackUrl) return;
    if (this.isReadyWebview(webview) && webview.loadURL) void webview.loadURL(fallbackUrl);
    else webview.src = fallbackUrl;
  }

  private bindGuestRuntime(webview: WebviewElement, finalAttempt: boolean): void {
    // Guest WebContents is not addressable when the <webview> element is first
    // created. Install input observers alongside the other guest-bound
    // adapters, after did-attach/dom-ready exposes the guest contents.
    if (!this.popupInteractionDisposer) {
      this.popupInteractionDisposer = observeGuestInteraction(webview, () => {
        this.dismissTransientPopups();
        this.bookmarkPopoverClose?.();
      });
    }
    if (!this.popupDisposer) {
      this.popupDisposer = this.plugin.windowOpenAdapter.bind(webview, (url, disposition) => {
        void this.plugin.openFromOpener(url, this.containerId, disposition);
      });
    }
    if (finalAttempt && !this.popupDisposer) {
      webview.removeAttribute("allowpopups");
    }
    this.plugin.bindPermissions(webview, this.containerId);
    this.watchRecoveryInteractions();
  }

  private syncWebviewTitle(webview: WebviewElement, eventTitle?: string): void {
    const title = eventTitle?.trim() || this.safeWebviewTitle(webview)?.trim();
    if (!title || title === "about:blank") return;
    this.currentTitle = title;
    const transient = this.transientHistory[this.transientIndex];
    if (transient?.kind === "web") transient.title = title;
    this.plugin.core.history.updateCurrentNavigation(this.leafId(), {
      title,
      url: this.currentUrlValue,
    });
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
    this.refreshLeafHeader();
  }

  private handleCommittedNavigation(url: string): void {
    const reason = this.pendingHistoryIntent || "navigate";
    this.pendingHistoryIntent = null;
    this.lastNavigatedUrl = this.currentUrlValue;
    const previousOrigin = webOrigin(this.currentUrlValue);
    this.currentUrlValue = url;
    if (previousOrigin !== webOrigin(url)) {
      this.faviconDataUrl = undefined;
      this.faviconSourceUrl = undefined;
      this.refreshLeafHeader();
    }
    const committedOrigin = webOrigin(url);
    if (this.siteAssignmentBypassReason === "opener") {
      const openerBypassOrigin = this.plugin.core.containers.openerBypassOriginForCommittedUrl(
        url,
        this.containerId,
      );
      if (openerBypassOrigin) {
        // Renderer-driven OAuth/SSO redirects stay in the opener session even
        // when the redirected hostname has another ordinary site assignment.
        this.siteAssignmentBypassOrigin = openerBypassOrigin;
      } else {
        // Once the chain lands on a site whose normal assignment matches this
        // container, no routing exception is needed anymore.
        this.siteAssignmentBypassOrigin = undefined;
        this.siteAssignmentBypassReason = undefined;
      }
    } else if (committedOrigin !== this.siteAssignmentBypassOrigin) {
      this.siteAssignmentBypassOrigin = undefined;
      this.siteAssignmentBypassReason = undefined;
    }
    this.addressEl.value = url;
    this.updateBookmarkButton();
    const webIndex = this.webview ? this.navigationHistoryAdapter.activeIndex(this.webview) : undefined;
    if (this.pendingTransientTraversalIndex !== null) {
      const target = this.transientHistory[this.pendingTransientTraversalIndex];
      if (target?.kind === "web") {
        target.url = url;
        target.webIndex = webIndex;
      }
      this.pendingTransientTraversalIndex = null;
    } else {
      this.pushTransient({ kind: "web", url, webIndex, title: this.currentTitle });
    }
    this.plugin.core.history.addNavigation({
      leafId: this.leafId(),
      containerId: this.containerId,
      url,
      title: this.currentTitle,
      reason,
      sessionEntryIndex: webIndex,
    });
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
  }

  private async handleDomReady(): Promise<void> {
    const webview = this.readyWebview();
    if (!webview) return;
    this.refreshZoom();
    if (!this.faviconDataUrl) void this.captureFavicon(webview, []);
    if (this.formRecoveryEnabledForSite()) {
      await this.installFormRecoveryInstrumentation(webview);
    }

    if (this.hasRecoverableFormValues()) {
      if (this.formRecoveryWatchEnabled) {
        await this.restoreFormValues({ silent: true, watchNextSteps: true });
      } else {
        new Notice(t("Saved form values are available for this page."));
      }
    }

    if (this.checkpointTimer === undefined) {
      this.checkpointTimer = window.setInterval(() => {
        void this.captureRecoveryState();
      }, 30_000);
    }
  }

  private async captureFavicon(webview: WebviewElement, candidates: string[]): Promise<void> {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    const expectedUrl = this.safeWebviewUrl(webview) || this.currentUrlValue;
    this.rememberFaviconSource(candidates, expectedUrl);
    const supplied = JSON.stringify(candidates.slice(0, 8));
    try {
      const result = await webview.executeJavaScript<{ dataUrl: string; sourceUrl?: string } | null>(`(async () => {
        const supplied = ${supplied};
        const discovered = Array.from(
          document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
        ).map((el) => el.href).filter(Boolean);
        let fallback = null;
        try { fallback = new URL('/favicon.ico', location.href).href; } catch {}
        const urls = [...new Set([...supplied, ...discovered, ...(fallback ? [fallback] : [])])];
        const asDataUrl = (blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        for (const raw of urls) {
          try {
            const absolute = new URL(raw, location.href).href;
            if (absolute.startsWith('data:image/')) {
              if (absolute.length <= 180000) return { dataUrl: absolute };
              continue;
            }
            if (!/^https?:/i.test(absolute)) continue;
            const response = await fetch(absolute, { credentials: 'include', cache: 'force-cache' });
            if (!response.ok) continue;
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > 131072) continue;
            const encoded = await asDataUrl(blob);
            if (encoded && encoded.length <= 180000) return { dataUrl: encoded, sourceUrl: absolute };
          } catch {}
        }
        return null;
      })()`);
      if (!result?.dataUrl) return;
      const liveUrl = this.safeWebviewUrl(webview) || this.currentUrlValue;
      if (liveUrl !== expectedUrl) return;
      if (result.sourceUrl) this.rememberFaviconSource([result.sourceUrl], liveUrl);
      this.faviconDataUrl = result.dataUrl;
      this.plugin.scheduleSessionCheckpoint();
      this.refreshLeafHeader();
    } catch {
      // Favicons are a presentation enhancement; navigation must not depend on them.
    }
  }

  private rememberFaviconSource(candidates: string[], url = this.currentUrlValue): void {
    const source = candidates.find((candidate) => /^https?:/i.test(candidate)) ?? fallbackFaviconUrl(url);
    if (!source || source === this.faviconSourceUrl) return;
    this.faviconSourceUrl = source;
    const bookmark = this.plugin.core.bookmarks.findByUrl(url);
    if (!bookmark || bookmark.visualKind !== "favicon" || bookmark.faviconUrl === source) return;
    this.plugin.core.bookmarks.updateBookmark(bookmark.id, { faviconUrl: source });
    this.plugin.core.scheduleSave();
    this.renderFavoritesBar();
  }

  private showRecoveryBanner(message: string, tone: "success" | "warning"): void {
    if (!this.recoveryBannerEl) return;
    if (!this.plugin.core.settings().showRecoveryNotifications) { this.hideRecoveryBanner(); return; }
    this.recoveryBannerEl.empty();
    this.recoveryBannerEl.removeClass("is-hidden", "is-success", "is-warning");
    this.recoveryBannerEl.addClass(tone === "success" ? "is-success" : "is-warning");
    this.recoveryBannerEl.createSpan({ cls: "ubc-recovery-message", text: t(message) });
    const actions = this.recoveryBannerEl.createDiv({ cls: "ubc-recovery-actions" });

    if (tone === "warning") {
      actions.createEl("button", { text: t("Retry restore") }).addEventListener("click", () => void this.retryRichRestore());
      actions.createEl("button", { text: t("Reload normally") }).addEventListener("click", () => {
        this.hideRecoveryBanner();
        const webview = this.webview;
        if (!webview) return;
        if (this.readyWebview() && webview.loadURL) void webview.loadURL(this.currentUrlValue);
        else webview.src = this.currentUrlValue;
      });
      if (this.hasRecoverableFormValues()) {
        actions.createEl("button", { text: t("Restore form values") }).addEventListener("click", () => void this.restoreFormValues());
      }
    }
    actions.createEl("button", { text: t("Recovery details") }).addEventListener("click", () => this.openRecoveryDetails());
    const retention = actions.createEl("button", {
      text: this.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data"),
    });
    retention.addEventListener("click", () => {
      this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      const preserving = this.manualRetention === "preserve";
      retention.setText(preserving ? t("Use normal recovery retention") : t("Keep recovery data"));
      new Notice(
        preserving
          ? t("Detailed recovery data for this tab will be kept until you remove it.")
          : t("Detailed recovery data for this tab will use normal retention again."),
      );
    });
    actions.createEl("button", { text: t("Dismiss"), attr: { "aria-label": t("Dismiss recovery message") } }).addEventListener("click", () => this.hideRecoveryBanner());
    actions.createEl("button", { text: t("Never show again") }).addEventListener("click", () => {
      this.plugin.core.updateSettings({ showRecoveryNotifications: false });
      this.plugin.refreshBrowserViews();
    });
    this.watchRecoveryInteractions();
  }

  private watchRecoveryInteractions(): void {
    if (this.recoveryInteractionDisposer || !this.webview || !this.recoveryBannerEl || this.recoveryBannerEl.hasClass("is-hidden")) return;
    this.recoveryInteractionDisposer = observeGuestInteraction(this.webview, () => this.hideRecoveryBanner());
  }

  refreshRecoveryNotification(): void {
    if (!this.plugin.core.settings().showRecoveryNotifications) this.hideRecoveryBanner();
  }

  private hideRecoveryBanner(): void {
    this.recoveryBannerEl?.addClass("is-hidden");
    this.recoveryInteractionDisposer?.();
    this.recoveryInteractionDisposer = undefined;
  }

  private async retryRichRestore(): Promise<void> {
    const webview = this.readyWebview();
    if (!webview || !this.restoredFromLeafId) return;
    const capsule = this.plugin.core.restore.get(this.restoredFromLeafId);
    if (!capsule || !(await this.navigationHistoryAdapter.restore(webview, capsule))) {
      new Notice(t("Detailed tab recovery is not currently available; the page can still be reopened normally."));
      return;
    }
    this.setNavigationStatus("restored", "Restored tab state");
    this.showRecoveryBanner("Detailed tab state restored. Some page state may still depend on the website.", "success");
  }

  private openRecoveryDetails(): void {
    const sourceId = this.restoredFromLeafId;
    const capsule = sourceId ? this.plugin.core.restore.get(sourceId) : undefined;
    const sourceRecord = sourceId ? this.plugin.core.state.history.leaves[sourceId] : undefined;
    const sourceNodes = sourceId ? this.plugin.core.history.nodesForLeaf(sourceId) : [];
    showRecoveryDetails(this.plugin.app, {
      richRestoreAvailable: Boolean(capsule),
      navigationEntries: capsule?.entries.length ?? 0,
      formFields: this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue).length,
      stale: sourceNodes.some((node) => node.kind === "navigation" && node.stale) || Boolean(sourceRecord && !capsule),
      url: this.currentUrlValue,
    });
  }

  private async captureRecoveryState(): Promise<void> {
    const webview = this.readyWebview();
    if (!webview) return;
    const recoveryUrl = this.safeWebviewUrl(webview) || "";
    if (!recoveryUrl || recoveryUrl.startsWith("browser://")) return;

    const leafRecord = this.plugin.core.state.history.leaves[this.leafId()];
    if (leafRecord?.richRestoreSuppressed) {
      if (this.plugin.core.restore.get(this.leafId())) this.plugin.core.restore.remove(this.leafId());
    } else {
      const capsule = this.navigationHistoryAdapter.capture(webview, this.leafId());
      if (capsule) this.plugin.core.restore.put(capsule);
    }

    if (this.formRecoveryEnabledForSite()) {
      const fields = await this.captureFormFields(webview);
      if (fields.length) {
        this.plugin.core.formRecovery.put(this.containerId, recoveryUrl, fields, this.plugin.core.settings());
      }
    }

    this.plugin.core.sweepRestoreCapsules();
    this.plugin.core.scheduleSave();
  }

  private async captureFormFields(webview: WebviewElement): Promise<FormRecoveryField[]> {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return [];
    try {
      return await webview.executeJavaScript<FormRecoveryField[]>(`(() => {
        const captureState = window.__ubcFormRecoveryCaptureV1;
        if (captureState && captureState.dirty === false) return [];
        const sensitiveAutocomplete = /(?:password|cc-|one-time-code|webauthn)/i;
        const describe = (el) => {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          const autocomplete = el.getAttribute('autocomplete') || '';
          if (type === 'password' || type === 'file' || type === 'hidden' || sensitiveAutocomplete.test(autocomplete)) return null;
          const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
          const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
          const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
          const base = {
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            type,
            label: label || undefined,
            autocomplete: autocomplete || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            nearbyText: nearbyText || undefined,
          };
          if (type === 'checkbox' || type === 'radio') return { ...base, checked: Boolean(el.checked), value: el.value || undefined };
          if (el.tagName === 'SELECT') {
            const values = Array.from(el.selectedOptions || []).map((option) => option.value);
            return values.length ? { ...base, values } : null;
          }
          const value = typeof el.value === 'string' ? el.value : '';
          return value ? { ...base, value } : null;
        };
        const keyOf = (field) => [
          field.id || '', field.name || '', field.type || '', field.label || '',
          field.autocomplete || '', field.ariaLabel || '', field.placeholder || '',
          field.nearbyText || '', (field.type === 'radio' || field.type === 'checkbox') ? (field.value || '') : '',
        ].join('\\u001f');
        const merged = new Map();
        const buffered = captureState && captureState.fields;
        if (buffered) {
          for (const field of Object.values(buffered)) if (field) merged.set(keyOf(field), field);
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
          const field = describe(el);
          if (field) merged.set(keyOf(field), field);
        }
        const result = Array.from(merged.values());
        if (captureState) {
          captureState.fields = Object.create(null);
          captureState.dirty = false;
        }
        return result;
      })()`);
    } catch {
      return [];
    }
  }

  private async installFormRecoveryInstrumentation(webview: WebviewElement): Promise<void> {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        if (window.__ubcFormRecoveryCaptureV1) return true;
        const sensitiveAutocomplete = /(?:password|cc-|one-time-code|webauthn)/i;
        const state = { fields: Object.create(null), dirty: false, onInput: null, onChange: null };
        const describe = (el) => {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return null;
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          const autocomplete = el.getAttribute('autocomplete') || '';
          if (type === 'password' || type === 'file' || type === 'hidden' || sensitiveAutocomplete.test(autocomplete)) return null;
          const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
          const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
          const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
          const field = {
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            type,
            label: label || undefined,
            autocomplete: autocomplete || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            nearbyText: nearbyText || undefined,
          };
          if (type === 'checkbox' || type === 'radio') return { ...field, checked: Boolean(el.checked), value: el.value || undefined };
          if (el.tagName === 'SELECT') {
            const values = Array.from(el.selectedOptions || []).map((option) => option.value);
            return values.length ? { ...field, values } : null;
          }
          const value = typeof el.value === 'string' ? el.value : '';
          return value ? { ...field, value } : null;
        };
        const keyOf = (field) => [
          field.id || '', field.name || '', field.type || '', field.label || '',
          field.autocomplete || '', field.ariaLabel || '', field.placeholder || '',
          field.nearbyText || '', (field.type === 'radio' || field.type === 'checkbox') ? (field.value || '') : '',
        ].join('\\u001f');
        const capture = (target) => {
          const field = describe(target);
          if (field) {
            state.fields[keyOf(field)] = field;
            state.dirty = true;
          }
        };
        state.onInput = (event) => capture(event.target);
        state.onChange = (event) => capture(event.target);
        document.addEventListener('input', state.onInput, true);
        document.addEventListener('change', state.onChange, true);
        for (const el of document.querySelectorAll('input, textarea, select')) capture(el);
        window.__ubcFormRecoveryCaptureV1 = state;
        return true;
      })()`);
    } catch {
      // Recovery instrumentation is best-effort and must never block normal browsing.
    }
  }

  private async teardownFormRecoveryInstrumentation(webview: WebviewElement): Promise<void> {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        const capture = window.__ubcFormRecoveryCaptureV1;
        if (capture) {
          if (capture.onInput) document.removeEventListener('input', capture.onInput, true);
          if (capture.onChange) document.removeEventListener('change', capture.onChange, true);
          delete window.__ubcFormRecoveryCaptureV1;
        }
        const assist = window.__ubcFormRecoveryAssistV1;
        if (assist) {
          if (assist.observer) assist.observer.disconnect();
          if (assist.markTouched) {
            document.removeEventListener('input', assist.markTouched, true);
            document.removeEventListener('change', assist.markTouched, true);
          }
          delete window.__ubcFormRecoveryAssistV1;
        }
        return true;
      })()`);
    } catch {
      // The guest may be navigating or already destroyed.
    }
  }

  private async focusedFormField(): Promise<FormRecoveryField | undefined> {
    const webview = this.readyWebview();
    if (!webview?.executeJavaScript) return undefined;
    try {
      const field = await webview.executeJavaScript<FormRecoveryField | null>(`(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return null;
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        const autocomplete = el.getAttribute('autocomplete') || '';
        if (type === 'password' || type === 'file' || type === 'hidden' || /(?:password|cc-|one-time-code|webauthn)/i.test(autocomplete)) return null;
        const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
        const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
        const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
        return {
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
          type,
          label: label || undefined,
          autocomplete: autocomplete || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          nearbyText: nearbyText || undefined,
          value: type === 'checkbox' || type === 'radio' ? (el.value || undefined) : undefined,
        };
      })()`);
      return field ?? undefined;
    } catch {
      return undefined;
    }
  }

  private destroyWebview(): void {
    this.bookmarkPopoverClose?.();
    this.hideRecoveryBanner();
    if (this.checkpointTimer !== undefined) {
      window.clearInterval(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    if (!this.webview) return;
    this.webviewDomReady = false;
    this.popupInteractionDisposer?.();
    this.popupInteractionDisposer = undefined;
    this.popupDisposer?.();
    this.popupDisposer = undefined;
    this.contextMenuDisposer?.();
    this.contextMenuDisposer = undefined;
    this.plugin.managedWebviewBackend.destroy(this.webview);
    this.webview = null;
    this.hideLoadingShield();
  }

  private dismissTransientPopups(): void {
    const doc = this.containerEl.ownerDocument;
    dismissOpenMenus(doc);
    this.activeContainerMenu?.hide();
  }

  private showLoadingShield(): void {
    if (!this.plugin.core.settings().fullPageLoadingShield) return;
    // Loading can restart for background work such as link prefetch. Once a
    // guest page is visible, covering it would flash the theme background.
    if (this.webviewDomReady) return;
    this.loadingShieldEl?.removeClass("is-hidden");
  }

  refreshLanguage(): void {
    this.backButtonEl.title = t("Back"); this.backButtonEl.setAttribute("aria-label", t("Back"));
    this.forwardButtonEl.title = t("Forward"); this.forwardButtonEl.setAttribute("aria-label", t("Forward"));
    this.renderFavoritesBar(); this.refreshNavigationButtons();
    if (this.internalSurface) this.showInternal(this.internalSurface, false);
  }

  private hideLoadingShield(): void {
    this.loadingShieldEl?.addClass("is-hidden");
  }

  refreshLoadingShield(): void {
    if (!this.plugin.core.settings().fullPageLoadingShield) this.hideLoadingShield();
  }

  private disconnectHistoryObserver(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
  }

  private clearTabStyle(): void {
    this.plugin.tabStripAdapter.clearLeafStyle(this.leaf);
  }

  private renderHome(): void {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-home" });
    page.addEventListener("contextmenu", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("button, input, a")) return;
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(t("New browser tab")).setIcon("plus").onClick(() => void this.plugin.openBrowser()));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem((item) => item.setTitle("New tab in " + container.name).setIcon("box").onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: container.id })));
      }
      const closed = this.plugin.core.history.recentlyClosed(1)[0];
      menu.addItem((item) => item.setTitle(t("Reopen closed tab")).setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.plugin.restoreLeaf(closed.id);
      }));
      menu.addItem((item) =>
        item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => this.plugin.openBrowserTabSearch()),
      );
      menu.addItem((item) =>
        item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => this.plugin.openQuickSwitcher()),
      );
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Show history")).setIcon("history").onClick(() => this.showInternal("history")));
      menu.addItem((item) => item.setTitle(t("Show bookmarks")).setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
      showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    });
    page.createEl("h1", { text: t("Home") });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: t("Search your vault, browse the web, or continue where you left off."),
    });
    const searchMode = { value: this.plugin.core.settings().homeSearchMode };
    const modePicker = page.createDiv({ cls: "ubc-home-search-modes", attr: { role: "group", "aria-label": t("Home search mode") } });
    const vaultMode = modePicker.createEl("button", { text: t("Vault"), attr: { type: "button" } });
    const webMode = modePicker.createEl("button", { text: t("Web"), attr: { type: "button" } });
    const search = page.createEl("input", {
      cls: "ubc-home-search",
      attr: { "aria-label": t("Home search") },
    });
    const searchResults = page.createDiv({ cls: "ubc-home-search-results" });
    const homeSections = page.createDiv({ cls: "ubc-home-sections" });
    let currentVaultResults: VaultHomeFile[] = [];

    const renderVaultSearch = () => {
      searchResults.empty();
      const query = search.value.trim();
      if (!query) {
        currentVaultResults = [];
        homeSections.removeClass("is-hidden");
        return;
      }
      currentVaultResults = this.plugin.homeAdapter.searchFiles(query, 10);
      homeSections.addClass("is-hidden");
      const heading = searchResults.createDiv({ cls: "ubc-home-results-heading" });
      heading.createEl("strong", {
        text: currentVaultResults.length
          ? String(currentVaultResults.length) + " vault result" + (currentVaultResults.length === 1 ? "" : "s")
          : t("No vault files found"),
      });
      if (!currentVaultResults.length) {
        heading.createSpan({ text: t("Try another name or switch to Web."), cls: "ubc-card-subtitle" });
        return;
      }
      this.renderVaultFileCards(searchResults, currentVaultResults);
    };

    const setMode = (mode: "vault" | "web", persist = true) => {
      searchMode.value = mode;
      vaultMode.toggleClass("is-active", mode === "vault");
      webMode.toggleClass("is-active", mode === "web");
      vaultMode.setAttribute("aria-pressed", String(mode === "vault"));
      webMode.setAttribute("aria-pressed", String(mode === "web"));
      search.placeholder = mode === "vault" ? t("Search files in your vault") : t("Search the web or enter an address");
      searchResults.empty();
      homeSections.removeClass("is-hidden");
      if (persist && this.plugin.core.settings().homeSearchMode !== mode) {
        this.plugin.core.updateSettings({ homeSearchMode: mode });
      }
      if (mode === "vault") renderVaultSearch();
      search.focus();
    };

    vaultMode.addEventListener("click", () => setMode("vault"));
    webMode.addEventListener("click", () => setMode("web"));
    search.addEventListener("input", () => {
      if (searchMode.value === "vault") renderVaultSearch();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (searchMode.value === "web") {
        this.navigate(this.normalizeAddress(search.value));
        return;
      }
      const first = currentVaultResults[0];
      if (first) void this.openVaultHomeFile(first.path, event.metaKey || event.ctrlKey);
    });

    if (this.plugin.core.settings().showVaultBookmarksOnHome) {
      const bookmarked = this.plugin.homeAdapter.bookmarkedFiles(8);
      if (bookmarked.length) {
        homeSections.createEl("h2", { text: t("Bookmarked files") });
        this.renderVaultFileCards(homeSections, bookmarked);
      }
    }

    if (this.plugin.core.settings().showRecentVaultFilesOnHome) {
      const files = this.plugin.homeAdapter.recentFiles(8);
      if (files.length) {
        homeSections.createEl("h2", { text: t("Recent files") });
        this.renderVaultFileCards(homeSections, files);
      }
    }

    const webBookmarks = this.plugin.core.bookmarks.allBookmarks().slice(0, 8);
    if (webBookmarks.length) {
      homeSections.createEl("h2", { text: t("Web bookmarks") });
      const list = homeSections.createDiv({ cls: "ubc-card-list" });
      for (const bookmark of webBookmarks) {
        const button = list.createEl("button", { cls: "ubc-card", text: bookmark.title || bookmark.url });
        button.createSpan({ cls: "ubc-card-subtitle", text: bookmark.url });
        button.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          this.openWebTargetFromPointer(bookmark.url, event);
        });
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkMenu(this.plugin, this, bookmark, event);
        });
      }
    }

    const recent = this.plugin.core.history.recentlyClosed(6);
    if (recent.length) {
      homeSections.createEl("h2", { text: t("Recently closed browser tabs") });
      const list = homeSections.createDiv({ cls: "ubc-card-list" });
      for (const leaf of recent) {
        const internalLabel = internalSurfaceLabel(leaf.lastUrl);
        const displayTitle = internalLabel || leaf.lastTitle || leaf.lastUrl || "Closed tab";
        const displayLocation = internalLabel ? "Browser Core page" : (leaf.lastUrl || "");
        const button = list.createEl("button", {
          cls: "ubc-card",
          text: displayTitle,
        });
        button.createSpan({
          cls: "ubc-card-subtitle",
          text: leaf.closeReason === "view-replaced"
            ? "Switched to another view" + (displayLocation ? " · " + displayLocation : "")
            : displayLocation,
        });
        button.addEventListener("click", () => this.plugin.restoreLeaf(leaf.id));
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const menu = new Menu();
          menu.addItem((item) => item.setTitle(t("Restore")).setIcon("rotate-ccw").onClick(() => this.plugin.restoreLeaf(leaf.id)));
          for (const container of this.plugin.core.containers.list()) {
            menu.addItem((item) =>
              item
                .setTitle("Restore in " + container.name)
                .setIcon("box")
                .onClick(() => this.plugin.restoreLeaf(leaf.id, { containerId: container.id })),
            );
          }
          if (leaf.lastUrl && !leaf.lastUrl.startsWith("browser://")) {
            menu.addItem((item) => item.setTitle(t("Open history")).setIcon("history").onClick(() => this.showHistoryQuery(leaf.lastUrl || "")));
          }
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(t("Remove from history")).setIcon("trash").onClick(() => {
            void (async () => {
              const confirmed = await confirmAction(
                this.plugin.app,
                t("Remove closed tab from history"),
                t("Remove this closed tab's browsing history and detailed recovery data?"),
                t("Remove"),
              );
              if (!confirmed) return;
              this.plugin.core.redactLeafHistory(leaf.id);
              this.plugin.core.history.forgetLeafRecord(leaf.id);
              this.plugin.core.scheduleSave();
              this.showInternal("home", false);
            })();
          }));
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
      }
    }

    setMode(searchMode.value, false);
  }

  private renderVaultFileCards(parent: HTMLElement, files: VaultHomeFile[]): void {
    const list = parent.createDiv({ cls: "ubc-card-list ubc-vault-file-list" });
    for (const file of files) {
      const button = list.createEl("button", {
        cls: "ubc-card ubc-vault-file-card",
        text: file.name,
        attr: { "aria-label": "Open " + file.path },
      });
      button.createSpan({
        cls: "ubc-card-subtitle",
        text: file.matchedAlias ? "Alias: " + file.matchedAlias + " · " + file.path : file.path,
      });
      button.addEventListener("click", () => void this.openVaultHomeFile(file.path));
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle(t("Open")).setIcon("file").onClick(() => void this.openVaultHomeFile(file.path)),
        );
        menu.addItem((item) =>
          item.setTitle(t("Open in new tab")).setIcon("plus").onClick(() => void this.openVaultHomeFile(file.path, true)),
        );
        menu.addItem((item) =>
          item.setTitle(t("Copy file path")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(file.path)),
        );
        showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
      });
    }
  }

  private async openVaultHomeFile(path: string, newTab = false): Promise<void> {
    if (!newTab) this.closeReasonOverride = "view-replaced";
    try {
      const opened = await this.plugin.homeAdapter.openFile(this.leaf, path, newTab);
      if (!opened) {
        if (!newTab) this.closeReasonOverride = undefined;
        new Notice(t("That file is no longer available."));
      }
    } catch (error) {
      if (!newTab) this.closeReasonOverride = undefined;
      console.error("Unified Browser Core: failed to open Home file", error);
      new Notice(t("Could not open that file."));
    }
  }

  private renderBookmarks(): void {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-bookmarks" });
    const hero = page.createDiv({ cls: "ubc-bookmark-hero" });
    setIcon(hero.createDiv({ cls: "ubc-bookmark-hero-icon" }), "library-big");
    const heading = hero.createDiv();
    heading.createEl("h1", { text: t("Bookmarks") });
    heading.createEl("p", { text: t("Save freely. Find what you need by type or folder.") });
    const actions = page.createDiv({ cls: "ubc-surface-actions" });
    const add = actions.createEl("button", { text: t("New bookmark"), cls: "mod-cta" });
    add.addEventListener("click", async () => {
      const draft = await editBookmark(this.plugin.app, "", "", t("New bookmark"), { store: this.plugin.core.bookmarks });
      if (!draft) return;
      this.plugin.core.bookmarks.addBookmark(draft);
      this.plugin.core.scheduleSave(); this.refreshBookmarks();
    });
    actions.createEl("button", { text: t("New folder") }).addEventListener("click", async () => {
      const title = await promptText(this.plugin.app, t("New bookmark folder"), "", t("Folder name"));
      if (!title?.trim()) return;
      this.plugin.core.bookmarks.addFolder(title); this.plugin.core.scheduleSave(); this.refreshBookmarks();
    });
    const imports = actions.createEl("button", { text: t("Import") });
    imports.addEventListener("click", () => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(t("Import Obsidian Bookmarks")).setIcon("book-open").onClick(async () => { await this.plugin.importObsidianBookmarks(); this.refreshBookmarks(); }));
      menu.addItem((item) => item.setTitle(t("Import Web viewer Bookmarks")).setIcon("bookmark-plus").onClick(async () => { await this.plugin.importWebViewerBookmarks(); this.refreshBookmarks(); }));
      const rect = imports.getBoundingClientRect(); showDismissibleMenu(menu, () => menu.showAtPosition({ x: rect.left, y: rect.bottom }), this.containerEl.ownerDocument);
    });
    const stats = page.createDiv({ cls: "ubc-bookmark-stats" });
    stats.createSpan({ text: t("{count} bookmarks", { count: this.plugin.core.bookmarks.allBookmarks().length }) });
    stats.createSpan({ text: t("{count} selected", { count: this.plugin.core.bookmarks.favorites().length }) });
    stats.createSpan({ text: t("{count} folders", { count: this.plugin.core.bookmarks.folders().length }) });
    const controls = page.createDiv({ cls: "ubc-bookmark-controls" });
    const search = controls.createEl("input", { cls: "ubc-bookmark-search", attr: { type: "search", placeholder: t("Name, URL, folder or tag"), "aria-label": t("Search bookmarks") } });
    search.value = this.bookmarkSearchQuery;
    const modes = controls.createDiv({ cls: "ubc-bookmark-segments", attr: { role: "group", "aria-label": t("Organize by") } });
    const choices = [["type", "By type", "shapes"], ["folder", "By folder", "folder"], ["selected", "Selected members", "star"]] as const;
    for (const [mode, label, icon] of choices) {
      const button = modes.createEl("button", { attr: { "aria-pressed": String(this.bookmarkLayout === mode) } });
      setIcon(button.createSpan(), icon); button.createSpan({ text: t(label) });
      button.toggleClass("is-active", this.bookmarkLayout === mode);
      button.addEventListener("click", () => { this.bookmarkLayout = mode; this.showInternal("bookmarks", false); });
    }
    const summary = page.createDiv({ cls: "ubc-bookmark-summary", attr: { "aria-live": "polite" } });
    const list = page.createDiv({ cls: "ubc-bookmark-manager" });
    const render = () => {
      list.empty();
      const needle = this.bookmarkSearchQuery.toLowerCase().trim();
      const all = this.plugin.core.bookmarks.allBookmarks();
      const matches = all.filter((bookmark) => [bookmark.title, bookmark.url, bookmark.description ?? "", ...(bookmark.tags ?? []), bookmark.parentId ? this.plugin.core.bookmarks.folderPath(bookmark.parentId) : ""]
        .some((value) => value.toLowerCase().includes(needle)));
      summary.setText(needle ? t("{count} results", { count: matches.length }) : this.bookmarkLayout === "selected" ? t("Pick the pages you use every day from your bookmarks.") : "");
      if (!matches.length && (needle || !this.plugin.core.bookmarks.folders().length || this.bookmarkLayout !== "folder")) {
        const empty = list.createDiv({ cls: "ubc-empty-state ubc-bookmark-empty" });
        setIcon(empty.createDiv({ cls: "ubc-bookmark-empty-icon" }), needle ? "search" : "bookmark-plus");
        empty.createEl("h2", { text: t(needle ? "No matching bookmarks" : "No bookmarks yet") });
        empty.createEl("p", { text: t(needle ? "Try another title, URL, or folder name." : "Save a page with the star in the toolbar, or add your first bookmark here.") });
        if (!needle) empty.createEl("button", { text: t("New bookmark"), cls: "mod-cta" }).addEventListener("click", () => add.click());
        return;
      }
      if (this.bookmarkLayout === "folder" && !needle) { this.renderBookmarkFolder(list, null, 0, render); return; }
      if (this.bookmarkLayout === "selected" || needle) {
        const grid = list.createDiv({ cls: "ubc-bookmark-grid" });
        const sorted = this.bookmarkLayout === "selected" ? [...matches].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.favoriteOrder ?? a.order) - (b.favoriteOrder ?? b.order)) : matches;
        for (const bookmark of sorted) this.renderBookmarkCard(grid, bookmark);
        return;
      }
      const categories = list.createDiv({ cls: "ubc-bookmark-category-index" });
      for (const media of BOOKMARK_MEDIA) {
        const members = matches.filter((bookmark) => classifyBookmark(bookmark) === media.type);
        if (!members.length) continue;
        const section = list.createEl("section", { cls: "ubc-bookmark-category" });
        const groupHeading = section.createDiv({ cls: "ubc-bookmark-category-heading" });
        setIcon(groupHeading.createSpan(), media.icon);
        groupHeading.createEl("h2", { text: t(media.label) });
        groupHeading.createSpan({ cls: "ubc-bookmark-count", text: String(members.length) });
        const shortcut = categories.createEl("button", { cls: "ubc-bookmark-category-chip" });
        setIcon(shortcut.createSpan(), media.icon); shortcut.createSpan({ text: t(media.label) + " · " + members.length });
        shortcut.addEventListener("click", () => section.scrollIntoView({ block: "start", behavior: this.plugin.core.settings().reducedMotion ? "auto" : "smooth" }));
        const grid = section.createDiv({ cls: "ubc-bookmark-grid" });
        for (const bookmark of members) this.renderBookmarkCard(grid, bookmark);
      }
    };
    search.addEventListener("input", () => { this.bookmarkSearchQuery = search.value; render(); });
    render();
  }

  private renderBookmarkCard(parent: HTMLElement, bookmark: BookmarkEntry): void {
    const card = parent.createEl("article", { cls: "ubc-bookmark-card" });
    card.toggleClass("is-selected", bookmark.favorite);
    const top = card.createDiv({ cls: "ubc-bookmark-card-top" });
    renderBookmarkVisual(top, bookmark, "ubc-bookmark-card-visual", this.plugin.app);
    this.renderBookmarkFavoriteToggle(top, bookmark);
    const open = card.createEl("button", { cls: "ubc-bookmark-card-title", text: bookmark.title || bookmark.url });
    open.title = bookmark.url;
    open.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
    open.addEventListener("auxclick", (event) => { if (event.button === 1) { event.preventDefault(); this.openWebTargetFromPointer(bookmark.url, event); } });
    let host = bookmark.url;
    try { host = new URL(bookmark.url).hostname || bookmark.url; } catch { /* retain raw URL */ }
    card.createDiv({ cls: "ubc-bookmark-meta", text: host });
    if (bookmark.description) card.createEl("p", { cls: "ubc-bookmark-card-description", text: bookmark.description });
    const footer = card.createDiv({ cls: "ubc-bookmark-card-footer" });
    const media = BOOKMARK_MEDIA.find((entry) => entry.type === classifyBookmark(bookmark))!;
    const badge = footer.createSpan({ cls: "ubc-bookmark-type-badge" });
    setIcon(badge.createSpan(), media.icon); badge.createSpan({ text: t(media.label) });
    const edit = footer.createEl("button", { cls: "clickable-icon", attr: { title: t("Edit bookmark"), "aria-label": t("Edit bookmark") } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => { this.bookmarkPopoverClose?.(); this.bookmarkPopoverClose = showBookmarkPopover(this.plugin, bookmark, edit, this.browserContentEl, () => this.refreshBookmarks()); });
    const move = footer.createEl("button", { cls: "clickable-icon", attr: { title: t("Move to folder"), "aria-label": t("Move to folder") } });
    setIcon(move, "folder-input");
    move.addEventListener("click", async () => {
      const parentId = await pickBookmarkFolder(this.plugin.app, this.plugin.core.bookmarks);
      if (parentId === undefined || !this.plugin.core.bookmarks.moveBookmark(bookmark.id, parentId)) return;
      this.plugin.core.scheduleSave(); this.refreshBookmarks();
    });
    if (bookmark.parentId) card.createDiv({ cls: "ubc-bookmark-card-path", text: this.plugin.core.bookmarks.folderPath(bookmark.parentId) });
    card.addEventListener("contextmenu", (event) => { event.preventDefault(); showBookmarkMenu(this.plugin, this, bookmark, event); });
  }

  private renderBookmarkSearchResult(parent: HTMLElement, bookmark: BookmarkEntry): void {
    const row = parent.createDiv({ cls: "ubc-bookmark-row ubc-bookmark-search-result" });
    renderBookmarkVisual(row, bookmark, "ubc-bookmark-kind", this.plugin.app);
    const content = row.createDiv({ cls: "ubc-bookmark-row-content" });
    const button = content.createEl("button", { cls: "ubc-link-button", text: bookmark.title || bookmark.url });
    button.title = bookmark.url;
    button.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.openWebTargetFromPointer(bookmark.url, event);
    });
    const path = bookmark.parentId ? this.plugin.core.bookmarks.folderPath(bookmark.parentId) : "";
    content.createSpan({
      cls: "ubc-bookmark-meta",
      text: path ? `${path} · ${bookmark.url}` : bookmark.url,
    });
    if (bookmark.description) content.createSpan({ cls: "ubc-bookmark-meta", text: bookmark.description });
    if (bookmark.tags?.length) content.createSpan({ cls: "ubc-bookmark-meta", text: bookmark.tags.join(" · ") });
    this.renderBookmarkFavoriteToggle(row, bookmark);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showBookmarkMenu(this.plugin, this, bookmark, event);
    });
  }

  private renderBookmarkFolder(
    parent: HTMLElement,
    parentId: string | null,
    depth: number,
    refresh: () => void,
  ): void {
    for (const item of this.plugin.core.bookmarks.children(parentId)) {
      const row = parent.createDiv({ cls: "ubc-bookmark-row" });
      row.style.setProperty("--ubc-depth", String(depth));
      if (item.kind === "folder") {
        const collapsed = this.collapsedBookmarkFolders.has(item.id);
        const toggle = row.createEl("button", {
          cls: "ubc-bookmark-folder-toggle clickable-icon",
          attr: {
            type: "button",
            "aria-label": (collapsed ? "Expand " : "Collapse ") + item.title,
            "aria-expanded": String(!collapsed),
          },
        });
        setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
        const title = row.createEl("button", {
          cls: "ubc-bookmark-folder-title",
          text: item.title,
          attr: { type: "button" },
        });
        const count = this.plugin.core.bookmarks.descendantBookmarks(item.id).length;
        row.createSpan({
          cls: "ubc-bookmark-count",
          text: String(count),
          attr: { "aria-label": t("{v0} bookmark{v1} in {v2}", { v0: count, v1: count === 1 ? "" : "s", v2: item.title }) },
        });
        const toggleFolder = () => {
          if (collapsed) this.collapsedBookmarkFolders.delete(item.id);
          else this.collapsedBookmarkFolders.add(item.id);
          refresh();
        };
        toggle.addEventListener("click", toggleFolder);
        title.addEventListener("click", toggleFolder);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkFolderMenu(this.plugin, this, item, event);
        });
        if (!collapsed) this.renderBookmarkFolder(parent, item.id, depth + 1, refresh);
      } else {
        renderBookmarkVisual(row, item, "ubc-bookmark-kind", this.plugin.app);
        const content = row.createDiv({ cls: "ubc-bookmark-row-content" });
        const button = content.createEl("button", { cls: "ubc-link-button", text: item.title || item.url });
        button.title = item.url;
        button.addEventListener("click", (event) => this.openWebTargetFromPointer(item.url, event));
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          this.openWebTargetFromPointer(item.url, event);
        });
        content.createSpan({ cls: "ubc-bookmark-meta", text: item.url });
        this.renderBookmarkFavoriteToggle(row, item);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkMenu(this.plugin, this, item, event);
        });
      }
    }
  }

  private renderBookmarkFavoriteToggle(parent: HTMLElement, bookmark: BookmarkEntry): void {
    const button = parent.createEl("button", {
      cls: "ubc-bookmark-favorite-toggle clickable-icon",
      attr: {
        type: "button",
        "aria-label": bookmark.favorite ? t("Remove from favorites") : t("Add to favorites"),
        title: bookmark.favorite ? t("Remove from favorites") : t("Add to favorites"),
      },
    });
    setIcon(button, "star");
    button.toggleClass("is-active", bookmark.favorite);
    button.setAttribute("aria-pressed", String(bookmark.favorite));
    button.addEventListener("click", () => {
      this.plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
  }

  private renderHistory(): void {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-history" });
    const heading = page.createDiv({ cls: "ubc-surface-heading" });
    heading.createEl("h1", { text: t("History") });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: t("Browse visits by day, tab, and alternate path. Filtering only changes what is shown."),
    });
    const filters = page.createDiv({ cls: "ubc-history-filters" });
    const search = filters.createEl("input", {
      attr: {
        placeholder: t("Search title, URL, domain, or tab"),
        "aria-label": t("Search history"),
      },
    });
    this.historySearchEl = search;
    const dayFilter = filters.createEl("input", {
      attr: { type: "date", "aria-label": t("Filter history by day") },
    });
    const containerFilter = filters.createEl("select", {
      attr: { "aria-label": t("Filter history by container") },
    });
    containerFilter.createEl("option", { text: t("All containers"), value: "" });
    for (const container of this.plugin.core.containers.list()) {
      containerFilter.createEl("option", { text: container.name, value: container.id });
    }
    const clearFilters = filters.createEl("button", { text: t("Clear filters") });
    const summary = page.createDiv({ cls: "ubc-history-summary", attr: { "aria-live": "polite" } });
    const timeline = page.createDiv({ cls: "ubc-history-timeline" });
    const render = () => {
      this.disconnectHistoryObserver();
      timeline.empty();
      const needle = search.value.toLowerCase().trim();
      const selectedDay = dayFilter.value;
      const selectedContainer = containerFilter.value;
      const nodes = this.plugin.core.history
        .allNodes()
        .filter((node) => node.kind !== "residual")
        .filter((node) => {
          const day = historyDayKey(node.timestamp, this.plugin.core.settings().historyDayStartMinutes);
          if (selectedDay && day !== selectedDay) return false;
          if (selectedContainer) {
            const nodeContainerId = node.kind === "navigation"
              ? node.containerId
              : this.plugin.core.state.history.leaves[node.leafId]?.containerId;
            if (nodeContainerId !== selectedContainer) return false;
          }
          if (!needle) return true;
          if (node.kind !== "navigation") return false;
          const leafTitle = this.plugin.core.state.history.leaves[node.leafId]?.lastTitle || "";
          let domain = "";
          try {
            domain = new URL(node.url).hostname;
          } catch {
            domain = "";
          }
          return [node.title, node.url, domain, leafTitle].some((value) => value.toLowerCase().includes(needle));
        });
      const byDay = new Map<string, HistoryNode[]>();
      for (const node of nodes) {
        const key = historyDayKey(node.timestamp, this.plugin.core.settings().historyDayStartMinutes);
        const bucket = byDay.get(key) ?? [];
        bucket.push(node);
        byDay.set(key, bucket);
      }
      const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
      const navigationCount = nodes.filter((node) => node.kind === "navigation").length;
      const tombstoneCount = nodes.filter((node) => node.kind === "tombstone").length;
      const filtersActive = Boolean(needle || selectedDay || selectedContainer);
      summary.setText(
        navigationCount
          ? t("{v0} visit{v1} across {v2} day{v3}{v4}{v5}", { v0: navigationCount, v1: navigationCount === 1 ? "" : "s", v2: days.length, v3: days.length === 1 ? "" : "s", v4: tombstoneCount ? ` · ${tombstoneCount} deleted entr${tombstoneCount === 1 ? "y" : "ies"} retained` : "", v5: filtersActive ? " · filtered" : "" })
          : tombstoneCount
            ? t("{v0} deleted histor{v1} retained to preserve navigation paths{v2}", { v0: tombstoneCount, v1: tombstoneCount === 1 ? "y entry" : "y entries", v2: filtersActive ? " · filtered" : "" })
          : filtersActive
            ? t("No history matches these filters.")
            : t("No browser history yet."),
      );
      clearFilters.toggleClass("is-hidden", !filtersActive);
      if (!days.length) {
        const empty = timeline.createDiv({ cls: "ubc-history-empty" });
        empty.createEl("strong", { text: filtersActive ? t("No matching visits") : t("No history yet") });
        empty.createEl("p", {
          text: filtersActive
            ? t("Try clearing one or more filters.")
            : t("Visited web pages will appear here without creating artificial gaps for idle time."),
        });
        return;
      }
      const revealNode = this.historyRevealNodeId
        ? this.plugin.core.state.history.nodes[this.historyRevealNodeId]
        : undefined;
      const revealDay = revealNode
        ? historyDayKey(revealNode.timestamp, this.plugin.core.settings().historyDayStartMinutes)
        : undefined;
      const revealDayIndex = revealDay ? days.findIndex(([day]) => day === revealDay) : -1;
      let renderedDays = 0;
      const batchSize = 14;
      const sentinel = document.createElement("button");
      sentinel.className = "ubc-history-load-more";
      sentinel.textContent = "Load older history";
      const appendBatch = () => {
        sentinel.remove();
        const batch = days.slice(renderedDays, renderedDays + batchSize);
        renderedDays += batch.length;
        for (const [day, dayNodes] of batch) {
          const section = timeline.createEl("section", { cls: "ubc-history-day" });
          const dayHeading = section.createEl("h2", { text: day });
          dayHeading.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            this.showHistoryDayMenu(day, dayNodes, event, () => {
              dayFilter.value = day;
              render();
            }, render);
          });
          const byLeaf = new Map<string, HistoryNode[]>();
          for (const node of dayNodes.sort((a, b) => a.timestamp - b.timestamp)) {
            const bucket = byLeaf.get(node.leafId) ?? [];
            bucket.push(node);
            byLeaf.set(node.leafId, bucket);
          }
          for (const [leafId, leafNodes] of byLeaf) {
            const leafRecord = this.plugin.core.state.history.leaves[leafId];
            const group = section.createDiv({ cls: "ubc-history-leaf" });
            const leafHeader = group.createDiv({ cls: "ubc-history-leaf-header" });
            leafHeader.createSpan({
              text: leafRecord?.lastTitle || "Tab",
              attr: { title: this.plugin.core.containers.nameFor(leafRecord?.containerId) },
            });
            leafHeader.addEventListener("contextmenu", (event) => {
              event.preventDefault();
              this.showHistoryLeafMenu(leafId, leafNodes, event, render);
            });
            if (leafRecord?.closedAt && leafRecord.lastUrl) {
              const restore = leafHeader.createEl("button", { text: t("Restore") });
              restore.addEventListener("click", () => this.plugin.restoreLeaf(leafId));
            }
            this.renderHistoryLeafNodes(
              group,
              leafNodes,
              Boolean(needle || selectedDay || selectedContainer),
            );
          }
        }
        if (renderedDays < days.length) timeline.appendChild(sentinel);
      };
      sentinel.addEventListener("click", appendBatch);
      const initialBatches = revealDayIndex >= 0 ? Math.floor(revealDayIndex / batchSize) + 1 : 1;
      for (let batch = 0; batch < initialBatches; batch++) appendBatch();
      if (this.historyRevealNodeId) {
        const revealId = this.historyRevealNodeId;
        window.requestAnimationFrame(() => {
          const row = [...timeline.querySelectorAll<HTMLElement>("[data-history-node-id]")]
            .find((candidate) => candidate.dataset.historyNodeId === revealId);
          if (!row) return;
          row.addClass("is-revealed");
          row.tabIndex = -1;
          row.scrollIntoView({
            block: "center",
            behavior: this.plugin.core.settings().reducedMotion ? "auto" : "smooth",
          });
          row.focus({ preventScroll: true });
          this.historyRevealNodeId = undefined;
        });
      }
      if (renderedDays < days.length && typeof IntersectionObserver !== "undefined") {
        this.historyObserver = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) appendBatch();
          },
          { root: this.internalLayerEl, rootMargin: "300px" },
        );
        this.historyObserver.observe(sentinel);
      }
    };
    search.addEventListener("input", render);
    dayFilter.addEventListener("change", render);
    containerFilter.addEventListener("change", render);
    clearFilters.addEventListener("click", () => {
      search.value = "";
      dayFilter.value = "";
      containerFilter.value = "";
      render();
      search.focus();
    });
    render();
  }

  private openWebTargetFromPointer(url: string, event: MouseEvent): void {
    url = resolveBookmarkUrl(url, this.plugin.app);
    const modifiedTab = event.metaKey || event.ctrlKey || event.button === 1;
    if (event.shiftKey && !modifiedTab) {
      void this.plugin.openBrowser({ url, placement: "window" });
      return;
    }
    if (modifiedTab) {
      void this.plugin.openBrowser({
        url,
        reveal: event.shiftKey,
      });
      return;
    }
    this.navigate(url);
  }

  private showHistoryDayMenu(
    day: string,
    dayNodes: HistoryNode[],
    event: MouseEvent,
    filterDay: () => void,
    refresh: () => void,
  ): void {
    const menu = new Menu();
    const navigationNodes = dayNodes.filter((node): node is NavigationNode => node.kind === "navigation");
    const branchIds = [...new Set(navigationNodes.map((node) => node.branchId))];
    menu.addItem((item) => item.setTitle(t("Expand all alternate paths")).onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.add(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Collapse all alternate paths")).onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.delete(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Open all tabs from this day")).setIcon("copy-plus").onClick(() => {
      const latestByLeaf = new Map<string, NavigationNode>();
      for (const node of navigationNodes) {
        const current = latestByLeaf.get(node.leafId);
        if (!current || node.timestamp > current.timestamp) latestByLeaf.set(node.leafId, node);
      }
      for (const node of latestByLeaf.values()) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle(t("Search within this day")).setIcon("search").onClick(filterDay));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Delete this day's history")).setIcon("trash").onClick(() => {
      void (async () => {
        if (!(await confirmAction(this.plugin.app, t("Delete history day"), t("Delete web history recorded in {v0}?", { v0: day }), t("Delete history")))) return;
        this.plugin.core.redactHistoryNodes(navigationNodes.map((node) => node.id));
        refresh();
      })();
    }));
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }

  private showHistoryLeafMenu(leafId: string, leafNodes: HistoryNode[], event: MouseEvent, refresh: () => void): void {
    const record = this.plugin.core.state.history.leaves[leafId];
    const navigationNodes = leafNodes.filter((node): node is NavigationNode => node.kind === "navigation");
    const mainBranch = this.plugin.core.history.currentBranchForLeaf(leafId) ?? navigationNodes.at(-1)?.branchId;
    const mainNodes = mainBranch ? this.plugin.core.history.navigationNodesForBranch(mainBranch) : navigationNodes;
    const menu = new Menu();
    if (record?.lastUrl) {
      menu.addItem((item) => item.setTitle(t("Restore tab")).setIcon("rotate-ccw").onClick(() => void this.plugin.restoreLeaf(leafId)));
      const originalContainerExists = Boolean(this.plugin.core.containers.find(record.containerId));
      menu.addItem((item) =>
        item
          .setTitle(originalContainerExists ? t("Restore in original container") : t("Original container deleted"))
          .setIcon("box")
          .setDisabled(!originalContainerExists)
          .onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: record.containerId })),
      );
      for (const container of this.plugin.core.containers.list()) {
        if (container.id === record.containerId) continue;
        menu.addItem((item) => item.setTitle("Restore in " + container.name).setIcon("box").onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: container.id })));
      }
      menu.addItem((item) => item.setTitle(t("Pin restored tab")).setIcon("pin").onClick(() => void this.plugin.restoreLeaf(leafId, { pinned: true })));
    }
    menu.addItem((item) => item.setTitle(t("Open current path in new tabs")).setDisabled(mainNodes.length === 0).onClick(() => {
      for (const node of mainNodes) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle(record?.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")).onClick(() => {
      if (!record) return;
      record.manualRetention = record.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.scheduleSave();
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Copy tab history")).setIcon("copy").onClick(() => {
      const text = navigationNodes
        .map((node) => `${new Date(node.timestamp).toLocaleString()}\t${node.title}\t${node.url}`)
        .join("\n");
      void navigator.clipboard.writeText(text);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Delete tab history")).setIcon("trash").onClick(() => {
      void (async () => {
        if (!(await confirmAction(this.plugin.app, t("Delete tab history"), t("Delete this tab's browsing history and detailed recovery data?"), t("Delete history")))) return;
        this.plugin.core.redactLeafHistory(leafId);
        refresh();
      })();
    }));
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }

  private renderHistoryLeafNodes(parent: HTMLElement, nodes: HistoryNode[], filtered = false): void {
    const navigationNodes = nodes.filter((node): node is NavigationNode => node.kind === "navigation");
    const leafId = nodes[0]?.leafId;
    const lastBranch = (leafId && this.plugin.core.history.currentBranchForLeaf(leafId)) ?? navigationNodes.at(-1)?.branchId;
    const branches = new Map<string, NavigationNode[]>();
    for (const node of navigationNodes) {
      const bucket = branches.get(node.branchId) ?? [];
      bucket.push(node);
      branches.set(node.branchId, bucket);
    }
    const renderedSummaries = new Set<string>();
    for (const node of nodes) {
      if (node.kind === "residual") continue;
      const row = parent.createDiv({ cls: "ubc-history-node" });
      if (node.kind === "tombstone") {
        row.addClass("is-tombstone");
        row.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        row.createSpan({ text: t("Deleted history entry") });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const check = this.plugin.core.history.canRemoveTombstone(node.id);
          const menu = new Menu();
          menu.addItem((item) =>
            item
              .setTitle(t("Remove deleted entry marker"))
              .setIcon("trash")
              .setDisabled(!check.ok)
              .onClick(() => {
                const result = this.plugin.core.history.removeTombstone(node.id);
                if (!result.ok) {
                  new Notice(result.reason || "This deleted entry marker cannot be removed.");
                  return;
                }
                this.plugin.core.scheduleSave();
                this.showInternal("history");
              }),
          );
          if (!check.ok && check.reason) {
            menu.addItem((item) => item.setTitle(check.reason || "").setDisabled(true));
          }
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
        continue;
      }
      row.dataset.historyNodeId = node.id;
      if (node.branchId !== lastBranch && !this.expandedHistoryBranches.has(node.branchId)) {
        row.remove();
        if (renderedSummaries.has(node.branchId)) continue;
        renderedSummaries.add(node.branchId);
        const summary = parent.createDiv({ cls: "ubc-history-node ubc-history-branch-summary" });
        summary.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        const count = branches.get(node.branchId)?.length ?? 1;
        const expand = summary.createEl("button", {
          cls: "ubc-history-link",
          text: t("Alternate path · {v0} visit{v1}", { v0: count, v1: count === 1 ? "" : "s" }),
        });
        expand.addEventListener("click", () => {
          this.expandedHistoryBranches.add(node.branchId);
          this.showInternal("history");
        });
        summary.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const branchNodes = this.plugin.core.history.navigationNodesForBranch(node.branchId);
          const latest = branchNodes.at(-1);
          const menu = new Menu();
          menu.addItem((item) => item.setTitle(t("Show alternate path")).onClick(() => {
            this.expandedHistoryBranches.add(node.branchId);
            this.showInternal("history");
          }));
          menu.addItem((item) =>
            item
              .setTitle(t("Restore latest page from this path"))
              .setIcon("rotate-ccw")
              .setDisabled(!latest)
              .onClick(() => { if (latest) void this.plugin.restoreHistoryNode(latest); }),
          );
          menu.addItem((item) => item.setTitle(t("Open this path in new tabs")).setDisabled(branchNodes.length === 0).onClick(() => {
            for (const branchNode of branchNodes) void this.plugin.openBrowser({ url: branchNode.url, containerId: branchNode.containerId });
          }));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(t("Delete alternate path")).setIcon("trash").onClick(() => {
            void (async () => {
              if (!(await confirmAction(this.plugin.app, t("Delete alternate history path"), t("Delete {v0} visit(s) from this path?", { v0: branchNodes.length }), t("Delete path")))) return;
              this.plugin.core.redactHistoryBranch(node.branchId);
              this.expandedHistoryBranches.delete(node.branchId);
              this.showInternal("history");
            })();
          }));
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
        continue;
      }
      if (node.branchId !== lastBranch) row.addClass("is-expanded-branch");
      row.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      const button = row.createEl("button", { cls: "ubc-history-link", text: node.title || node.url });
      button.title = node.url;
      button.addEventListener("click", () => this.navigate(node.url));
      if (filtered) {
        const reveal = row.createEl("button", {
          cls: "ubc-history-reveal",
          text: t("Reveal"),
          attr: { "aria-label": t("Reveal this visit in its alternate path") },
        });
        reveal.addEventListener("click", () => this.revealHistoryNode(node));
      }
      const residuals = this.plugin.core.history.residualsOf(node.id);
      if (residuals.length) {
        const badge = row.createEl("button", {
          cls: "ubc-residual-badge",
          text: `+${residuals.length}`,
          attr: {
            "aria-label": t("Show {v0} reload, redirect, or navigation event{v1}", { v0: residuals.length, v1: residuals.length === 1 ? "" : "s" }),
          },
        });
        badge.title = "Show reloads, redirects, and other navigation events";
        badge.addEventListener("click", () => {
          if (this.expandedResidualParents.has(node.id)) this.expandedResidualParents.delete(node.id);
          else this.expandedResidualParents.add(node.id);
          this.showInternal("history");
        });
      }
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => item.setTitle(t("Open")).onClick(() => this.navigate(node.url)));
        menu.addItem((item) => item.setTitle(t("Open in new tab")).onClick(() => this.plugin.openBrowser({ url: node.url, containerId: node.containerId })));
        for (const container of this.plugin.core.containers.list()) {
          menu.addItem((item) =>
            item
              .setTitle("Open in " + container.name)
              .setIcon("box")
              .onClick(() => this.plugin.openBrowser({ url: node.url, containerId: container.id })),
          );
        }
        menu.addItem((item) =>
          item.setTitle(t("Restore from here")).onClick(() => this.plugin.restoreHistoryNode(node)),
        );
        menu.addItem((item) =>
          item
            .setTitle(t("Show in full history"))
            .setIcon("locate")
            .onClick(() => this.revealHistoryNode(node)),
        );
        menu.addItem((item) => item.setTitle(t("Bookmark")).onClick(() => {
          this.plugin.core.bookmarks.addBookmark({ title: node.title, url: node.url });
          this.plugin.core.scheduleSave();
          this.renderFavoritesBar();
        }));
        menu.addItem((item) =>
          item
            .setTitle(t("Copy URL"))
            .setIcon("copy")
            .onClick(() => void navigator.clipboard.writeText(node.url)),
        );
        menu.addItem((item) =>
          item
            .setTitle(t("Copy title"))
            .setIcon("copy")
            .onClick(() => void navigator.clipboard.writeText(node.title || node.url)),
        );
        if (residuals.length) {
          menu.addItem((item) =>
            item
              .setTitle(this.expandedResidualParents.has(node.id) ? t("Hide redirects and reloads") : t("Show redirects and reloads"))
              .onClick(() => {
                if (this.expandedResidualParents.has(node.id)) this.expandedResidualParents.delete(node.id);
                else this.expandedResidualParents.add(node.id);
                this.showInternal("history");
              }),
          );
        }
        if (node.branchId !== lastBranch) {
          menu.addItem((item) => item.setTitle(t("Collapse alternate path")).onClick(() => {
            this.expandedHistoryBranches.delete(node.branchId);
            this.showInternal("history");
          }));
        }
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(node.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")).onClick(() => {
          node.manualRetention = node.manualRetention === "preserve" ? "default" : "preserve";
          this.plugin.core.scheduleSave();
        }));
        menu.addItem((item) => item.setTitle(t("Delete history entry")).setIcon("trash").onClick(() => {
          void (async () => {
            const confirmed = await confirmAction(
              this.plugin.app,
              t("Delete history entry"),
              t("Delete “{v0}” from browser history?", { v0: node.title || node.url }),
              t("Delete history"),
            );
            if (!confirmed) return;
            this.plugin.core.redactHistoryNode(node.id);
            this.showInternal("history");
          })();
        }));
        showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
      });
      if (this.expandedResidualParents.has(node.id)) {
        for (const residual of residuals) {
          const detail = parent.createDiv({ cls: "ubc-history-residual-detail" });
          detail.createSpan({ cls: "ubc-residual-kind", text: residualLabel(residual.residualKind) });
          const text =
            residual.residualKind === "redirect"
              ? `${residual.fromUrl || "unknown"} → ${residual.toUrl || "unknown"}`
              : residual.detail || residual.toUrl || residual.fromUrl || "Recorded browser event";
          detail.createSpan({ text });
          detail.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const menu = new Menu();
            menu.addItem((item) => item.setTitle(t("Copy event details")).setIcon("copy").onClick(() => {
              void navigator.clipboard.writeText(JSON.stringify(residual, null, 2));
            }));
            if (residual.residualKind === "redirect" && residual.fromUrl) {
              menu.addItem((item) => item.setTitle(t("Open redirect source")).onClick(() => this.navigate(residual.fromUrl!)));
            }
            if (residual.residualKind === "redirect" && residual.toUrl) {
              menu.addItem((item) => item.setTitle(t("Open redirect destination")).onClick(() => this.navigate(residual.toUrl!)));
            }
            menu.addItem((item) => item.setTitle(t("Hide redirects and reloads")).onClick(() => {
              this.expandedResidualParents.delete(node.id);
              this.showInternal("history");
            }));
            showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
          });
        }
      }
    }
  }

  private revealHistoryNode(node: NavigationNode): void {
    this.expandedHistoryBranches.add(node.branchId);
    this.historyRevealNodeId = node.id;
    this.showInternal("history");
  }

  private showContainerMenu(event: MouseEvent): void {
    this.showContainerMenuAt({ x: event.clientX, y: event.clientY });
  }

  private showContainerMenuAt(position: { x: number; y: number }): void {
    const mode = this.plugin.core.settings().containerMode;
    if (mode === "off") return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("Open new tab in this container"))
        .setIcon("plus")
        .onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: this.containerId })),
    );
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Reopen current page in")).setIcon("repeat-2").setDisabled(true));
    for (const container of this.plugin.core.containers.list()) {
      menu.addItem((item) => {
        item.setTitle(container.name).setIcon(container.icon || "box");
        if (container.id === this.containerId) item.setChecked(true);
        item.onClick(() => {
          if (container.id !== this.containerId) this.reopenInContainer(container.id);
        });
      });
    }
    menu.addSeparator();
    if (mode !== "automatic") {
      menu.addItem((item) =>
        item
          .setTitle(t("Automatic site defaults are off"))
          .setIcon("route-off")
          .setDisabled(true),
      );
      menu.addItem((item) => item.setTitle(t("Manage containers")).setIcon("settings").onClick(() => this.plugin.openSettings()));
      this.openContainerMenu(menu, position);
      return;
    }
    const routing = this.plugin.core.containers.routingStatus(
      this.currentUrlValue,
      this.containerId,
      this.siteAssignmentBypassOrigin,
      this.siteAssignmentBypassReason,
    );
    if (routing) {
      const assignment = routing.assignedContainerId
        ? this.plugin.core.containers.assignmentForHostname(routing.hostname)
        : undefined;
      if (assignment) {
        const assignedName = this.plugin.core.containers.nameFor(assignment.containerId);
        menu.addItem((item) =>
          item
            .setTitle(
              routing.bypassingAssignment
                ? routing.bypassReason === "opener"
                  ? t("Sign-in flow stays in this container · site default is {v0}", { v0: assignedName })
                  : t("Opened here explicitly · site default is {v0}", { v0: assignedName })
                : t("Site default · {v0}", { v0: assignedName }),
            )
            .setIcon(routing.bypassingAssignment ? "shuffle" : "route")
            .setDisabled(true),
        );
        if (routing.bypassingAssignment) {
          menu.addItem((item) =>
            item
              .setTitle(t("Return to site default · {v0}", { v0: assignedName }))
              .setIcon("undo-2")
              .onClick(() => this.reopenInContainer(assignment.containerId)),
          );
        }
      } else {
        menu.addItem((item) =>
          item.setTitle(t("No default container for this site")).setIcon("route-off").setDisabled(true),
        );
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Site default container")).setIcon("route").setDisabled(true));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem((item) =>
          item
            .setTitle(t("Always open {v0} in {v1}", { v0: routing.hostname, v1: container.name }))
            .setIcon(container.icon || "box")
            .setChecked(routing.assignedContainerId === container.id)
            .onClick(() => this.assignCurrentSiteToContainer(routing.hostname, container.id)),
        );
      }
      if (assignment) {
        menu.addItem((item) => item.setTitle(t("Forget site default container")).onClick(() => {
          this.plugin.core.containers.unassignOrigin(assignment.originPattern);
          this.siteAssignmentBypassOrigin = undefined;
          this.siteAssignmentBypassReason = undefined;
          this.plugin.core.scheduleSave();
          this.plugin.scheduleSessionCheckpoint();
          this.updateContainerIndicator();
          new Notice("Forgot the site default container for " + assignment.originPattern);
        }));
      }
    } else {
      menu.addItem((item) => item.setTitle(t("Site defaults are only available for web pages")).setDisabled(true));
    }
    menu.addItem((item) => item.setTitle(t("Manage containers")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    this.openContainerMenu(menu, position);
  }

  private openContainerMenu(menu: Menu, position: { x: number; y: number }): void {
    this.activeContainerMenu?.hide();
    const dismissEl = this.browserContentEl.createDiv({ cls: "ubc-menu-dismiss-layer" });
    this.activeContainerMenu = menu;
    dismissEl.addEventListener("pointerdown", () => menu.hide());
    menu.onHide(() => {
      dismissEl.remove();
      if (this.activeContainerMenu === menu) {
        this.activeContainerMenu = null;
      }
    });
    showDismissibleMenu(menu, () => menu.showAtPosition(position), this.containerEl.ownerDocument);
  }

  private assignCurrentSiteToContainer(hostname: string, containerId: ContainerId): void {
    this.plugin.core.containers.assignOrigin(hostname, containerId);
    if (containerId === this.containerId) {
      this.siteAssignmentBypassOrigin = undefined;
      this.siteAssignmentBypassReason = undefined;
    }
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
    this.updateContainerIndicator();
    new Notice(t("Always open {v0} in {v1}.", { v0: hostname, v1: this.plugin.core.containers.nameFor(containerId) }));
  }

  private updateContainerIndicator(): void {
    if (!this.containerButtonEl) return;
    const mode = this.plugin.core.settings().containerMode;
    this.containerButtonEl.hidden = mode === "off";
    if (mode === "off") return;
    const container = this.plugin.core.containers.get(this.containerId);
    setIcon(this.containerButtonEl, container.icon || "box");
    const routing = this.plugin.core.containers.routingStatus(
      this.currentUrlValue,
      this.containerId,
      this.siteAssignmentBypassOrigin,
      this.siteAssignmentBypassReason,
    );
    const assignedName = mode === "automatic" && routing?.assignedContainerId
      ? this.plugin.core.containers.nameFor(routing.assignedContainerId)
      : undefined;
    const routingHint = routing?.bypassingAssignment && assignedName
      ? routing.bypassReason === "opener"
        ? ` · sign-in flow stays here (site default: ${assignedName})`
        : ` · opened here explicitly (site default: ${assignedName})`
      : assignedName
        ? ` · site default: ${assignedName}`
        : mode === "manual"
          ? " · manual routing"
          : "";
    this.containerButtonEl.setAttribute("aria-label", "Container: " + container.name + routingHint);
    this.containerButtonEl.title = "Container: " + container.name + routingHint;
    this.containerButtonEl.style.setProperty(
      "--ubc-container-color",
      container.color || "var(--text-muted)",
    );
  }

  private showPermissionMenu(event: MouseEvent | KeyboardEvent): void {
    const menu = new Menu();
    const origin = this.currentOrigin();
    if (!origin) {
      menu.addItem((item) => item.setTitle(t("Site permissions are only available for web pages")).setDisabled(true));
      menu.addItem((item) => item.setTitle(t("Open Browser Core settings")).onClick(() => this.plugin.openSettings()));
      this.showMenuForEvent(menu, event);
      return;
    }
    const records = this.plugin.core.permissions.listForOrigin(this.containerId, origin);
    if (!records.length) {
      menu.addItem((item) => item.setTitle(t("No saved permissions for this site")).setDisabled(true));
    } else {
      for (const record of records) {
        menu.addItem((item) =>
          item
            .setTitle(`${permissionLabel(record.permission)}: ${permissionDecisionLabel(record.decision)}`)
            .setDisabled(true),
        );
        for (const decision of ["allow", "block", "ask"] as const) {
          menu.addItem((item) =>
            item
              .setTitle(`${permissionDecisionLabel(decision)}: ${permissionLabel(record.permission)}`)
              .setChecked(record.decision === decision)
              .onClick(() => {
                if (decision === "ask") this.plugin.core.permissions.remove(this.containerId, origin, record.permission);
                else this.plugin.core.permissions.set(this.containerId, origin, record.permission, decision);
                this.plugin.core.scheduleSave();
              }),
          );
        }
        menu.addSeparator();
      }
    }
    menu.addItem((item) =>
      item
        .setTitle(t("Reset site permissions"))
        .setIcon("rotate-ccw")
        .setDisabled(records.length === 0)
        .onClick(() => {
          this.plugin.core.permissions.resetOrigin(this.containerId, origin);
          this.plugin.core.scheduleSave();
        }),
    );
    menu.addItem((item) => item.setTitle(t("Open Browser Core settings")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    this.showMenuForEvent(menu, event);
  }

  private showMenuForEvent(menu: Menu, event: MouseEvent | KeyboardEvent): void {
    if (event instanceof MouseEvent) showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    else {
      const rect = (this.browserHeaderEl ?? this.toolbarEl).getBoundingClientRect();
      showDismissibleMenu(menu, () => menu.showAtPosition({ x: rect.right, y: rect.bottom }), this.containerEl.ownerDocument);
    }
  }

  private currentOrigin(): string | undefined {
    try {
      const parsed = new URL(this.currentUrlValue);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  }

  private showNavigationHistoryMenu(direction: -1 | 1, event: MouseEvent): void {
    const menu = new Menu();
    const transientIndices: number[] = [];
    if (direction < 0) {
      for (let index = this.transientIndex - 1; index >= 0 && transientIndices.length < 12; index--) {
        transientIndices.push(index);
      }
    } else {
      for (
        let index = this.transientIndex + 1;
        index < this.transientHistory.length && transientIndices.length < 12;
        index++
      ) {
        transientIndices.push(index);
      }
    }

    if (transientIndices.length) {
      const webEntries = this.webview ? this.navigationHistoryAdapter.entries(this.webview) : [];
      for (const index of transientIndices) {
        const entry = this.transientHistory[index];
        if (!entry) continue;
        menu.addItem((item) => {
          if (entry.kind === "internal") {
            item
              .setTitle(internalSurfaceLabel(entry.url) || "Browser Core")
              .setIcon(entry.surface === "home" ? "home" : entry.surface === "history" ? "history" : "book-open");
          } else {
            const webEntry = typeof entry.webIndex === "number" ? webEntries[entry.webIndex] : undefined;
            const title =
              entry.title ||
              (typeof webEntry?.title === "string" ? webEntry.title : "") ||
              entry.url ||
              "Web page";
            item.setTitle(title).setIcon("globe");
          }
          item.onClick(() => this.goToTransientIndex(index));
        });
      }
    } else {
      this.addFallbackWebNavigationItems(menu, direction);
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("Show full tab history"))
        .setIcon("history")
        .onClick(() => this.showInternal("history")),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Show alternate paths"))
        .setIcon("git-branch")
        .onClick(() => {
          for (const node of this.plugin.core.history.nodesForLeaf(this.leafId())) {
            if (node.kind === "navigation") this.expandedHistoryBranches.add(node.branchId);
          }
          this.showInternal("history");
        }),
    );
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }

  private addFallbackWebNavigationItems(menu: Menu, direction: -1 | 1): void {
    const webview = this.readyWebview();
    if (!webview) {
      menu.addItem((item) =>
        item.setTitle(direction < 0 ? t("No back history") : t("No forward history")).setDisabled(true),
      );
      return;
    }
    const entries = this.navigationHistoryAdapter.entries(webview);
    const activeIndex = this.navigationHistoryAdapter.activeIndex(webview) ?? 0;
    const indices: number[] = [];
    if (direction < 0) {
      for (let index = activeIndex - 1; index >= 0 && indices.length < 12; index--) indices.push(index);
    } else {
      for (let index = activeIndex + 1; index < entries.length && indices.length < 12; index++) indices.push(index);
    }
    if (!indices.length) {
      menu.addItem((item) =>
        item.setTitle(direction < 0 ? t("No back history") : t("No forward history")).setDisabled(true),
      );
      return;
    }
    for (const index of indices) {
      const entry = entries[index] ?? {};
      const url = typeof entry.url === "string" ? entry.url : "";
      const title = typeof entry.title === "string" && entry.title ? entry.title : url || "Web page";
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon("globe")
          .onClick(() => {
            this.pendingHistoryIntent = direction < 0 ? "back" : "forward";
            this.navigationHistoryAdapter.goToIndex(webview, index);
          }),
      );
    }
  }

  private showAddressMenu(event: MouseEvent): void {
    const menu = new Menu();
    const start = this.addressEl.selectionStart ?? 0;
    const end = this.addressEl.selectionEnd ?? start;
    const selectionStart = Math.min(start, end);
    const selectionEnd = Math.max(start, end);
    const rawSelected = this.addressEl.value.slice(selectionStart, selectionEnd);
    const selected = rawSelected.trim();
    const hasSelection = selectionEnd > selectionStart;

    menu.addItem((item) =>
      item
        .setTitle(t("Cut"))
        .setDisabled(!hasSelection)
        .onClick(async () => {
          if (!hasSelection) return;
          await navigator.clipboard.writeText(rawSelected);
          this.replaceAddressSelection("");
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Copy"))
        .setDisabled(!hasSelection)
        .onClick(() => {
          if (!hasSelection) return;
          void navigator.clipboard.writeText(rawSelected);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Paste"))
        .onClick(async () => {
          const value = await navigator.clipboard.readText();
          this.replaceAddressSelection(value);
        }),
    );
    menu.addItem((item) =>
      item.setTitle(t("Paste and go")).onClick(async () => {
        const value = await navigator.clipboard.readText();
        if (value) this.navigate(this.normalizeAddress(value));
      }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Delete"))
        .setDisabled(!hasSelection)
        .onClick(() => this.replaceAddressSelection("")),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Select all"))
        .onClick(() => {
          this.addressEl.focus();
          this.addressEl.select();
        }),
    );
    menu.addSeparator();
    if (selected) {
      menu.addItem((item) =>
        item
          .setTitle("Search “" + selected.slice(0, 40) + (selected.length > 40 ? "…" : "") + "”")
          .setIcon("search")
          .onClick(() => this.navigate(this.plugin.core.searchUrl(selected))),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(t("Copy URL"))
        .setIcon("copy")
        .onClick(() => void navigator.clipboard.writeText(this.currentUrlValue)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Copy page title and URL"))
        .onClick(() =>
          void navigator.clipboard.writeText(this.currentTitle + "\n" + this.currentUrlValue),
        ),
    );
    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem((item) =>
        item
          .setTitle(t("Bookmark page"))
          .setIcon("bookmark")
          .onClick(() => this.bookmarkCurrentPage()),
      );
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem((item) =>
          item
            .setTitle("Open current URL in " + container.name)
            .setIcon("box")
            .onClick(() => {
              void this.plugin.openBrowser({ url: this.currentUrlValue, containerId: container.id });
            }),
        );
      }
      menu.addItem((item) =>
        item
          .setTitle(t("History for this site"))
          .setIcon("history")
          .onClick(() => {
            let origin = "";
            try {
              origin = new URL(this.currentUrlValue).hostname;
            } catch {
              origin = "";
            }
            this.showInternal("history");
            window.requestAnimationFrame(() => {
              if (!this.historySearchEl) return;
              this.historySearchEl.value = origin;
              this.historySearchEl.dispatchEvent(new Event("input"));
              this.historySearchEl.focus();
            });
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("Clear"))
        .setIcon("x")
        .onClick(() => {
          this.addressEl.value = "";
          this.addressEl.focus();
        }),
    );
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }

  private replaceAddressSelection(value: string): void {
    const start = this.addressEl.selectionStart ?? this.addressEl.value.length;
    const end = this.addressEl.selectionEnd ?? start;
    this.addressEl.setRangeText(value, Math.min(start, end), Math.max(start, end), "end");
    this.addressEl.focus();
    this.addressEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private pushTransient(entry: BrowserTransientHistoryEntry): void {
    const current = this.transientHistory[this.transientIndex];
    if (current?.kind === entry.kind && current.url === entry.url) {
      if (current.kind === "web" && entry.kind === "web") {
        current.webIndex = entry.webIndex;
        current.title = entry.title ?? current.title;
      }
      this.refreshNavigationButtons();
      return;
    }
    this.transientHistory = this.transientHistory.slice(0, this.transientIndex + 1);
    this.transientHistory.push(entry);
    this.transientIndex = this.transientHistory.length - 1;
    this.refreshNavigationButtons();
  }

  private traverseTransient(delta: -1 | 1): boolean {
    const targetIndex = this.transientIndex + delta;
    return this.goToTransientIndex(targetIndex);
  }

  private goToTransientIndex(targetIndex: number): boolean {
    if (targetIndex < 0 || targetIndex >= this.transientHistory.length) return false;
    const previousIndex = this.transientIndex;
    if (targetIndex === previousIndex) return true;
    const delta: -1 | 1 = targetIndex < previousIndex ? -1 : 1;
    const distance = Math.abs(targetIndex - previousIndex);
    const target = this.transientHistory[targetIndex];
    if (!target) return false;
    this.transientIndex = targetIndex;
    this.refreshNavigationButtons();

    if (target.kind === "internal") {
      this.pendingTransientTraversalIndex = null;
      this.showInternal(target.surface, false);
      return true;
    }

    this.internalSurface = null;
    this.currentUrlValue = target.url;
    this.currentTitle = target.title || (this.webview ? this.safeWebviewTitle(this.webview) : undefined) || target.url;
    this.addressEl.value = target.url;
    this.internalLayerEl.addClass("is-hidden");
    this.webLayerEl.removeClass("is-hidden");
    this.refreshLeafHeader();
    if (!this.webview) {
      this.pendingTransientTraversalIndex = targetIndex;
      this.ensureWebview(target.url);
      return true;
    }

    const webview = this.readyWebview();
    if (!webview) {
      this.pendingTransientTraversalIndex = targetIndex;
      this.webview.src = target.url;
      return true;
    }

    const currentWebIndex = this.navigationHistoryAdapter.activeIndex(webview);
    if (
      typeof target.webIndex === "number" &&
      currentWebIndex !== target.webIndex &&
      this.navigationHistoryAdapter.goToIndex(webview, target.webIndex)
    ) {
      this.pendingHistoryIntent = delta < 0 ? "back" : "forward";
      this.pendingTransientTraversalIndex = targetIndex;
      return true;
    }

    const liveUrl = this.safeWebviewUrl(webview);
    if (liveUrl === target.url) {
      this.pendingTransientTraversalIndex = null;
      return true;
    }

    this.pendingHistoryIntent = delta < 0 ? "back" : "forward";
    this.pendingTransientTraversalIndex = targetIndex;
    if (distance === 1 && delta < 0 && this.safeCanGoBack(webview)) webview.goBack?.();
    else if (distance === 1 && delta > 0 && this.safeCanGoForward(webview)) webview.goForward?.();
    else if (webview.loadURL) void webview.loadURL(target.url);
    else webview.src = target.url;
    return true;
  }

  private readyWebview(): WebviewElement | null {
    return this.isReadyWebview(this.webview) ? this.webview : null;
  }

  private isReadyWebview(webview: WebviewElement | null | undefined): webview is WebviewElement {
    return Boolean(
      webview &&
      webview === this.webview &&
      this.webviewDomReady &&
      webview.isConnected,
    );
  }

  private safeWebviewUrl(webview: WebviewElement): string | undefined {
    if (!this.isReadyWebview(webview)) return undefined;
    try {
      return webview.getURL?.();
    } catch {
      return undefined;
    }
  }

  private safeWebviewTitle(webview: WebviewElement): string | undefined {
    if (!this.isReadyWebview(webview)) return undefined;
    try {
      return webview.getTitle?.();
    } catch {
      return undefined;
    }
  }

  private safeCanGoBack(webview: WebviewElement): boolean {
    if (!this.isReadyWebview(webview)) return false;
    try {
      return Boolean(webview.canGoBack?.());
    } catch {
      return false;
    }
  }

  private safeCanGoForward(webview: WebviewElement): boolean {
    if (!this.isReadyWebview(webview)) return false;
    try {
      return Boolean(webview.canGoForward?.());
    } catch {
      return false;
    }
  }

  private refreshNavigationButtons(): void {
    const backDisabled = !this.canGoBack();
    const forwardDisabled = !this.canGoForward();
    if (this.backButtonEl) {
      this.backButtonEl.disabled = backDisabled;
      this.backButtonEl.setAttribute("aria-disabled", String(backDisabled));
    }
    if (this.forwardButtonEl) {
      this.forwardButtonEl.disabled = forwardDisabled;
      this.forwardButtonEl.setAttribute("aria-disabled", String(forwardDisabled));
    }
  }

  private normalizeAddress(value: string): string {
    return normalizeBrowserAddress(value, (query) => this.plugin.core.searchUrl(query));
  }
}

function webOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function internalSurfaceLabel(url: string | undefined): string | undefined {
  if (!url?.startsWith("browser://")) return undefined;
  const surface = url.slice("browser://".length).split(/[/?#]/, 1)[0] || "home";
  if (surface === "history") return "History";
  if (surface === "bookmarks") return "Bookmarks";
  if (surface === "home") return "Home";
  return "Browser Core";
}

function residualLabel(kind: "reload" | "redirect" | "in-page" | "other"): string {
  if (kind === "reload") return "Reload";
  if (kind === "redirect") return "Redirect";
  if (kind === "in-page") return "In-page navigation";
  return "Browser event";
}

function validSavedFavicon(value: unknown): string | undefined {
  return typeof value === "string" && value.length < 350000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value) ? value : undefined;
}
