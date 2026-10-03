export type LeafId = string;
export type ContainerId = string;
export type HistoryNodeId = string;
export type BookmarkId = string;
export type BookmarkFolderId = string;

export type TabStyle = "firefox" | "chrome";
export type BrowserStartupBehavior = "restore" | "home" | "none";
export type ContainerMode = "off" | "manual" | "automatic";
export type BookmarkVisualKind = "favicon" | "image" | "text" | "icon";
export type SiteAssignmentBypassReason = "explicit" | "opener";
export type PermissionDecision = "ask" | "allow" | "block";
export type ManualRetention = "default" | "preserve";

export interface BrowserSettings {
  tabStyle: TabStyle;
  tabStripIntegrationEnabled: boolean;
  replaceEmptyTabsWithHome: boolean;
  homeSearchMode: "vault" | "web";
  showRecentVaultFilesOnHome: boolean;
  showVaultBookmarksOnHome: boolean;
  searchUrlTemplate: string;
  historyDayStartMinutes: number;
  historyRetentionDays: number;
  historyMaxNodes: number;
  restoreRetentionDays: number;
  restoreStorageLimitMb: number;
  startupBehavior: BrowserStartupBehavior;
  formRecoveryEnabled: boolean;
  formRecoveryRetentionDays: number;
  formRecoveryMaxSnapshotsPerUrl: number;
  formRecoveryMaxUrls: number;
  reducedMotion: boolean;
  fullPageLoadingShield: boolean;
  defaultZoomFactor: number;
  defaultContainerId: ContainerId;
  containerMode: ContainerMode;
  showFavoritesBar: boolean;
}

export interface BrowserContainer {
  id: ContainerId;
  name: string;
  partition: string;
  color?: string;
  icon?: string;
  createdAt: number;
}

export interface SiteContainerRule {
  originPattern: string;
  containerId: ContainerId;
}

export interface BrowserLeafRecord {
  id: LeafId;
  openedAt: number;
  closedAt?: number;
  closeReason?: "user" | "shutdown" | "replaced" | "view-replaced";
  containerId: ContainerId;
  pinned: boolean;
  manualRetention: ManualRetention;
  restoredFromLeafId?: LeafId;
  richRestoreSuppressed?: boolean;
  lastUrl?: string;
  lastTitle?: string;
  lastActiveAt: number;
}

export interface NavigationNode {
  id: HistoryNodeId;
  kind: "navigation";
  leafId: LeafId;
  containerId: ContainerId;
  timestamp: number;
  url: string;
  title: string;
  parentId?: HistoryNodeId;
  branchId: string;
  sessionEntryIndex?: number;
  stale: boolean;
  manualRetention: ManualRetention;
}

export interface ResidualNode {
  id: HistoryNodeId;
  kind: "residual";
  leafId: LeafId;
  timestamp: number;
  residualKind: "reload" | "redirect" | "in-page" | "other";
  parentId?: HistoryNodeId;
  fromUrl?: string;
  toUrl?: string;
  detail?: string;
}

export interface TombstoneNode {
  id: HistoryNodeId;
  kind: "tombstone";
  leafId: LeafId;
  timestamp: number;
  deletedAt: number;
}

export type HistoryNode = NavigationNode | ResidualNode | TombstoneNode;

export interface HistoryEdge {
  from: HistoryNodeId;
  to: HistoryNodeId;
  kind: "navigation" | "residual" | "restore";
}

export interface HistoryGraphState {
  nodes: Record<HistoryNodeId, HistoryNode>;
  edges: HistoryEdge[];
  currentByLeaf: Record<LeafId, HistoryNodeId | undefined>;
  leaves: Record<LeafId, BrowserLeafRecord>;
}

export interface BookmarkFolder {
  id: BookmarkFolderId;
  kind: "folder";
  parentId: BookmarkFolderId | null;
  title: string;
  order: number;
}

export interface BookmarkEntry {
  id: BookmarkId;
  kind: "bookmark";
  parentId: BookmarkFolderId | null;
  title: string;
  url: string;
  order: number;
  createdAt: number;
  favorite: boolean;
  favoriteOrder?: number;
  visualKind: BookmarkVisualKind;
  visualValue?: string;
  faviconUrl?: string;
}

export interface BookmarkState {
  folders: Record<BookmarkFolderId, BookmarkFolder>;
  bookmarks: Record<BookmarkId, BookmarkEntry>;
}

export interface PermissionRecord {
  containerId: ContainerId;
  origin: string;
  permission: string;
  decision: PermissionDecision;
  updatedAt: number;
}

export interface BrowserSessionLeaf {
  sourceLifecycleId: LeafId;
  url: string;
  containerId: ContainerId;
  siteAssignmentBypassOrigin?: string;
  siteAssignmentBypassReason?: SiteAssignmentBypassReason;
  pinned: boolean;
  manualRetention: ManualRetention;
  internalSurface?: "home" | "history" | "bookmarks";
  transientHistory?: BrowserTransientHistoryEntry[];
  transientIndex?: number;
}

export interface BrowserSessionCheckpoint {
  capturedAt: number;
  leaves: BrowserSessionLeaf[];
}

export interface RestoreCapsule {
  leafId: LeafId;
  capturedAt: number;
  entries: Array<Record<string, unknown>>;
  index: number;
}

export interface FormRecoveryField {
  name?: string;
  id?: string;
  type: string;
  label?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
  nearbyText?: string;
  value?: string;
  checked?: boolean;
  values?: string[];
}

export interface FormRecoverySnapshot {
  id: string;
  containerId: ContainerId;
  url: string;
  capturedAt: number;
  fields: FormRecoveryField[];
}

export interface FormRecoveryPolicy {
  containerId: ContainerId;
  origin: string;
  disabled: boolean;
  excludedFieldKeys: string[];
  updatedAt: number;
}

export interface BrowserCoreState {
  version: 5;
  settings: BrowserSettings;
  siteZoom: Record<string, number>;
  containers: Record<ContainerId, BrowserContainer>;
  siteContainerRules: SiteContainerRule[];
  history: HistoryGraphState;
  bookmarks: BookmarkState;
  permissions: PermissionRecord[];
  restoreCapsules: Record<LeafId, RestoreCapsule>;
  formRecovery: Record<string, FormRecoverySnapshot[]>;
  formRecoveryPolicies: Record<string, FormRecoveryPolicy>;
  sessionCheckpoint: BrowserSessionCheckpoint;
}

export interface BrowserLeafViewState extends Record<string, unknown> {
  lifecycleId?: LeafId;
  url?: string;
  containerId?: ContainerId;
  siteAssignmentBypassOrigin?: string;
  siteAssignmentBypassReason?: SiteAssignmentBypassReason;
  pinned?: boolean;
  manualRetention?: ManualRetention;
  restoredFromLeafId?: LeafId;
  restoreTargetUrl?: string;
  restoreTargetIndex?: number;
  internalSurface?: "home" | "history" | "bookmarks";
  transientHistory?: BrowserTransientHistoryEntry[];
  transientIndex?: number;
}

export type BrowserTransientHistoryEntry =
  | {
      kind: "internal";
      url: string;
      surface: NonNullable<BrowserLeafViewState["internalSurface"]>;
    }
  | {
      kind: "web";
      url: string;
      webIndex?: number;
      title?: string;
    };

export const DEFAULT_SETTINGS: BrowserSettings = {
  tabStyle: "firefox",
  tabStripIntegrationEnabled: true,
  replaceEmptyTabsWithHome: true,
  homeSearchMode: "vault",
  showRecentVaultFilesOnHome: true,
  showVaultBookmarksOnHome: true,
  searchUrlTemplate: "https://www.google.com/search?q={query}",
  historyDayStartMinutes: 240,
  historyRetentionDays: 0,
  historyMaxNodes: 0,
  restoreRetentionDays: 14,
  restoreStorageLimitMb: 128,
  startupBehavior: "restore",
  formRecoveryEnabled: false,
  formRecoveryRetentionDays: 7,
  formRecoveryMaxSnapshotsPerUrl: 5,
  formRecoveryMaxUrls: 200,
  reducedMotion: false,
  fullPageLoadingShield: false,
  defaultZoomFactor: 1,
  defaultContainerId: "default",
  containerMode: "automatic",
  showFavoritesBar: true,
};

export const EMPTY_HISTORY: HistoryGraphState = {
  nodes: {},
  edges: [],
  currentByLeaf: {},
  leaves: {},
};

export const EMPTY_BOOKMARKS: BookmarkState = {
  folders: {},
  bookmarks: {},
};
