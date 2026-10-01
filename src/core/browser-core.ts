import type { App } from "obsidian";
import { BookmarkStore, normalizeBookmarkUrl } from "../bookmarks/bookmark-store";
import { ContainerStore } from "../containers/container-store";
import { HistoryGraph } from "../history/history-graph";
import { FormRecoveryStore } from "./form-recovery-store";
import { BrowserEventBus } from "./events";
import { PermissionStore } from "./permission-store";
import { RestoreStore } from "./restore-store";
import { SiteZoomStore } from "./site-zoom-store";
import {
  DEFAULT_SETTINGS,
  EMPTY_BOOKMARKS,
  EMPTY_HISTORY,
  type BrowserCoreState,
  type BookmarkEntry,
  type BrowserSessionCheckpoint,
  type BrowserSettings,
  type ContainerId,
  type HistoryNodeId,
} from "./model";

export interface PersistencePort {
  save(state: BrowserCoreState): Promise<void>;
}

export class BrowserCore {
  readonly events: BrowserEventBus;
  readonly history: HistoryGraph;
  readonly bookmarks: BookmarkStore;
  readonly containers: ContainerStore;
  readonly restore: RestoreStore;
  readonly formRecovery: FormRecoveryStore;
  readonly permissions: PermissionStore;
  readonly zoom: SiteZoomStore;
  private saveTimer: number | undefined;

  constructor(
    readonly app: App,
    readonly state: BrowserCoreState,
    private readonly persistence: PersistencePort,
    partitionScope: string,
  ) {
    this.events = new BrowserEventBus();
    this.history = new HistoryGraph(state.history, this.events);
    this.bookmarks = new BookmarkStore(state.bookmarks, (event) => this.events.emit("bookmark-changed", event));
    this.containers = new ContainerStore(state.containers, state.siteContainerRules, partitionScope);
    this.restore = new RestoreStore(state);
    this.formRecovery = new FormRecoveryStore(state);
    this.permissions = new PermissionStore(state.permissions);
    this.zoom = new SiteZoomStore(state.siteZoom, () => state.settings.defaultZoomFactor);
    this.containers.ensureDefault();
  }

  static normalize(raw: Partial<BrowserCoreState> | null | undefined): BrowserCoreState {
    const rawSettings = (raw?.settings ?? {}) as Partial<BrowserSettings> & {
      restorePreviousSession?: boolean;
      historyDayStartHour?: number;
      showBookmarkBar?: boolean;
    };
    const {
      restorePreviousSession: legacyRestorePreviousSession,
      historyDayStartHour: legacyHistoryDayStartHour,
      showBookmarkBar: legacyShowBookmarkBar,
      ...settingsPatch
    } = rawSettings;
    const startupBehavior =
      settingsPatch.startupBehavior ??
      (legacyRestorePreviousSession === false ? "none" : DEFAULT_SETTINGS.startupBehavior);
    const historyDayStartMinutes =
      settingsPatch.historyDayStartMinutes ??
      (typeof legacyHistoryDayStartHour === "number"
        ? Math.round(legacyHistoryDayStartHour * 60)
        : DEFAULT_SETTINGS.historyDayStartMinutes);
    const showFavoritesBar = settingsPatch.showFavoritesBar ?? legacyShowBookmarkBar ?? DEFAULT_SETTINGS.showFavoritesBar;
    const rawBookmarks = raw?.bookmarks?.bookmarks ?? { ...EMPTY_BOOKMARKS.bookmarks };
    const normalizedBookmarks = Object.fromEntries(
      Object.entries(rawBookmarks).map(([id, bookmark]) => [id, {
        ...bookmark,
        favorite: bookmark.favorite ?? bookmark.parentId === null,
        favoriteOrder: bookmark.favoriteOrder ?? ((bookmark.favorite ?? bookmark.parentId === null) ? bookmark.order : undefined),
        visualKind: bookmark.visualKind ?? "favicon",
      }]),
    );
    const bookmarks = mergeDuplicateBookmarks(normalizedBookmarks);
    return {
      version: 5,
      settings: { ...DEFAULT_SETTINGS, ...settingsPatch, startupBehavior, historyDayStartMinutes, showFavoritesBar },
      siteZoom: raw?.siteZoom ?? {},
      containers: raw?.containers ?? {},
      siteContainerRules: raw?.siteContainerRules ?? [],
      history: {
        nodes: raw?.history?.nodes ?? { ...EMPTY_HISTORY.nodes },
        edges: raw?.history?.edges ?? [],
        currentByLeaf: raw?.history?.currentByLeaf ?? {},
        leaves: raw?.history?.leaves ?? {},
      },
      bookmarks: {
        folders: raw?.bookmarks?.folders ?? { ...EMPTY_BOOKMARKS.folders },
        bookmarks,
      },
      permissions: raw?.permissions ?? [],
      restoreCapsules: raw?.restoreCapsules ?? {},
      formRecovery: raw?.formRecovery ?? {},
      formRecoveryPolicies: raw?.formRecoveryPolicies ?? {},
      sessionCheckpoint: raw?.sessionCheckpoint ?? { capturedAt: 0, leaves: [] },
    };
  }

  settings(): BrowserSettings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<BrowserSettings>): void {
    Object.assign(this.state.settings, patch);
    this.scheduleSave();
  }

  searchUrl(query: string): string {
    const encoded = encodeURIComponent(query);
    const template = this.state.settings.searchUrlTemplate || DEFAULT_SETTINGS.searchUrlTemplate;
    return template.includes("{query}")
      ? template.replaceAll("{query}", encoded)
      : DEFAULT_SETTINGS.searchUrlTemplate.replace("{query}", encoded);
  }

  setSessionCheckpoint(checkpoint: BrowserSessionCheckpoint): void {
    this.state.sessionCheckpoint = checkpoint;
    this.scheduleSave();
  }

  sweepRestoreCapsules(): boolean {
    const changed = this.restore.sweep(this.state.settings);
    if (changed) this.scheduleSave();
    return changed;
  }

  sweepRetention(): { restoreChanged: boolean; formRecoveryChanged: boolean; historyRemoved: number } {
    const restoreChanged = this.restore.sweep(this.state.settings);
    const formRecoveryChanged = this.formRecovery.sweep(this.state.settings);
    const historyRemoved = this.history.sweep(this.state.settings);
    if (restoreChanged || formRecoveryChanged || historyRemoved > 0) this.scheduleSave();
    return { restoreChanged, formRecoveryChanged, historyRemoved };
  }

  sweepHistory(): number {
    const removed = this.history.sweep(this.state.settings);
    if (removed) this.scheduleSave();
    return removed;
  }

  sweepFormRecovery(): boolean {
    const changed = this.formRecovery.sweep(this.state.settings);
    if (changed) this.scheduleSave();
    return changed;
  }

  redactHistoryNode(nodeId: HistoryNodeId): boolean {
    return this.redactHistoryNodes([nodeId]) > 0;
  }

  redactHistoryNodes(nodeIds: Iterable<HistoryNodeId>): number {
    const affectedLeaves = new Set<string>();
    let changed = 0;
    for (const nodeId of nodeIds) {
      const node = this.state.history.nodes[nodeId];
      if (!node || node.kind === "tombstone") continue;
      affectedLeaves.add(node.leafId);
      if (this.history.deleteNode(nodeId)) changed++;
    }
    if (!changed) return 0;
    for (const leafId of affectedLeaves) this.suppressRichRestoreForLeaf(leafId);
    this.scheduleSave();
    return changed;
  }

  redactHistoryBranch(branchId: string): number {
    const nodes = this.history.navigationNodesForBranch(branchId);
    return this.redactHistoryNodes(nodes.map((node) => node.id));
  }

  redactLeafHistory(leafId: string): number {
    const changed = this.history.deleteLeafHistory(leafId);
    if (!changed) return 0;
    this.suppressRichRestoreForLeaf(leafId);
    this.scheduleSave();
    return changed;
  }

  suppressRichRestoreForLeaf(leafId: string): void {
    const leaf = this.state.history.leaves[leafId];
    if (leaf) leaf.richRestoreSuppressed = true;
    this.restore.remove(leafId);
  }

  normalizeContainer(requested?: ContainerId): ContainerId {
    return this.containers.get(requested || this.state.settings.defaultContainerId).id;
  }

  resolveContainerForNavigation(url: string | undefined, fallback?: ContainerId): ContainerId {
    const normalizedFallback = this.normalizeContainer(fallback);
    if (!url || url.startsWith("browser://")) return normalizedFallback;
    if (this.state.settings.containerMode !== "automatic") return normalizedFallback;
    return this.containers.resolveForUrl(url, normalizedFallback);
  }

  defaultContainerForNewTab(): ContainerId {
    return this.state.settings.containerMode === "off"
      ? this.containers.ensureDefault().id
      : this.normalizeContainer(this.state.settings.defaultContainerId);
  }

  scheduleSave(): void {
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.persistence.save(this.state);
    }, 150);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.persistence.save(this.state);
  }
}

function mergeDuplicateBookmarks(bookmarks: Record<string, BookmarkEntry>): Record<string, BookmarkEntry> {
  const merged: Record<string, BookmarkEntry> = {};
  const byUrl = new Map<string, string>();
  const ordered = Object.values(bookmarks).sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  for (const bookmark of ordered) {
    const key = normalizeBookmarkUrl(bookmark.url);
    const existingId = byUrl.get(key);
    if (!existingId) {
      merged[bookmark.id] = { ...bookmark };
      byUrl.set(key, bookmark.id);
      continue;
    }
    const existing = merged[existingId];
    if (!existing) continue;
    if (existing.parentId === null && bookmark.parentId !== null) {
      existing.parentId = bookmark.parentId;
      existing.order = bookmark.order;
    }
    existing.favorite = existing.favorite || bookmark.favorite;
    const favoriteOrders = [existing.favoriteOrder, bookmark.favoriteOrder].filter((value): value is number => typeof value === "number");
    existing.favoriteOrder = favoriteOrders.length ? Math.min(...favoriteOrders) : undefined;
    if (existing.visualKind === "favicon" && bookmark.visualKind !== "favicon") {
      existing.visualKind = bookmark.visualKind;
      existing.visualValue = bookmark.visualValue;
    }
    if (!existing.faviconUrl && bookmark.faviconUrl) existing.faviconUrl = bookmark.faviconUrl;
  }
  return merged;
}
