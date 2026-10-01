import type { BookmarkChangeEvent, BrowserEventBus } from "../core/events";
import type { BookmarkVisualKind, BrowserLeafRecord, ContainerId, NavigationNode } from "../core/model";

export type BrowserOpenDisposition = "current" | "new-tab" | "background" | "new-window";

export interface BrowserOpenOptions {
  containerId?: ContainerId;
  disposition?: BrowserOpenDisposition;
}

export interface BrowserTabSnapshot {
  id: string;
  lifecycleId: string;
  title: string;
  url: string;
  containerId: ContainerId;
  pinned: boolean;
  active: boolean;
}

export interface BrowserContainerSnapshot {
  id: ContainerId;
  name: string;
  color?: string;
  icon?: string;
}

export interface BrowserBookmarkSnapshot {
  id: string;
  parentId: string | null;
  title: string;
  url: string;
  favorite: boolean;
  visualKind: BookmarkVisualKind;
  visualValue?: string;
  faviconUrl?: string;
}

export interface BrowserHistoryEntrySnapshot {
  id: string;
  tabId: string;
  containerId: ContainerId;
  timestamp: number;
  title: string;
  url: string;
}

export interface BrowserCapabilitySnapshot {
  apiVersion: 5;
  runtime: "managed-webview";
  isolatedContainers: true;
  siteContainerAssignments: true;
  graphHistory: true;
  richRestore: "best-effort";
  formRecovery: true;
  permissions: "best-effort";
  internalSurfaces: true;
  bookmarkVisuals: true;
  favorites: true;
}

export interface BrowserBookmarkInput {
  url: string;
  title?: string;
  parentId?: string | null;
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
  faviconUrl?: string;
}

export interface BrowserHistoryRestoreOptions {
  containerId?: ContainerId;
  pinned?: boolean;
}

export interface BrowserTabEventSnapshot {
  id: string;
  title: string;
  url: string;
  containerId: ContainerId;
  pinned: boolean;
  closedAt?: number;
  closeReason?: "user" | "shutdown" | "replaced" | "view-replaced";
}

export interface BrowserBookmarkChangeSnapshot {
  action: "added" | "updated" | "moved" | "deleted" | "sorted";
  kind: "bookmark" | "folder";
  id: string;
}

export interface BrowserPublicEventMap {
  "tab-opened": BrowserTabEventSnapshot;
  "tab-closed": BrowserTabEventSnapshot;
  "navigation-committed": BrowserHistoryEntrySnapshot;
  "bookmark-changed": BrowserBookmarkChangeSnapshot;
}

export interface BrowserApiHost {
  open(url: string, options?: BrowserOpenOptions): Promise<void>;
  search(query: string, options?: BrowserOpenOptions): Promise<void>;
  tabs(): BrowserTabSnapshot[];
  activateTab(id: string): Promise<boolean>;
  closeTab(id: string): boolean;
  containers(): BrowserContainerSnapshot[];
  capabilities(): BrowserCapabilitySnapshot;
  bookmarks(query?: string): BrowserBookmarkSnapshot[];
  addBookmark(input: BrowserBookmarkInput): BrowserBookmarkSnapshot;
  history(query?: string): BrowserHistoryEntrySnapshot[];
  restoreHistoryEntry(id: string, options?: BrowserHistoryRestoreOptions): Promise<boolean>;
}

export class BrowserPublicApi {
  readonly apiVersion = 5 as const;

  constructor(
    private readonly host: BrowserApiHost,
    private readonly events: BrowserEventBus,
  ) {}

  open(url: string, options?: BrowserOpenOptions): Promise<void> {
    return this.host.open(url, options);
  }

  search(query: string, options?: BrowserOpenOptions): Promise<void> {
    return this.host.search(query, options);
  }

  tabs(): BrowserTabSnapshot[] {
    return this.host.tabs().map((tab) => ({ ...tab }));
  }

  activateTab(id: string): Promise<boolean> {
    return this.host.activateTab(id);
  }

  closeTab(id: string): boolean {
    return this.host.closeTab(id);
  }

  containers(): BrowserContainerSnapshot[] {
    return this.host.containers().map((container) => ({ ...container }));
  }

  capabilities(): BrowserCapabilitySnapshot {
    return { ...this.host.capabilities() };
  }

  bookmarks(query?: string): BrowserBookmarkSnapshot[] {
    return this.host.bookmarks(query).map((entry) => ({ ...entry }));
  }

  addBookmark(input: BrowserBookmarkInput): BrowserBookmarkSnapshot {
    return { ...this.host.addBookmark(input) };
  }

  history(query?: string): BrowserHistoryEntrySnapshot[] {
    return this.host.history(query).map((entry) => ({ ...entry }));
  }

  restoreHistoryEntry(id: string, options?: BrowserHistoryRestoreOptions): Promise<boolean> {
    return this.host.restoreHistoryEntry(id, options);
  }

  on<K extends keyof BrowserPublicEventMap>(
    event: K,
    callback: (payload: BrowserPublicEventMap[K]) => void,
  ): () => void {
    if (event === "tab-opened") {
      return this.events.on("leaf-opened", (payload) => callback(mapLeaf(payload) as BrowserPublicEventMap[K]));
    }
    if (event === "tab-closed") {
      return this.events.on("leaf-closed", (payload) => callback(mapLeaf(payload) as BrowserPublicEventMap[K]));
    }
    if (event === "navigation-committed") {
      return this.events.on("navigation-committed", (payload) => callback(mapNavigation(payload) as BrowserPublicEventMap[K]));
    }
    return this.events.on("bookmark-changed", (payload) => callback(mapBookmarkChange(payload) as BrowserPublicEventMap[K]));
  }
}

function mapLeaf(record: BrowserLeafRecord): BrowserTabEventSnapshot {
  return {
    id: record.id,
    title: record.lastTitle || "Tab",
    url: record.lastUrl || "browser://home",
    containerId: record.containerId,
    pinned: record.pinned,
    closedAt: record.closedAt,
    closeReason: record.closeReason,
  };
}

function mapNavigation(node: NavigationNode): BrowserHistoryEntrySnapshot {
  return {
    id: node.id,
    tabId: node.leafId,
    containerId: node.containerId,
    timestamp: node.timestamp,
    title: node.title,
    url: node.url,
  };
}

function mapBookmarkChange(event: BookmarkChangeEvent): BrowserBookmarkChangeSnapshot {
  return {
    action: event.action,
    kind: event.kind,
    id: event.id,
  };
}
