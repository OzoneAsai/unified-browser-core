import { Menu, Notice, Plugin, type App, type WorkspaceLeaf } from "obsidian";
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
import type {
  BookmarkEntry,
  BrowserCoreState,
  BrowserLeafViewState,
  BrowserSessionCheckpoint,
  ContainerId,
  NavigationNode,
  PermissionDecision,
} from "./core/model";
import { cloneSessionCheckpoint, pendingSessionLeaves } from "./core/session-restore";
import { resolveTabLayoutPolicy } from "./tabs/tab-layout-policy";
import { BrowserSettingTab } from "./settings/settings-tab";
import { BROWSER_VIEW_TYPE, BrowserView } from "./ui/browser-view";
import { promptPermission } from "./ui/permission-prompt";
import { TabSearchModal } from "./ui/tab-search-modal";
import { HybridBrowserPersistence } from "./persistence/hybrid-persistence";
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
  webViewerBookmarksAdapter!: WebViewerBookmarksAdapter;
  private persistence!: HybridBrowserPersistence;
  private unloading = false;
  private sessionCheckpointTimer: number | undefined;
  private sessionCheckpointArmed = false;
  private layoutInitializationInProgress = false;
  private homeTakeoverArmed = false;
  private replacingEmptyLeaf = false;
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
    this.addRibbonIcon("globe", "Open browser", () => this.openBrowser());

    this.addCommand({
      id: "open-browser",
      name: "Open browser",
      callback: () => this.openBrowser(),
    });
    this.addCommand({
      id: "open-history",
      name: "Open browser history",
      callback: () => this.openBrowser({ url: "browser://history" }),
    });
    this.addCommand({
      id: "open-bookmarks",
      name: "Open browser bookmarks",
      callback: () => this.openBrowser({ url: "browser://bookmarks" }),
    });
    this.addCommand({
      id: "import-obsidian-bookmarks",
      name: "Import web bookmarks from Obsidian Bookmarks",
      callback: () => void this.importObsidianBookmarks(),
    });
    this.addCommand({
      id: "import-webviewer-bookmarks",
      name: "Import bookmarks from Web viewer Bookmarks",
      callback: () => void this.importWebViewerBookmarks(),
    });
    this.addCommand({
      id: "reopen-closed-tab",
      name: "Reopen last closed browser tab",
      callback: () => {
        const closed = this.core.history.recentlyClosed(1)[0];
        if (closed) void this.restoreLeaf(closed.id);
        else new Notice("No recently closed browser tab.");
      },
    });
    this.addCommand({
      id: "search-browser-tabs",
      name: "Search browser tabs",
      callback: () => this.openBrowserTabSearch(),
    });
    this.addCommand({
      id: "next-browser-tab",
      name: "Next browser tab",
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(1);
        return true;
      },
    });
    this.addCommand({
      id: "previous-browser-tab",
      name: "Previous browser tab",
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(-1);
        return true;
      },
    });
    this.addCommand({
      id: "close-browser-tab",
      name: "Close current browser tab",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (!(leaf?.view instanceof BrowserView)) return false;
        if (!checking) leaf.detach();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-in",
      name: "Browser zoom in",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomIn();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-out",
      name: "Browser zoom out",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomOut();
        return true;
      },
    });
    this.addCommand({
      id: "browser-zoom-reset",
      name: "Reset browser zoom for site",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.resetZoom();
        return true;
      },
    });
    this.addCommand({
      id: "browser-focus-address",
      name: "Focus browser address bar",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusAddressBar();
        return true;
      },
    });
    this.addCommand({
      id: "browser-back",
      name: "Browser back",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goBack();
        return true;
      },
    });
    this.addCommand({
      id: "browser-forward",
      name: "Browser forward",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goForward();
        return true;
      },
    });
    this.addCommand({
      id: "browser-reload",
      name: "Reload browser page",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.reload();
        return true;
      },
    });
    this.addCommand({
      id: "browser-bookmark-page",
      name: "Bookmark current browser page",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.bookmarkCurrentPage();
        return true;
      },
    });
    this.addCommand({
      id: "browser-container-picker",
      name: "Open browser container picker",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.openContainerPicker();
        return true;
      },
    });
    this.addCommand({
      id: "browser-search-history",
      name: "Search browser history",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusHistorySearch();
        return true;
      },
    });
    this.addCommand({
      id: "restore-browser-session",
      name: "Restore previous browser session",
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
      new Notice("This tab has no restorable URL.");
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
      new Notice("Close or reopen tabs using this container before deleting it.");
      return false;
    }

    this.permissionAdapter.release(containerId);
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new Notice("Could not clear this container's browsing data, so the container was not deleted.");
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.formRecovery.clearContainer(containerId);
    const removed = this.core.containers.remove(containerId);
    if (removed) {
      this.core.scheduleSave();
      new Notice(`Deleted container “${container.name}” and cleared its browsing data.`);
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
      new Notice(`Could not clear browsing data for “${container.name}”.`);
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.scheduleSave();
    new Notice(`Cleared browsing data and saved permissions for “${container.name}”.`);
    return true;
  }

  captureSessionCheckpoint(): void {
    const leaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      return [{
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
      if (notify) new Notice("No previous browser session is available.");
      return;
    }
    const leavesToRestore = this.pendingPreviousSessionLeaves();
    if (!leavesToRestore.length) {
      if (notify) new Notice("The previous browser session is already restored.");
      return;
    }
    for (const saved of leavesToRestore) {
      const leaf = await this.openBrowser({
        url: saved.url,
        containerId: saved.containerId,
        restoredFromLeafId: saved.sourceLifecycleId,
        state: {
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
    if (notify) new Notice(`Restored ${leavesToRestore.length} browser tab(s).`);
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
      if (view instanceof BrowserView) view.renderFavoritesBar();
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
      new Notice("Open Obsidian Settings → Community plugins → Unified Browser Core.");
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
      if (notify) new Notice("Obsidian Bookmarks is unavailable or has no readable bookmark data.");
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

  async importWebViewerBookmarks(notify = true): Promise<{
    available: boolean;
    added: number;
    reused: number;
    skippedInvalid: number;
  }> {
    const snapshot = await this.webViewerBookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new Notice("Web viewer Bookmarks has no readable data in this vault.");
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
      new Notice("Obsidian Quick Switcher is not available.");
    }
  }

  private showTabStripMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("New browser tab").setIcon("plus").onClick(() => void this.openBrowser()));
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
        .setTitle("Reopen closed tab")
        .setIcon("rotate-ccw")
        .setDisabled(!closed)
        .onClick(() => { if (closed) void this.restoreLeaf(closed.id); }),
    );
    menu.addItem((item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => this.openBrowserTabSearch()));
    menu.addItem((item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => this.openQuickSwitcher()));
    const active = this.activeBrowserView();
    menu.addItem((item) =>
      item
        .setTitle("Bookmark all open browser tabs")
        .setIcon("book-marked")
        .setDisabled(!active)
        .onClick(() => active?.bookmarkAllOpenTabs()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Restore previous browser session")
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
