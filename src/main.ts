import { Menu, Notice, Plugin, getLanguage, type App, type WorkspaceLeaf } from "obsidian";
import { ElectronPermissionAdapter } from "./adapters/electron-permissions";
import { ElectronSessionDataAdapter } from "./adapters/electron-session-data";
import { ElectronWindowOpenAdapter } from "./adapters/electron-window-open";
import { ElectronContextMenuAdapter } from "./adapters/electron-context-menu";
import { ManagedWebviewBackend } from "./adapters/managed-webview-backend";
import { ObsidianTabStripAdapter } from "./adapters/obsidian-tab-strip";
import { ObsidianSettingsAdapter } from "./adapters/obsidian-settings";
import { ObsidianHomeAdapter } from "./adapters/obsidian-home";
import { ObsidianBookmarksAdapter } from "./adapters/obsidian-bookmarks";
import { WebViewerBookmarksAdapter } from "./adapters/webviewer-bookmarks";
import { SurfingMigrationAdapter, normalizeSurfingBookmarks, surfingFolderPaths, surfingSearchTemplate } from "./adapters/surfing-migration";
import { ObsidianCommandAdapter } from "./adapters/obsidian-commands";
import {
  BrowserPublicApi,
  type BrowserOpenDisposition,
  type BrowserCapabilitySnapshot,
  type BrowserBookmarkSnapshot,
  type BrowserHistoryEntrySnapshot,
  type BrowserOpenOptions,
  type BrowserTabSnapshot,
} from "./api/browser-api";
import { BrowserCore } from "./core/browser-core";
import { createId } from "./core/id";
import { t, setLanguage, setLocaleResolver } from "./i18n";
import type {
  BookmarkEntry,
  BrowserCoreState,
  BrowserLeafViewState,
  BrowserSessionCheckpoint,
  ContainerId,
  NavigationNode,
  HistoryGraphState,
  PermissionDecision,
} from "./core/model";
import { cloneSessionCheckpoint, pendingSessionLeaves } from "./core/session-restore";
import { resolveTabLayoutPolicy } from "./tabs/tab-layout-policy";
import { BrowserSettingTab } from "./settings/settings-tab";
import { BROWSER_VIEW_TYPE, BrowserView } from "./ui/browser-view";
import { promptPermission } from "./ui/permission-prompt";
import { confirmAction } from "./ui/confirm-modal";
import { TabSearchModal } from "./ui/tab-search-modal";
import { HybridBrowserPersistence, type HistoryVersionSummary } from "./persistence/hybrid-persistence";
import type { WebviewElement } from "./ui/webview-types";

export interface BrowserOpenRequest {
  url?: string;
  containerId?: ContainerId;
  restoredFromLeafId?: string;
  state?: Partial<BrowserLeafViewState>;
  reveal?: boolean;
  placement?: "tab" | "window";
}

export default class UnifiedBrowserCorePlugin extends Plugin {
  core!: BrowserCore;
  api!: BrowserPublicApi;
  readonly permissionAdapter = new ElectronPermissionAdapter();
  readonly sessionDataAdapter = new ElectronSessionDataAdapter();
  readonly windowOpenAdapter = new ElectronWindowOpenAdapter();
  readonly contextMenuAdapter = new ElectronContextMenuAdapter();
  readonly managedWebviewBackend = new ManagedWebviewBackend();
  readonly tabStripAdapter = new ObsidianTabStripAdapter();
  readonly settingsAdapter = new ObsidianSettingsAdapter();
  readonly commandAdapter = new ObsidianCommandAdapter();
  homeAdapter!: ObsidianHomeAdapter;
  bookmarksAdapter!: ObsidianBookmarksAdapter;
  surfingMigrationAdapter!: SurfingMigrationAdapter;
  webViewerBookmarksAdapter!: WebViewerBookmarksAdapter;
  private persistence!: HybridBrowserPersistence;
  private unloading = false;
  private sessionCheckpointTimer: number | undefined;
  private sessionCheckpointArmed = false;
  private layoutInitializationInProgress = false;
  private homeTakeoverArmed = false;
  private replacingEmptyLeaf = false;
  private surfingMigrationRunning = false;
  private previousSessionCheckpoint: BrowserSessionCheckpoint = { capturedAt: 0, leaves: [] };

  getPublicApi(): BrowserPublicApi {
    return this.api;
  }

  isUnloading(): boolean {
    return this.unloading;
  }

  runtimeDiagnostics(): {
    browserLeaves: number;
    liveGuests: number;
    auxiliaryWindows: number;
    permissionSessions: number;
  } {
    return {
      browserLeaves: this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).length,
      liveGuests: this.managedWebviewBackend.activeGuestCount(),
      auxiliaryWindows: this.windowOpenAdapter.activeAuxiliaryWindowCount(),
      permissionSessions: this.permissionAdapter.boundSessionCount(),
    };
  }

  scheduleSessionCheckpoint(delayMs = 250): void {
    if (this.unloading || !this.sessionCheckpointArmed) return;
    if (this.sessionCheckpointTimer !== undefined) {
      window.clearTimeout(this.sessionCheckpointTimer);
    }
    this.sessionCheckpointTimer = window.setTimeout(() => {
      this.sessionCheckpointTimer = undefined;
      if (this.unloading) return;
      this.captureSessionCheckpoint();
    }, delayMs);
  }

  async onload(): Promise<void> {
    this.homeAdapter = new ObsidianHomeAdapter(this.app);
    this.bookmarksAdapter = new ObsidianBookmarksAdapter(this.app);
    this.webViewerBookmarksAdapter = new WebViewerBookmarksAdapter(this.app);
    this.surfingMigrationAdapter = new SurfingMigrationAdapter(this.app);
    this.registerDomEvent(window, "beforeunload", () => this.prepareForShutdown());
    this.register(() => this.prepareForShutdown());
    const persistenceScope = ((this.app as App & { appId?: string }).appId || this.app.vault.getName());
    this.persistence = new HybridBrowserPersistence(
      persistenceScope,
      {
        load: async () => (await this.loadData()) as Partial<BrowserCoreState> | null,
        save: async (value) => this.saveData(value),
      },
    );
    const raw = await this.persistence.load();
    const state = BrowserCore.normalize(raw);
    await this.persistence.captureHistoryVersion(state.history);
    setLocaleResolver(getLanguage);
    setLanguage(state.settings.language);
    this.core = new BrowserCore(
      this.app,
      state,
      { save: async (next) => this.persistence.save(next) },
      persistenceScope,
    );
    if ((raw?.version ?? 0) !== state.version) this.core.scheduleSave();
    this.previousSessionCheckpoint = cloneSessionCheckpoint(this.core.state.sessionCheckpoint);
    this.api = new BrowserPublicApi(
      {
        open: (url, options) => this.openFromApi(url, options),
        search: (query, options) => this.openFromApi(this.core.searchUrl(query), options),
        tabs: () => this.browserTabSnapshots(),
        activateTab: (id) => this.activateBrowserTab(id),
        closeTab: (id) => this.closeBrowserTab(id),
        containers: () => this.core.containers.list().map((container) => ({
          id: container.id,
          name: container.name,
          color: container.color,
          icon: container.icon,
        })),
        capabilities: () => this.browserCapabilities(),
        bookmarks: (query) => this.browserBookmarkSnapshots(query),
        addBookmark: (input) => {
          const bookmark = this.core.bookmarks.addBookmark({
            title: input.title?.trim() || input.url,
            url: input.url,
            parentId: input.parentId,
            favorite: input.favorite,
            visualKind: input.visualKind,
            visualValue: input.visualValue,
            faviconUrl: input.faviconUrl,
          });
          this.core.scheduleSave();
          this.refreshBrowserViews();
          return toBookmarkSnapshot(bookmark);
        },
        history: (query) => {
          const needle = query?.toLowerCase().trim();
          return this.core.history.allNodes().flatMap((node) => {
            if (node.kind !== "navigation") return [];
            if (!needle || node.title.toLowerCase().includes(needle) || node.url.toLowerCase().includes(needle)) {
              return [toHistorySnapshot(node)];
            }
            return [];
          });
        },
        restoreHistoryEntry: async (id, options) => {
          const node = this.core.state.history.nodes[id];
          if (!node || node.kind !== "navigation") return false;
          await this.restoreHistoryNode(node, options);
          return true;
        },
      },
      this.core.events,
    );
    this.core.sweepRetention();
    this.registerInterval(window.setInterval(() => this.core.sweepRetention(), 300_000));

    this.registerView(BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, this));
    this.addSettingTab(new BrowserSettingTab(this.app, this));
    this.addRibbonIcon("globe", t("Open browser"), () => this.openBrowser());

    this.addCommand({
      id: "open-browser",
      name: t("Open browser"),
      callback: () => this.openBrowser(),
    });
    this.addCommand({
      id: "open-history",
      name: t("Open browser history"),
      callback: () => this.openBrowser({ url: "browser://history" }),
    });
    this.addCommand({
      id: "open-bookmarks",
      name: t("Open browser bookmarks"),
      callback: () => this.openBrowser({ url: "browser://bookmarks" }),
    });
    this.addCommand({
      id: "import-obsidian-bookmarks",
      name: t("Import web bookmarks from Obsidian Bookmarks"),
      callback: () => void this.importObsidianBookmarks(),
    });
    this.addCommand({
      id: "import-webviewer-bookmarks",
      name: t("Import bookmarks from Web viewer Bookmarks"),
      callback: () => void this.importWebViewerBookmarks(),
    });
    this.addCommand({
      id: "migrate-from-surfing",
      name: t("Migrate browsing data from Surfing"),
      callback: () => void this.migrateFromSurfing(),
    });
    this.addCommand({
      id: "reopen-closed-tab",
      name: t("Reopen last closed browser tab"),
      callback: () => {
        const closed = this.core.history.recentlyClosed(1)[0];
        if (closed) void this.restoreLeaf(closed.id);
        else new Notice(t("No recently closed browser tab."));
      },
    });
    this.addCommand({
      id: "search-browser-tabs",
      name: t("Search browser tabs"),
      callback: () => this.openBrowserTabSearch(),
    });
    this.addCommand({
      id: "next-browser-tab",
      name: t("Next browser tab"),
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(1);
        return true;
      },
    });
    this.addCommand({
      id: "previous-browser-tab",
      name: t("Previous browser tab"),
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(-1);
        return true;
      },
    });
    this.addCommand({
      id: "close-browser-tab",
      name: t("Close current browser tab"),
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (!(leaf?.view instanceof BrowserView)) return false;
        if (!checking) leaf.detach();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-in",
      name: t("Browser zoom in"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomIn();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-out",
      name: t("Browser zoom out"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomOut();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-reset",
      name: t("Reset browser zoom for site"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.resetZoom();
        return true;
      },
    });
    this.addCommand({
      id: "browser-focus-address",
      name: t("Focus browser address bar"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusAddressBar();
        return true;
      },
    });
    this.addCommand({
      id: "browser-back",
      name: t("Browser back"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goBack();
        return true;
      },
    });
    this.addCommand({
      id: "browser-forward",
      name: t("Browser forward"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goForward();
        return true;
      },
    });
    this.addCommand({
      id: "browser-reload",
      name: t("Reload browser page"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.reload();
        return true;
      },
    });
    this.addCommand({
      id: "browser-bookmark-page",
      name: t("Bookmark current browser page"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.bookmarkCurrentPage();
        return true;
      },
    });
    this.addCommand({
      id: "browser-container-picker",
      name: t("Open browser container picker"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.openContainerPicker();
        return true;
      },
    });
    this.addCommand({
      id: "browser-search-history",
      name: t("Search browser history"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusHistorySearch();
        return true;
      },
    });
    this.addCommand({
      id: "restore-browser-session",
      name: t("Restore previous browser session"),
      callback: () => void this.restorePreviousSession(true),
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.sessionCheckpointArmed && this.app.workspace.layoutReady) {
          void this.initializeLayout();
        }
        if (this.ensureHomeTakeoverArmed()) void this.replaceMostRecentEmptyLeafWithHome();
        this.scheduleSessionCheckpoint();
        this.applyTabStyle();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.tabStripAdapter.revealActiveTab(leaf);
        if (this.ensureHomeTakeoverArmed() && leaf?.view.getViewType() === "empty") {
          void this.replaceEmptyLeafWithHome(leaf);
          return;
        }
        if (!(leaf?.view instanceof BrowserView)) return;
        this.core.history.touchLeaf(leaf.view.lifecycleIdentity(), {});
        if (leaf.view.currentInternalSurface() === "home") leaf.view.focusHomeSearch();
        this.core.scheduleSave();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        this.prepareForShutdown();
        tasks.addPromise(this.core.flush());
      }),
    );
    this.tabStripAdapter.bind(
      this,
      (strip) => {
        if (!this.core.settings().tabStripIntegrationEnabled) return false;
        const view = this.activeBrowserView();
        return Boolean(view && strip.closest(".workspace-tabs")?.contains(view.contentEl));
      },
      (event) => this.showTabStripMenu(event),
    );

    this.applyTabStyle();
    this.applyAccessibilityClasses();
    if (this.app.workspace.layoutReady) {
      this.homeTakeoverArmed = true;
      void this.initializeLayout();
    } else {
      this.app.workspace.onLayoutReady(() => {
        this.homeTakeoverArmed = true;
        void this.initializeLayout();
      });
    }
  }

  private async initializeLayout(): Promise<void> {
    if (this.sessionCheckpointArmed || this.layoutInitializationInProgress) return;
    this.layoutInitializationInProgress = true;
    try {
      const typedBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
      const usableBrowserLeaves = typedBrowserLeaves.filter((leaf) => leaf.view instanceof BrowserView);

      // During a plugin/renderer hot reload, leaves created by the previous
      // module can briefly retain the same view type while failing instanceof
      // against the new BrowserView constructor. Do not restore another copy
      // of the session on top of them. Their detach emits layout-change, which
      // re-enters initialization once the workspace has converged.
      if (typedBrowserLeaves.length !== usableBrowserLeaves.length) return;

      if (usableBrowserLeaves.length === 0) {
        const startup = this.core.settings().startupBehavior;
        if (startup === "restore" && this.core.state.sessionCheckpoint.leaves.length > 0) {
          await this.restorePreviousSession(false);
        } else if (startup === "home") {
          await this.openBrowser({ url: "browser://home" });
        }
      }
      await this.replaceMostRecentEmptyLeafWithHome();
      this.sessionCheckpointArmed = true;
      this.captureSessionCheckpoint();
      this.revealActiveTab();
    } finally {
      this.layoutInitializationInProgress = false;
    }
  }

  private ensureHomeTakeoverArmed(): boolean {
    if (!this.homeTakeoverArmed && this.app.workspace.layoutReady) {
      this.homeTakeoverArmed = true;
    }
    return this.homeTakeoverArmed;
  }

  private prepareForShutdown(): void {
    if (this.unloading) return;
    this.unloading = true;
    if (this.sessionCheckpointTimer !== undefined) {
      window.clearTimeout(this.sessionCheckpointTimer);
      this.sessionCheckpointTimer = undefined;
    }
    const liveBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    if (liveBrowserLeaves.length > 0) this.captureSessionCheckpoint();
  }

  async replaceMostRecentEmptyLeafWithHome(): Promise<boolean> {
    if (!this.core.settings().replaceEmptyTabsWithHome || this.replacingEmptyLeaf) return false;
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf ? this.replaceEmptyLeafWithHome(leaf) : false;
  }

  private async replaceEmptyLeafWithHome(leaf: WorkspaceLeaf): Promise<boolean> {
    if (
      !this.core.settings().replaceEmptyTabsWithHome ||
      this.replacingEmptyLeaf ||
      leaf.view.getViewType() !== "empty"
    ) return false;
    this.replacingEmptyLeaf = true;
    try {
      await leaf.setViewState({
        type: BROWSER_VIEW_TYPE,
        active: true,
        state: {
          url: "browser://home",
          containerId: this.core.settings().defaultContainerId,
        },
      });
      await this.app.workspace.revealLeaf(leaf);
      return true;
    } finally {
      this.replacingEmptyLeaf = false;
    }
  }

  async onunload(): Promise<void> {
    this.prepareForShutdown();
    await this.persistence.captureHistoryVersion(this.core.state.history);
    const liveBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    for (const leaf of liveBrowserLeaves) {
      if (!(leaf.view instanceof BrowserView)) continue;
      this.core.history.closeLeaf(leaf.view.lifecycleIdentity(), "shutdown");
    }
    this.core.sweepRetention();
    this.windowOpenAdapter.dispose();
    this.managedWebviewBackend.dispose();
    this.permissionAdapter.dispose();
    const remaining = this.runtimeDiagnostics();
    if (
      remaining.liveGuests !== 0 ||
      remaining.auxiliaryWindows !== 0 ||
      remaining.permissionSessions !== 0
    ) {
      console.warn("Unified Browser Core: runtime resources remained after disposal.", remaining);
    }
    this.core.events.clear();
    await this.core.flush();
  }

  async openBrowser(request: BrowserOpenRequest = {}): Promise<WorkspaceLeaf> {
    const {
      url = "browser://home",
      containerId,
      restoredFromLeafId,
      state: initialState = {},
      reveal = true,
      placement = "tab",
    } = request;
    const leaf = this.app.workspace.getLeaf(placement);
    const explicitContainerId =
      containerId && this.core.containers.find(containerId)
        ? containerId
        : undefined;
    const resolvedContainer = explicitContainerId
      ? this.core.normalizeContainer(explicitContainerId)
      : this.core.resolveContainerForNavigation(url, this.core.defaultContainerForNewTab());
    const bypassOrigin =
      initialState.siteAssignmentBypassOrigin ??
      (explicitContainerId
        ? this.core.containers.bypassOriginForExplicitContainer(url, resolvedContainer)
        : undefined);
    const bypassReason = bypassOrigin
      ? initialState.siteAssignmentBypassReason ?? "explicit"
      : undefined;
    await leaf.setViewState({
      type: BROWSER_VIEW_TYPE,
      active: reveal,
      state: {
        ...initialState,
        url,
        containerId: resolvedContainer,
        siteAssignmentBypassOrigin: bypassOrigin,
        siteAssignmentBypassReason: bypassReason,
        restoredFromLeafId,
      },
    });
    if (reveal) this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openFromOpener(
    url: string,
    containerId: ContainerId,
    disposition: BrowserOpenDisposition,
  ): Promise<void> {
    await this.openBrowser({
      url,
      containerId,
      state: { siteAssignmentBypassReason: "opener" },
      reveal: disposition !== "background",
      placement: disposition === "new-window" ? "window" : "tab",
    });
  }

  async restoreLeaf(
    oldLeafId: string,
    options: { containerId?: ContainerId; pinned?: boolean } = {},
  ): Promise<void> {
    const record = this.core.state.history.leaves[oldLeafId];
    if (!record?.lastUrl) {
      new Notice(t("This tab has no restorable URL."));
      return;
    }
    const pinned = options.pinned ?? record.pinned;
    const leaf = await this.openBrowser({
      url: record.lastUrl,
      containerId: options.containerId ?? record.containerId,
      restoredFromLeafId: oldLeafId,
      state: {
        pinned,
        manualRetention: record.manualRetention,
      },
    });
    leaf.setPinned(pinned);
  }

  async restoreHistoryNode(
    node: NavigationNode,
    options: { containerId?: ContainerId; pinned?: boolean } = {},
  ): Promise<void> {
    const pinned = options.pinned ?? false;
    const leaf = await this.openBrowser({
      url: node.url,
      containerId: options.containerId ?? node.containerId,
      restoredFromLeafId: node.leafId,
      state: {
        pinned,
        restoreTargetUrl: node.url,
        restoreTargetIndex: node.sessionEntryIndex,
      },
    });
    leaf.setPinned(pinned);
  }

  listSavedHistoryVersions(): Promise<HistoryVersionSummary[]> {
    return this.persistence.listHistoryVersions();
  }

  loadSavedHistoryVersion(id: string): Promise<HistoryGraphState | null> {
    return this.persistence.loadHistoryVersion(id);
  }

  async restoreSavedHistoryNode(
    versionId: string,
    nodeId: string,
    options: { containerId?: ContainerId; pinned?: boolean } = {},
  ): Promise<boolean> {
    const history = await this.persistence.loadHistoryVersion(versionId);
    const node = history?.nodes[nodeId];
    if (!node || node.kind !== "navigation") return false;
    await this.restoreHistoryNode(node, options);
    return true;
  }

  async restoreSavedHistoryLeaf(
    versionId: string,
    leafId: string,
    options: { containerId?: ContainerId; pinned?: boolean } = {},
  ): Promise<boolean> {
    const history = await this.persistence.loadHistoryVersion(versionId);
    if (!history) return false;
    const record = history.leaves[leafId];
    const currentId = history.currentByLeaf[leafId];
    const current = currentId ? history.nodes[currentId] : undefined;
    const latest = Object.values(history.nodes)
      .filter((node): node is NavigationNode => node.kind === "navigation" && node.leafId === leafId)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const node = current?.kind === "navigation" ? current : latest;
    const url = node?.url ?? record?.lastUrl;
    if (!url) return false;
    const pinned = options.pinned ?? record?.pinned ?? false;
    const leaf = await this.openBrowser({
      url,
      containerId: options.containerId ?? node?.containerId ?? record?.containerId,
      state: {
        pinned,
        restoreTargetUrl: node?.url,
        restoreTargetIndex: node?.sessionEntryIndex,
      },
    });
    leaf.setPinned(pinned);
    return true;
  }

  async requestPermission(origin: string, permission: string): Promise<PermissionDecision> {
    return promptPermission(this.app, origin, permission);
  }

  bindPermissions(webview: WebviewElement, containerId: ContainerId): boolean {
    return this.permissionAdapter.bind(
      webview,
      containerId,
      this.core.permissions,
      (origin, permission) => this.requestPermission(origin, permission),
      () => this.core.scheduleSave(),
    );
  }

  async deleteContainer(containerId: ContainerId): Promise<boolean> {
    if (containerId === "default") return false;
    const container = this.core.containers.find(containerId);
    if (!container) return false;
    const hasLiveLeaf = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).some((leaf) => {
      return leaf.view instanceof BrowserView && leaf.view.getState().containerId === containerId;
    });
    if (hasLiveLeaf) {
      new Notice(t("Close or reopen tabs using this container before deleting it."));
      return false;
    }

    this.permissionAdapter.release(containerId);
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new Notice(t("Could not clear this container's browsing data, so the container was not deleted."));
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.formRecovery.clearContainer(containerId);
    const removed = this.core.containers.remove(containerId);
    if (removed) {
      this.core.scheduleSave();
      new Notice(t("Deleted container “{v0}” and cleared its browsing data.", { v0: container.name }));
    }
    return removed;
  }

  clearBrowserHistory(): { nodes: number; leaves: number; restoreCapsules: number } {
    const cleared = this.core.history.clearAll();
    const restoreCapsules = this.core.restore.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (!(leaf.view instanceof BrowserView)) continue;
      const state = leaf.view.getState();
      this.core.history.beginLeaf({
        leafId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        pinned: state.pinned ?? false,
        manualRetention: state.manualRetention ?? "default",
        url: state.url || leaf.view.currentUrl(),
        title: leaf.view.getDisplayText(),
      });
      this.core.suppressRichRestoreForLeaf(state.lifecycleId || leaf.view.lifecycleIdentity());
    }
    this.captureSessionCheckpoint();
    this.core.scheduleSave();
    return { ...cleared, restoreCapsules };
  }

  clearRichRestoreData(): number {
    const count = this.core.restore.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (!(leaf.view instanceof BrowserView)) continue;
      this.core.suppressRichRestoreForLeaf(leaf.view.lifecycleIdentity());
    }
    this.core.scheduleSave();
    return count;
  }

  clearFormRecoveryData(): number {
    const count = this.core.formRecovery.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) void leaf.view.resetFormRecoveryCaptureBaseline();
    }
    this.core.scheduleSave();
    return count;
  }

  clearPermissionDecisions(): number {
    const count = this.core.permissions.clearAll();
    this.core.scheduleSave();
    return count;
  }

  async clearContainerSession(containerId: ContainerId): Promise<boolean> {
    const container = this.core.containers.find(containerId);
    if (!container) return false;
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new Notice(t("Could not clear browsing data for “{v0}”.", { v0: container.name }));
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.scheduleSave();
    new Notice(t("Cleared browsing data and saved permissions for “{v0}”.", { v0: container.name }));
    return true;
  }

  captureSessionCheckpoint(): void {
    const leaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      const state = leaf.view.getState() as BrowserLeafViewState;
      if (!(leaf.view instanceof BrowserView)) {
        const previous = this.core.state.sessionCheckpoint.leaves.find((saved) => saved.sourceLifecycleId === state.lifecycleId);
        if (!state.lifecycleId || !state.url) return previous ? [previous] : [];
        return [{ ...previous, ...state, sourceLifecycleId: state.lifecycleId, url: state.url,
          containerId: state.containerId || this.core.settings().defaultContainerId,
          pinned: state.pinned ?? false, manualRetention: state.manualRetention ?? "default" }];
      }
      return [{
        title: state.title,
        faviconDataUrl: state.faviconDataUrl,
        sourceLifecycleId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        url: state.url || leaf.view.currentUrl(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        siteAssignmentBypassOrigin: state.siteAssignmentBypassOrigin,
        siteAssignmentBypassReason: state.siteAssignmentBypassReason,
        pinned: state.pinned ?? false,
        manualRetention: state.manualRetention ?? "default",
        internalSurface: state.internalSurface,
        transientHistory: state.transientHistory,
        transientIndex: state.transientIndex,
      }];
    });
    this.core.setSessionCheckpoint({ capturedAt: Date.now(), leaves });
  }

  async restorePreviousSession(notify: boolean): Promise<void> {
    const checkpoint = this.previousSessionCheckpoint;
    if (!checkpoint.leaves.length) {
      if (notify) new Notice(t("No previous browser session is available."));
      return;
    }
    const leavesToRestore = this.pendingPreviousSessionLeaves();
    if (!leavesToRestore.length) {
      if (notify) new Notice(t("The previous browser session is already restored."));
      return;
    }
    for (const saved of leavesToRestore) {
      const leaf = await this.openBrowser({
        url: saved.url,
        containerId: saved.containerId,
        restoredFromLeafId: saved.sourceLifecycleId,
        state: {
          title: saved.title,
          faviconDataUrl: saved.faviconDataUrl,
          pinned: saved.pinned,
          manualRetention: saved.manualRetention,
          siteAssignmentBypassOrigin: saved.siteAssignmentBypassOrigin,
          siteAssignmentBypassReason: saved.siteAssignmentBypassReason,
          internalSurface: saved.internalSurface,
          transientHistory: saved.transientHistory,
          transientIndex: saved.transientIndex,
        },
      });
      leaf.setPinned(saved.pinned);
    }
    if (notify) new Notice(t("Restored {v0} browser tab(s).", { v0: leavesToRestore.length }));
  }

  private pendingPreviousSessionLeaves() {
    const liveRepresentations = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      return [{
        lifecycleId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        restoredFromLeafId: state.restoredFromLeafId,
      }];
    });
    return pendingSessionLeaves(this.previousSessionCheckpoint, liveRepresentations);
  }

  applyTabStyle(): void {
    const settings = this.core.settings();
    const policy = resolveTabLayoutPolicy(settings.tabStyle);
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      const state = leaf.view.getState() as BrowserLeafViewState;
      if (!(leaf.view instanceof BrowserView)) {
        const saved = this.core.state.history.leaves[state.lifecycleId ?? state.restoredFromLeafId ?? ""];
        const savedEntry = state.transientHistory?.[state.transientIndex ?? state.transientHistory.length - 1];
        const title = state.title || (savedEntry?.kind === "web" ? savedEntry.title : undefined) || saved?.lastTitle || state.url || t("Browser");
        this.tabStripAdapter.refreshLeafHeader(leaf, false, title);
        const favicon = typeof state.faviconDataUrl === "string" && state.faviconDataUrl.length < 350000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(state.faviconDataUrl) ? state.faviconDataUrl : undefined;
        this.tabStripAdapter.applyLeafFavicon(leaf, favicon);
        (leaf as typeof leaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl?.addClass("ubc-browser-tab-pending");
      }
      const container = settings.containerMode !== "off" && state.containerId
        ? this.core.containers.find(state.containerId)
        : undefined;
      this.tabStripAdapter.applyLeafStyle(
        leaf,
        policy,
        settings.tabStripIntegrationEnabled,
        Boolean(state.pinned),
        container?.color,
      );
    }
    // Clean stale classes left by older releases from every pane, including
    // native sidebars and panes that no longer contain a browser view.
    this.tabStripAdapter.refreshAllStrips(this.app.workspace);
    this.revealActiveTab();
  }

  private revealActiveTab(): void {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf) this.tabStripAdapter.revealActiveTab(leaf);
  }

  refreshLoadingShields(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshLoadingShield();
    }
  }

  applyAccessibilityClasses(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.applyAccessibility();
    }
  }

  refreshBrowserViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrowserView) { view.renderFavoritesBar(); view.refreshRecoveryNotification(); }
    }
  }

  refreshBrowserZoom(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshZoom();
    }
  }

  refreshContainerPresentation(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshContainerPresentation();
    }
  }

  refreshFormRecoveryInstrumentation(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) void leaf.view.syncFormRecoveryInstrumentation();
    }
  }

  openSettings(): void {
    if (!this.settingsAdapter.openPluginSettings(this.app, this.manifest.id)) {
      new Notice(t("Open Obsidian Settings → Community plugins → Unified Browser Core."));
    }
  }

  async importObsidianBookmarks(notify = true): Promise<{
    available: boolean;
    added: number;
    reused: number;
    foldersCreated: number;
    skippedNonWeb: number;
  }> {
    const snapshot = await this.bookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new Notice(t("Obsidian Bookmarks is unavailable or has no readable bookmark data."));
      return { available: false, added: 0, reused: 0, foldersCreated: 0, skippedNonWeb: 0 };
    }

    const imported = this.core.bookmarks.importWebBookmarks(snapshot.entries);
    if (imported.added || imported.foldersCreated) {
      this.core.scheduleSave();
      this.refreshBrowserViews();
    }
    if (notify) {
      const parts = [
        imported.added ? `Imported ${imported.added} web bookmark${imported.added === 1 ? "" : "s"}` : "No new web bookmarks",
        imported.reused ? `${imported.reused} already present` : "",
        imported.foldersCreated ? `${imported.foldersCreated} folder${imported.foldersCreated === 1 ? "" : "s"} created` : "",
        snapshot.skippedNonWeb ? `${snapshot.skippedNonWeb} non-web item${snapshot.skippedNonWeb === 1 ? "" : "s"} left in Obsidian Bookmarks` : "",
      ].filter(Boolean);
      new Notice(parts.join(" · "));
    }
    return { available: true, ...imported, skippedNonWeb: snapshot.skippedNonWeb };
  }

  refreshLanguage(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshLanguage();
    }
  }

  async importWebViewerBookmarks(notify = true): Promise<{
    available: boolean;
    added: number;
    reused: number;
    skippedInvalid: number;
  }> {
    const snapshot = await this.webViewerBookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new Notice(t("Web viewer Bookmarks has no readable data in this vault."));
      return { available: false, added: 0, reused: 0, skippedInvalid: 0 };
    }

    const imported = this.core.bookmarks.importWebBookmarks(snapshot.entries);
    if (imported.added) {
      this.core.scheduleSave();
      this.refreshBrowserViews();
    }
    if (notify) {
      const parts = [
        imported.added ? `Imported ${imported.added} bookmark${imported.added === 1 ? "" : "s"}` : "No new bookmarks",
        imported.reused ? `${imported.reused} already present` : "",
        snapshot.skippedInvalid ? `${snapshot.skippedInvalid} invalid item${snapshot.skippedInvalid === 1 ? "" : "s"} skipped` : "",
      ].filter(Boolean);
      new Notice(parts.join(" · "));
    }
    return { available: true, added: imported.added, reused: imported.reused, skippedInvalid: snapshot.skippedInvalid };
  }

  async migrateFromSurfing(): Promise<void> {
    if (this.surfingMigrationRunning) return;
    this.surfingMigrationRunning = true;
    try {
      const previous = this.core.state.surfingMigration;
      if (previous?.completedAt) {
        new Notice(t("Surfing migration already completed. Backup: {v0}", { v0: previous.backupPath }));
        return;
      }
      const snapshot = previous ? null : await this.surfingMigrationAdapter.scan();
      if (snapshot && !snapshot.settingsFound && !snapshot.bookmarksFound && snapshot.tabs.length === 0) {
        new Notice(t("No Surfing data was found in this vault. Run migration before uninstalling Surfing."));
        return;
      }
      if (snapshot && (snapshot.settingsFound && !snapshot.settings || snapshot.bookmarksFound && !snapshot.bookmarksValid)) {
        new Notice(t("Surfing data could not be read safely. No changes were made."));
        return;
      }
      const tabs = previous?.tabs ?? snapshot?.tabs ?? [];
      const message = previous
        ? `Resume the interrupted Surfing migration? ${tabs.length - previous.completedTabKeys.length} tab(s) remain.`
        : `Adopt Surfing's persistent browsing profile, import ${snapshot!.bookmarks.length} bookmark(s), ` +
          `apply compatible settings and open ${tabs.length} saved tab(s)? Browser Core will save a backup first. ` +
          `Surfing data will remain untouched.${snapshot!.warnings.length ? ` Warnings: ${snapshot!.warnings.join(" ")}` : ""}`;
      const confirmed = await confirmAction(this.app, t("Migrate from Surfing"), message, t("Migrate"));
      if (!confirmed) return;

      let record = previous;
      if (!record && snapshot) {
        const vault = this.app.vault as typeof this.app.vault & { configDir?: string };
        const configDir = vault.configDir || ".obsidian";
        const backupPath = `${configDir}/plugins/${this.manifest.id}/surfing-migration-backup-${Date.now()}.json`;
        await this.app.vault.adapter.write(backupPath, JSON.stringify({
          format: "ubc-surfing-migration-backup-v1",
          savedAt: Date.now(),
          ubcBeforeMigration: this.core.state,
          surfingSettings: snapshot.settings,
          surfingBookmarks: snapshot.bookmarksRaw,
          surfingTabs: snapshot.tabs,
          sourcePartition: snapshot.sourcePartition,
        }, null, 2));

        const container = this.core.containers.list().find((candidate) => candidate.partition === snapshot.sourcePartition)
          ?? this.core.containers.create("Surfing profile", "#8a75d6", "globe");
        container.partition = snapshot.sourcePartition;
        const previousDefaultContainerId = this.core.settings().defaultContainerId;
        record = {
          sourcePartition: snapshot.sourcePartition,
          surfingContainerId: container.id,
          previousDefaultContainerId,
          backupPath,
          startedAt: Date.now(),
          tabs,
          completedTabKeys: [],
          historyLeafIds: {},
          initialImportComplete: false,
          bookmarksAdded: 0,
          bookmarksReused: 0,
          settingsImported: false,
        };
        this.core.state.surfingMigration = record;
        await this.core.flush();
      }
      if (!record) throw new Error("Migration state was not initialized.");

      if (!record.initialImportComplete) {
        let settings = snapshot?.settings ?? null;
        let bookmarks = snapshot?.bookmarks ?? [];
        let folderPaths = snapshot?.folderPaths ?? [];
        if (!snapshot) {
          const backup = JSON.parse(await this.app.vault.adapter.read(record.backupPath)) as {
            surfingSettings: Record<string, unknown> | null;
            surfingBookmarks: unknown;
          };
          settings = backup.surfingSettings;
          const parsed = normalizeSurfingBookmarks(backup.surfingBookmarks);
          if (backup.surfingBookmarks != null && !parsed.valid) {
            throw new Error("The Surfing bookmark backup could not be read safely.");
          }
          bookmarks = parsed.entries;
          folderPaths = surfingFolderPaths(backup.surfingBookmarks);
        }
        const searchUrlTemplate = surfingSearchTemplate(settings);
        const bookmarkManager = settings?.bookmarkManager;
        this.core.updateSettings({
          defaultContainerId: record.surfingContainerId,
          homeSearchMode: "web",
          ...(searchUrlTemplate ? { searchUrlTemplate } : {}),
          ...(bookmarkManager && typeof bookmarkManager === "object" && "openBookMark" in bookmarkManager &&
            typeof bookmarkManager.openBookMark === "boolean"
            ? { showFavoritesBar: bookmarkManager.openBookMark } : {}),
        });
        for (const path of folderPaths) this.core.bookmarks.ensureFolderPath(path);
        const imported = this.core.bookmarks.importWebBookmarks(bookmarks);
        record.bookmarksAdded = imported.added;
        record.bookmarksReused = imported.reused;
        record.settingsImported = Boolean(settings);
        record.initialImportComplete = true;
        await this.core.flush();
      }

      for (const tab of record.tabs) {
        if (record.completedTabKeys.includes(tab.sourceKey)) continue;
        let historyLeafId = record.historyLeafIds[tab.sourceKey];
        if (!historyLeafId) {
          historyLeafId = createId("surfing-history");
          this.core.history.beginLeaf({
            leafId: historyLeafId,
            containerId: record.surfingContainerId,
            url: tab.history[0]?.url ?? tab.url,
            title: tab.title,
          });
          const importedNodes: string[] = [];
          for (const entry of tab.history) {
            if (entry.kind !== "web") continue;
            const node = this.core.history.addNavigation({
              leafId: historyLeafId,
              containerId: record.surfingContainerId,
              url: entry.url,
              title: entry.title,
            });
            importedNodes.push(node.id);
          }
          const activeNodeId = importedNodes[tab.historyIndex];
          if (activeNodeId) {
            this.core.state.history.currentByLeaf[historyLeafId] = activeNodeId;
            this.core.history.touchLeaf(historyLeafId, { lastUrl: tab.url, lastTitle: tab.title });
          }
          this.core.history.closeLeaf(historyLeafId, "replaced");
          record.historyLeafIds[tab.sourceKey] = historyLeafId;
          await this.core.flush();
        }
        const alreadyOpen = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).some((candidate) => {
          const state = candidate.getViewState().state as BrowserLeafViewState | undefined;
          return state?.restoredFromLeafId === historyLeafId && state.url === tab.url;
        });
        if (alreadyOpen) {
          record.completedTabKeys.push(tab.sourceKey);
          await this.core.flush();
          continue;
        }
        const leaf = await this.openBrowser({
          url: tab.url,
          containerId: record.surfingContainerId,
          restoredFromLeafId: historyLeafId,
          reveal: tab.active,
          state: { pinned: tab.pinned, transientHistory: tab.history, transientIndex: tab.historyIndex },
        });
        leaf.setPinned(tab.pinned);
        record.completedTabKeys.push(tab.sourceKey);
        await this.core.flush();
      }
      record.completedAt = Date.now();
      this.refreshBrowserViews();
      this.refreshContainerPresentation();
      if (this.sessionCheckpointArmed) this.captureSessionCheckpoint();
      await this.core.flush();
      new Notice(`Surfing migration complete: ${record.bookmarksAdded} bookmark(s) added, ` +
        `${record.tabs.length} tab(s) opened. Backup: ${record.backupPath}`, 12000);
    } catch (error) {
      console.error("Unified Browser Core: Surfing migration failed.", error);
      new Notice(t("Surfing migration stopped. Source data was not deleted; run the command again to resume."), 12000);
    } finally {
      this.surfingMigrationRunning = false;
    }
  }

  private async openFromApi(url: string, options: BrowserOpenOptions = {}): Promise<void> {
    const disposition = options.disposition ?? "new-tab";
    if (disposition === "current") {
      const current = this.activeBrowserView();
      if (current && (!options.containerId || current.getState().containerId === options.containerId)) {
        current.navigate(url);
        return;
      }
    }
    await this.openBrowser({
      url,
      containerId: options.containerId,
      reveal: disposition !== "background",
      placement: disposition === "new-window" ? "window" : "tab",
    });
  }

  private browserTabSnapshots(): BrowserTabSnapshot[] {
    const activeLeaf = this.app.workspace.activeLeaf;
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      const id = state.lifecycleId || leaf.view.lifecycleIdentity();
      return [{
        id,
        lifecycleId: id,
        title: leaf.view.getDisplayText(),
        url: leaf.view.currentUrl(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        pinned: state.pinned ?? false,
        active: leaf === activeLeaf,
      }];
    });
  }

  private browserBookmarkSnapshots(query?: string): BrowserBookmarkSnapshot[] {
    const entries = query ? this.core.bookmarks.search(query) : this.core.bookmarks.allBookmarks();
    return entries.map(toBookmarkSnapshot);
  }

  private async activateBrowserTab(id: string): Promise<boolean> {
    const leaf = this.browserLeafByLifecycleId(id);
    if (!leaf) return false;
    await this.app.workspace.revealLeaf(leaf);
    return true;
  }

  private closeBrowserTab(id: string): boolean {
    const leaf = this.browserLeafByLifecycleId(id);
    if (!leaf) return false;
    leaf.detach();
    return true;
  }

  private browserLeafByLifecycleId(id: string): WorkspaceLeaf | undefined {
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).find((leaf) => {
      return leaf.view instanceof BrowserView && leaf.view.lifecycleIdentity() === id;
    });
  }

  private browserCapabilities(): BrowserCapabilitySnapshot {
    return {
      apiVersion: 5,
      runtime: "managed-webview",
      isolatedContainers: true,
      siteContainerAssignments: true,
      graphHistory: true,
      richRestore: "best-effort",
      formRecovery: true,
      permissions: "best-effort",
      internalSurfaces: true,
      bookmarkVisuals: true,
      favorites: true,
    };
  }

  private cycleBrowserTab(delta: -1 | 1): void {
    const active = this.app.workspace.activeLeaf;
    const leaves = this.browserTabsInActiveGroup();
    if (leaves.length < 2) return;
    const index = active ? leaves.indexOf(active) : -1;
    if (index < 0) return;
    const target = leaves[(index + delta + leaves.length) % leaves.length];
    if (target) this.app.workspace.revealLeaf(target);
  }

  private browserTabsInActiveGroup(): WorkspaceLeaf[] {
    const active = this.app.workspace.activeLeaf;
    if (!(active?.view instanceof BrowserView)) return [];
    return this.tabStripAdapter
      .leavesInSameGroup(active)
      .filter((leaf) => leaf.view instanceof BrowserView);
  }

  openBrowserTabSearch(): void {
    new TabSearchModal(this.app, this).open();
  }

  openQuickSwitcher(): void {
    if (!this.commandAdapter.openQuickSwitcher(this.app)) {
      new Notice(t("Obsidian Quick Switcher is not available."));
    }
  }

  private showTabStripMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("New browser tab")).setIcon("plus").onClick(() => void this.openBrowser()));
    for (const container of this.core.containers.list()) {
      menu.addItem((item) =>
        item
          .setTitle("New tab in " + container.name)
          .setIcon("box")
          .onClick(() => void this.openBrowser({ url: "browser://home", containerId: container.id })),
      );
    }
    const closed = this.core.history.recentlyClosed(1)[0];
    menu.addItem((item) =>
      item
        .setTitle(t("Reopen closed tab"))
        .setIcon("rotate-ccw")
        .setDisabled(!closed)
        .onClick(() => { if (closed) void this.restoreLeaf(closed.id); }),
    );
    menu.addItem((item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => this.openBrowserTabSearch()));
    menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => this.openQuickSwitcher()));
    const active = this.activeBrowserView();
    menu.addItem((item) =>
      item
        .setTitle(t("Bookmark all open browser tabs"))
        .setIcon("book-marked")
        .setDisabled(!active)
        .onClick(() => active?.bookmarkAllOpenTabs()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("Restore previous browser session"))
        .setDisabled(this.pendingPreviousSessionLeaves().length === 0)
        .onClick(() => void this.restorePreviousSession(true)),
    );
    menu.addSeparator();
    for (const style of ["firefox", "chrome"] as const) {
      menu.addItem((item) =>
        item
          .setTitle("Tab style: " + (style === "firefox" ? "Firefox" : "Chrome"))
          .setChecked(this.core.settings().tabStyle === style)
          .onClick(() => {
            this.core.updateSettings({ tabStyle: style });
            this.applyTabStyle();
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private activeBrowserView(): BrowserView | undefined {
    const leaf = this.app.workspace.activeLeaf;
    return leaf?.view instanceof BrowserView ? leaf.view : undefined;
  }
}

function toBookmarkSnapshot(bookmark: BookmarkEntry): BrowserBookmarkSnapshot {
  return {
    id: bookmark.id,
    parentId: bookmark.parentId,
    title: bookmark.title,
    url: bookmark.url,
    favorite: bookmark.favorite,
    visualKind: bookmark.visualKind,
    visualValue: bookmark.visualValue,
    faviconUrl: bookmark.faviconUrl,
  };
}

function toHistorySnapshot(node: NavigationNode): BrowserHistoryEntrySnapshot {
  return {
    id: node.id,
    tabId: node.leafId,
    containerId: node.containerId,
    timestamp: node.timestamp,
    title: node.title,
    url: node.url,
  };
}
