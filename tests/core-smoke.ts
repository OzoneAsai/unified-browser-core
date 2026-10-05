import assert from "node:assert/strict";
import { HistoryGraph } from "../src/history/history-graph";
import { historyDayKey } from "../src/history/day-key";
import { ContainerStore } from "../src/containers/container-store";
import { BookmarkStore } from "../src/bookmarks/bookmark-store";
import { inferBookmarkMedia, classifyBookmark } from "../src/bookmarks/bookmark-media";
import { t, setLanguage, setLocaleResolver } from "../src/i18n";
import { RestoreStore } from "../src/core/restore-store";
import { BrowserCore } from "../src/core/browser-core";
import { PermissionStore } from "../src/core/permission-store";
import { permissionDecisionLabel, permissionLabel } from "../src/ui/permission-label";
import { FormRecoveryStore } from "../src/core/form-recovery-store";
import { SiteZoomStore } from "../src/core/site-zoom-store";
import { classifyWindowOpen } from "../src/adapters/electron-window-open";
import { HybridBrowserPersistence } from "../src/persistence/hybrid-persistence";
import { classifyInPageNavigation } from "../src/history/navigation-classifier";
import { ElectronNavigationHistoryAdapter } from "../src/adapters/electron-navigation-history";
import { resolveTabLayoutPolicy } from "../src/tabs/tab-layout-policy";
import { BrowserPublicApi } from "../src/api/browser-api";
import { BrowserEventBus } from "../src/core/events";
import { normalizeBrowserAddress } from "../src/navigation/address-normalizer";
import { ObsidianCommandAdapter } from "../src/adapters/obsidian-commands";
import { buildWebContentMenuEntries } from "../src/ui/web-content-menu-model";
import { ElectronContextMenuAdapter } from "../src/adapters/electron-context-menu";
import { resolveGuestWebContents } from "../src/adapters/electron-compat";
import { cloneSessionCheckpoint, pendingSessionLeaves } from "../src/core/session-restore";
import { normalizeObsidianBookmarkItems } from "../src/adapters/obsidian-bookmarks";
import { WebViewerBookmarksAdapter, normalizeWebViewerBookmarks } from "../src/adapters/webviewer-bookmarks";

(globalThis as typeof globalThis & { window?: typeof globalThis }).window = globalThis;
setLanguage("en");
for (const [url, expected] of [
  ["https://www.google.com/", "reference"], ["https://docs.google.com/document/d/123", "reference"],
  ["https://mail.google.com/mail/u/0/", "mail"], ["https://gmail.com/", "mail"], ["https://outlook.office.com/mail/", "mail"],
  ["https://outlook.live.com/mail/", "mail"], ["https://mail.yahoo.co.jp/", "mail"],
  ["https://youtube.com/watch?v=123", "video"], ["https://youtu.be/123", "video"],
  ["https://example.com/clip.MP4?download=1", "video"], ["https://example.com/download?file=clip.mp4", "video"],
  ["https://example.com/manual.pdf", "pdf"], ["https://example.com/image.webp", "image"],
  ["https://example.com/audio.mp3", "audio"], ["https://example.com/doc.docx", "document"],
  ["https://note.com/example/n/123", "blog"], ["https://reddit.com/r/obsidian", "forum"],
  ["https://qiita.com/example/items/123", "blog"], ["https://forum.obsidian.md/t/topic/123", "forum"],
  ["https://manaba.example.ac.jp/", "reference"], ["https://evilgoogle.com/", "website"],
  ["https://example.com/page?text=.mp4-discussion", "website"],
] as const) assert.equal(inferBookmarkMedia(url), expected, url);
assert.equal(classifyBookmark({ url: "https://youtube.com/", mediaType: "reference" }), "reference", "manual categories override heuristics");
setLanguage("ja");
assert.equal(t("Selected members"), "選抜メンバー");
assert.equal(t("{count} bookmarks", { count: 3 }), "3件のブックマーク");
setLocaleResolver(() => "ja"); setLanguage("auto");
assert.equal(t("Bookmarks"), "ブックマーク");
setLanguage("en");

const sessionCheckpoint = {
  capturedAt: 123,
  leaves: [
    {
      sourceLifecycleId: "leaf-a",
      url: "https://example.com/a",
      containerId: "default",
      pinned: false,
      manualRetention: "default" as const,
      transientHistory: [{ kind: "web" as const, url: "https://example.com/a", title: "A" }],
      transientIndex: 0,
    },
    {
      sourceLifecycleId: "leaf-b",
      url: "browser://history",
      containerId: "default",
      pinned: true,
      manualRetention: "preserve" as const,
      internalSurface: "history" as const,
    },
    {
      sourceLifecycleId: "leaf-b",
      url: "https://duplicate.example/",
      containerId: "default",
      pinned: false,
      manualRetention: "default" as const,
    },
  ],
};
const frozenSessionCheckpoint = cloneSessionCheckpoint(sessionCheckpoint);
sessionCheckpoint.leaves[0]!.url = "https://mutated.example/";
sessionCheckpoint.leaves[0]!.transientHistory![0]!.url = "https://mutated.example/";
assert.equal(frozenSessionCheckpoint.leaves[0]?.url, "https://example.com/a");
assert.equal(frozenSessionCheckpoint.leaves[0]?.transientHistory?.[0]?.url, "https://example.com/a");
assert.deepEqual(
  pendingSessionLeaves(frozenSessionCheckpoint, [{ lifecycleId: "current-a", restoredFromLeafId: "leaf-a" }])
    .map((leaf) => leaf.sourceLifecycleId),
  ["leaf-b"],
  "session restore must skip already represented source lifecycles and duplicate checkpoint entries",
);
assert.deepEqual(
  pendingSessionLeaves(frozenSessionCheckpoint, [{ lifecycleId: "leaf-b" }])
    .map((leaf) => leaf.sourceLifecycleId),
  ["leaf-a"],
  "session restore must recognize a live leaf with the original lifecycle id",
);

assert.equal(
  resolveGuestWebContents({
    getWebContentsId: () => { throw new Error("guest not attached"); },
  } as never),
  undefined,
  "Electron compatibility bridge must treat unattached webviews as unavailable",
);

const commandAdapter = new ObsidianCommandAdapter();
const executedCommandIds: string[] = [];
const fakeCommandApp = {
  commands: {
    commands: { "switcher:open": {} },
    executeCommandById: (id: string) => {
      executedCommandIds.push(id);
      return true;
    },
  },
} as never;
assert.equal(commandAdapter.has(fakeCommandApp, "switcher:open"), true);
assert.equal(commandAdapter.openQuickSwitcher(fakeCommandApp), true);
assert.deepEqual(executedCommandIds, ["switcher:open"]);
assert.equal(commandAdapter.openQuickSwitcher({} as never), false);

const linkMenuEntries = buildWebContentMenuEntries(
  {
    core: {
      settings: () => ({ containerMode: "automatic" }),
      containers: { list: () => [{ id: "default", name: "Default" }] },
    },
  } as never,
  {} as never,
  {
    x: 10,
    y: 20,
    linkURL: "https://en.wikipedia.org/wiki/Custer_County,_Idaho",
    linkText: "Custer County, Idaho",
    mediaType: "none",
    isEditable: false,
  },
);
const linkMenuTitles = linkMenuEntries.flatMap((entry) => entry.kind === "item" ? [entry.title] : []);
assert.deepEqual(linkMenuTitles.slice(0, 5), [
  "Open link",
  "Open link in new tab",
  "Open link in background tab",
  "Open link in new window",
  "Open link in Default",
]);
assert.equal(linkMenuTitles.includes("Bookmark link"), true);
assert.equal(linkMenuTitles.includes("Copy link"), true);
assert.equal(linkMenuTitles.includes("Show link in history"), true);
assert.equal(linkMenuTitles.includes("Back"), false, "link context must not collapse to the generic page menu");
assert.equal(linkMenuTitles.includes("Copy"), false, "link context must expose Copy link rather than generic editable Copy");

const selectedTextMenuEntries = buildWebContentMenuEntries(
  {
    core: {
      searchUrl: (query: string) => "https://search.example/?q=" + encodeURIComponent(query),
      containers: { list: () => [{ id: "default", name: "Default" }] },
    },
  } as never,
  {} as never,
  {
    x: 10,
    y: 20,
    selectionText: "selected prose",
    mediaType: "none",
    isEditable: false,
  },
);
const selectedTextTitles = selectedTextMenuEntries.flatMap((entry) => entry.kind === "item" ? [entry.title] : []);
assert.deepEqual(selectedTextTitles, ["Search “selected prose”", "Copy selected text"]);

const editableSelectionMenuEntries = buildWebContentMenuEntries(
  {
    core: {
      searchUrl: (query: string) => "https://search.example/?q=" + encodeURIComponent(query),
      containers: { list: () => [{ id: "default", name: "Default" }] },
    },
  } as never,
  {
    hasRecoverableFormValues: () => false,
    formRecoveryEnabledForSite: () => false,
    formRecoveryMasterEnabled: () => false,
  } as never,
  {
    x: 10,
    y: 20,
    selectionText: "typed text",
    mediaType: "none",
    isEditable: true,
    editFlags: {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
    },
  },
);
const editableSelectionTitles = editableSelectionMenuEntries.flatMap((entry) => entry.kind === "item" ? [entry.title] : []);
assert.deepEqual(editableSelectionTitles, [
  "Undo",
  "Redo",
  "Cut",
  "Copy",
  "Paste",
  "Delete",
  "Select all",
  "Search “typed text”",
]);
assert.equal(editableSelectionTitles.includes("Copy selected text"), false, "editable selections must not duplicate Copy");

const blankMenuEntries = buildWebContentMenuEntries(
  {
    core: {
      containers: { list: () => [{ id: "default", name: "Default" }] },
    },
  } as never,
  {
    canGoBack: () => false,
    canGoForward: () => false,
  } as never,
  { x: 10, y: 20, mediaType: "none", isEditable: false },
);
const blankMenuTitles = blankMenuEntries.flatMap((entry) => entry.kind === "item" ? [entry.title] : []);
assert.equal(blankMenuTitles.includes("Copy"), false);
assert.equal(blankMenuTitles.includes("Paste"), false);
assert.equal(blankMenuTitles.includes("Copy page URL"), true);
assert.equal(blankMenuTitles.includes("Home"), true);
assert.equal(blankMenuTitles.includes("Reopen in container…"), true);

const linkedImageEntries = buildWebContentMenuEntries(
  {
    core: {
      containers: { list: () => [{ id: "default", name: "Default" }] },
    },
    openBrowser: () => undefined,
  } as never,
  {
    navigate: () => undefined,
    copyWebImageAt: () => undefined,
    downloadWebResource: () => undefined,
  } as never,
  {
    x: 10,
    y: 20,
    mediaType: "image",
    isEditable: false,
    linkURL: "https://example.com/image.png",
    srcURL: "https://example.com/image.png",
    linkText: "image",
  },
);
const linkedImageTitles = linkedImageEntries.flatMap((entry) => entry.kind === "item" ? [entry.title] : []);
assert.equal(linkedImageTitles.includes("Open link in new tab"), true);
assert.equal(linkedImageTitles.includes("Open image in new tab"), false, "identical image-link targets must not duplicate open actions");
assert.equal(linkedImageTitles.includes("Copy link"), true);
assert.equal(linkedImageTitles.includes("Copy image URL"), false, "identical image-link targets must not duplicate URL copy actions");
assert.equal(linkedImageTitles.includes("Copy image"), true);
assert.equal(linkedImageTitles.includes("Download image"), true);

const nativeMenuLabels: string[] = [];
let nativePopupCount = 0;
let nativePrevented = false;
let nativeRemoved = false;
let hostListenerCalls = 0;
let linkSelectionGuardInstalled = false;
let editableContextGuardInstalled = false;
let selectionRestoreCalls = 0;
let pendingSelectionText = "";
type FakeContextListener = (event: { preventDefault?: () => void }, params: any) => void;
type FakeConsoleListener = (event: unknown, level: number, message: string, line: number, sourceId: string) => void;
const hostContextListenerA: FakeContextListener = () => { hostListenerCalls += 1; };
const hostContextListenerB: FakeContextListener = () => { hostListenerCalls += 1; };
const contextListeners: FakeContextListener[] = [hostContextListenerA, hostContextListenerB];
const consoleListeners: FakeConsoleListener[] = [];
class FakeNativeMenuItem {
  constructor(readonly options: { label?: string; type?: "separator"; enabled?: boolean; click?: () => void }) {}
}
class FakeNativeMenu {
  append(item: FakeNativeMenuItem): void {
    if (item.options.label) nativeMenuLabels.push(item.options.label);
  }
  popup(target?: unknown): void {
    assert.equal(target, fakeGuestContents);
    nativePopupCount += 1;
  }
}
const fakeGuestContents = {
  on: (event: string, listener: FakeContextListener | FakeConsoleListener) => {
    if (event === "context-menu") contextListeners.push(listener as FakeContextListener);
    else if (event === "console-message") consoleListeners.push(listener as FakeConsoleListener);
    else assert.fail("unexpected event: " + event);
  },
  removeListener: (event: string, listener: FakeContextListener | FakeConsoleListener) => {
    if (event === "context-menu") {
      const index = contextListeners.indexOf(listener as FakeContextListener);
      if (index >= 0) contextListeners.splice(index, 1);
    } else if (event === "console-message") {
      const index = consoleListeners.indexOf(listener as FakeConsoleListener);
      if (index >= 0) consoleListeners.splice(index, 1);
    } else {
      assert.fail("unexpected event: " + event);
    }
    nativeRemoved = true;
  },
  listeners: (event: string) => {
    assert.equal(event, "context-menu");
    return contextListeners.slice();
  },
  executeJavaScript: async (code: string) => {
    if (
      code.includes("selectstart") &&
      code.includes("__ubcLinkContextGuardInstalled") &&
      code.includes("__ubcBrowserCorePendingContextSelection")
    ) {
      linkSelectionGuardInstalled = true;
    }
    if (
      code.includes("HTMLInputElement") &&
      code.includes("HTMLTextAreaElement") &&
      code.includes("isContentEditable")
    ) {
      editableContextGuardInstalled = true;
    }
    if (code.includes("__ubcBrowserCorePendingContextSelection?.text")) return pendingSelectionText;
    if (code.includes("__ubcRestoreBrowserCoreContextSelection")) selectionRestoreCalls += 1;
    return undefined;
  },
};
(globalThis as any).require = (id: string) => {
  if (id !== "@electron/remote") throw new Error("unexpected module");
  return {
    webContents: { fromId: (id: number) => id === 77 ? fakeGuestContents : undefined },
    Menu: FakeNativeMenu,
    MenuItem: FakeNativeMenuItem,
  };
};
const nativeContextAdapter = new ElectronContextMenuAdapter();
const disposeNativeContext = nativeContextAdapter.bind(
  { getWebContentsId: () => 77 } as never,
  (params) => params.linkURL
    ? [
        { kind: "item", title: "Open link", action: () => undefined },
        { kind: "separator" },
        { kind: "item", title: "Copy link", action: () => undefined },
      ]
    : params.isEditable
      ? [
          { kind: "item", title: "Copy", action: () => undefined, disabled: params.editFlags?.canCopy === false },
          { kind: "item", title: "Paste", action: () => undefined, disabled: params.editFlags?.canPaste === false },
        ]
    : params.selectionText
      ? [{ kind: "item", title: "Selection: " + params.selectionText, action: () => undefined }]
      : [],
);
assert.ok(disposeNativeContext);
assert.equal(contextListeners.length, 1, "managed guest must have exactly one context-menu owner while bound");
assert.equal(consoleListeners.length, 1, "managed guest must bridge editable context menus through one console listener");
assert.equal(contextListeners.includes(hostContextListenerA), false);
assert.equal(contextListeners.includes(hostContextListenerB), false);
assert.equal(linkSelectionGuardInstalled, true, "managed guest must suppress macOS transient link selection before context menu creation");
assert.equal(editableContextGuardInstalled, true, "managed guest must own input, textarea, and contenteditable context menus");
contextListeners[0]?.({ preventDefault: () => { nativePrevented = true; } }, {
  x: 1,
  y: 2,
  linkURL: "https://example.com",
  selectionText: "Example",
});
await Promise.resolve();
assert.equal(nativePrevented, true);
assert.equal(hostListenerCalls, 0, "displaced host listeners must not compete with Browser Core native menu");
assert.deepEqual(nativeMenuLabels, ["Open link", "Copy link"]);
assert.equal(nativePopupCount, 1);

pendingSelectionText = "selected prose";
contextListeners[0]?.({ preventDefault: () => undefined }, {
  x: 3,
  y: 4,
  linkURL: "",
  selectionText: "",
});
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(nativePopupCount, 2, "ordinary selected text must produce one Browser Core popup");
assert.equal(nativeMenuLabels.at(-1), "Selection: selected prose", "pending guest selection text must feed the Browser Core menu model");
assert.equal(selectionRestoreCalls >= 1, true, "guest selection must be restored after Browser Core owns the menu");

nativeMenuLabels.length = 0;
consoleListeners[0]?.(
  {},
  0,
  "__UBC_EDITABLE_CONTEXT__" + JSON.stringify({
    x: 5,
    y: 6,
    pageURL: "https://example.com/form",
    mediaType: "none",
    isEditable: true,
    selectionText: "",
    editFlags: {
      canCopy: false,
      canPaste: true,
    },
  }),
  1,
  "https://example.com/form",
);
assert.deepEqual(nativeMenuLabels, ["Copy", "Paste"]);
assert.equal(nativePopupCount, 3, "editable bridge must produce one Browser Core popup");
disposeNativeContext?.();
assert.equal(nativeRemoved, true);
assert.equal(consoleListeners.length, 0, "editable console bridge listener must be removed on dispose");
assert.deepEqual(
  contextListeners,
  [hostContextListenerA, hostContextListenerB],
  "host context-menu listeners must be restored in original order on dispose",
);
delete (globalThis as any).require;

assert.equal(resolveTabLayoutPolicy("firefox").overflow, "horizontal-scroll");
assert.ok(resolveTabLayoutPolicy("firefox").minimumWidth > resolveTabLayoutPolicy("chrome").minimumWidth);
const testSearchUrl = (query: string) => "https://search.example/?q=" + encodeURIComponent(query);
assert.equal(normalizeBrowserAddress("", testSearchUrl), "browser://home");
assert.equal(normalizeBrowserAddress("browser://History", testSearchUrl), "browser://history");
assert.equal(normalizeBrowserAddress("https://example.com/x", testSearchUrl), "https://example.com/x");
assert.equal(normalizeBrowserAddress("example.com", testSearchUrl), "https://example.com");
assert.equal(
  normalizeBrowserAddress("example.com:8080/path?q=1#part", testSearchUrl),
  "https://example.com:8080/path?q=1#part",
  "hostnames with ports, query strings and fragments must be treated as addresses",
);
assert.equal(normalizeBrowserAddress("localhost:3000/test", testSearchUrl), "http://localhost:3000/test");
assert.equal(normalizeBrowserAddress("127.0.0.1:27123/status", testSearchUrl), "http://127.0.0.1:27123/status");
assert.equal(normalizeBrowserAddress("[::1]:3000/test", testSearchUrl), "http://[::1]:3000/test");
assert.equal(
  normalizeBrowserAddress("person@example.com", testSearchUrl),
  testSearchUrl("person@example.com"),
  "email-shaped text must not be misinterpreted as a URL with userinfo",
);
assert.equal(normalizeBrowserAddress("notes about version 1.2", testSearchUrl), testSearchUrl("notes about version 1.2"));

const publicEvents = new BrowserEventBus();
const publicApi = new BrowserPublicApi({
  open: async () => undefined,
  search: async () => undefined,
  tabs: () => [{
    id: "tab-public",
    lifecycleId: "tab-public",
    title: "Public tab",
    url: "https://example.com",
    containerId: "default",
    pinned: false,
    active: true,
  }],
  activateTab: async (id) => id === "tab-public",
  closeTab: (id) => id === "tab-public",
  containers: () => [{ id: "default", name: "Default" }],
  capabilities: () => ({
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
  }),
  bookmarks: () => [],
  addBookmark: (input) => ({
    id: "bookmark-public",
    parentId: null,
    title: input.title || input.url,
    url: input.url,
    favorite: Boolean(input.favorite),
    visualKind: input.visualKind ?? "favicon",
    visualValue: input.visualValue,
    faviconUrl: input.faviconUrl,
  }),
  history: () => [],
  restoreHistoryEntry: async (id) => id === "history-public",
}, publicEvents);
assert.equal(publicApi.apiVersion, 5);
assert.equal((await publicApi.activateTab("tab-public")), true);
assert.equal(publicApi.closeTab("tab-public"), true);
assert.equal(await publicApi.restoreHistoryEntry("history-public"), true);
let publicOpenedEvent: Record<string, unknown> | undefined;
const stopPublicEvent = publicApi.on("tab-opened", (payload) => { publicOpenedEvent = payload as unknown as Record<string, unknown>; });
publicEvents.emit("leaf-opened", {
  id: "tab-public",
  openedAt: 1,
  containerId: "default",
  pinned: false,
  manualRetention: "preserve",
  lastUrl: "https://example.com",
  lastTitle: "Public tab",
  lastActiveAt: 1,
});
stopPublicEvent();
assert.equal(publicOpenedEvent?.id, "tab-public");
assert.equal("manualRetention" in (publicOpenedEvent ?? {}), false, "public events must not leak internal retention state");

const state = BrowserCore.normalize(null);
assert.equal(state.settings.formRecoveryEnabled, false, "form recovery must be opt-in by default");
assert.equal(state.settings.tabStripIntegrationEnabled, true);
assert.equal(state.settings.replaceEmptyTabsWithHome, true, "new empty tabs should default to Browser Core Home");
assert.equal(state.settings.homeSearchMode, "vault", "Home should preserve Home Tab's vault-first behavior by default");
assert.equal(state.settings.historyMaxNodes, 0, "durable history must be uncapped by default");
assert.equal(
  BrowserCore.normalize({ settings: { restorePreviousSession: false } as any }).settings.startupBehavior,
  "none",
  "legacy disabled session restore must migrate to startup=none",
);
assert.equal(
  BrowserCore.normalize({ settings: { restorePreviousSession: true } as any }).settings.startupBehavior,
  "restore",
  "legacy enabled session restore must migrate to startup=restore",
);
const eventLog: string[] = [];
const eventCore = new BrowserCore({} as any, BrowserCore.normalize(null), { save: async () => undefined }, "event-test");
const stopNav = eventCore.events.on("navigation-committed", (node) => eventLog.push("nav:" + node.url));
const stopBookmark = eventCore.events.on("bookmark-changed", (event) => eventLog.push("bookmark:" + event.action));
eventCore.history.beginLeaf({ leafId: "event-leaf", containerId: "default" });
eventCore.history.addNavigation({ leafId: "event-leaf", containerId: "default", url: "https://event.example" });
eventCore.bookmarks.addBookmark({ title: "Event", url: "https://event.example" });
assert.deepEqual(eventLog, ["nav:https://event.example", "bookmark:added"]);
stopNav();
stopBookmark();
assert.match(eventCore.searchUrl("a b"), /a%20b/, "search URL templates must receive an encoded query");
assert.equal(classifyWindowOpen({ disposition: "foreground-tab", frameName: "_blank" }), "core-tab");
assert.equal(classifyWindowOpen({ disposition: "background-tab", frameName: "_blank" }), "core-tab");
assert.equal(
  classifyWindowOpen({ disposition: "new-window" }),
  "core-tab",
  "plain new-window intents should stay under Browser Core ownership",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "oauth", features: "width=480,height=640" }),
  "auxiliary",
  "named/sized popup flows must preserve window.opener semantics",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "_blank", features: "external" }),
  "core-tab",
  "non-presentation window features must stay under Browser Core ownership",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "_blank", features: "noopener" }),
  "core-tab",
  "noopener requests do not require native opener semantics",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "oauth", features: "noopener,width=480,height=640" }),
  "core-tab",
  "noopener must override named/sized auxiliary classification",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "_blank", features: "popup=yes" }),
  "auxiliary",
  "explicit popup presentation should retain auxiliary-window semantics",
);
assert.equal(
  classifyWindowOpen({ disposition: "foreground-tab", frameName: "_blank", features: "popup=no" }),
  "core-tab",
  "disabled popup presentation must not escape Browser Core ownership",
);
assert.equal(classifyInPageNavigation(3, 3, "in-page"), "residual");
assert.equal(classifyInPageNavigation(3, 4, "in-page"), "navigation");
assert.equal(classifyInPageNavigation(3, 2, "back"), "navigation");
assert.equal(classifyInPageNavigation(undefined, undefined, "in-page"), "navigation");
const navHistoryAdapter = new ElectronNavigationHistoryAdapter();
const targetCapsule = {
  leafId: "target",
  capturedAt: 1,
  entries: [{ url: "https://a.example" }, { url: "https://b.example" }],
  index: 1,
};
assert.equal(navHistoryAdapter.entryMatches(targetCapsule, 1, "https://b.example"), true);
assert.equal(navHistoryAdapter.entryMatches(targetCapsule, 1, "https://old-branch.example"), false);

const blankRestoreAdapter = new ElectronNavigationHistoryAdapter();
(blankRestoreAdapter as any).resolve = () => ({
  navigationHistory: {
    restore: async () => undefined,
    getAllEntries: () => [{ url: "about:blank" }, { url: "about:blank" }],
    getActiveIndex: () => 1,
  },
});
assert.equal(
  await blankRestoreAdapter.restore({} as any, targetCapsule, 1),
  false,
  "a resolved Electron restore that leaves only bootstrap about:blank entries must degrade to cold restore",
);

let clearedBootstrapHistory = false;
const validRestoreAdapter = new ElectronNavigationHistoryAdapter();
(validRestoreAdapter as any).resolve = () => ({
  navigationHistory: {
    restore: async () => undefined,
    getAllEntries: () => [{ url: "https://a.example" }, { url: "https://b.example" }],
    getActiveIndex: () => 1,
    clear: () => { clearedBootstrapHistory = true; },
  },
});
assert.equal(await validRestoreAdapter.restore({} as any, targetCapsule, 1), true);
assert.equal(validRestoreAdapter.clear({} as any), true);
assert.equal(clearedBootstrapHistory, true, "bootstrap navigation history must be explicitly clearable after fallback");
const history = new HistoryGraph(state.history);
history.beginLeaf({ leafId: "leaf-a", containerId: "default" });
const a = history.addNavigation({ leafId: "leaf-a", containerId: "default", url: "https://a.example" });
const b = history.addNavigation({
  leafId: "leaf-a",
  containerId: "default",
  url: "https://b.example",
  sessionEntryIndex: 1,
});
assert.equal(b.sessionEntryIndex, 1);
const c = history.addNavigation({ leafId: "leaf-a", containerId: "default", url: "https://c.example" });
history.setCurrent("leaf-a", b.id);
const d = history.addNavigation({ leafId: "leaf-a", containerId: "default", url: "https://d.example" });
assert.notEqual(c.branchId, d.branchId, "branching after Back must preserve the abandoned branch");
assert.equal(history.childrenOf(b.id).filter((node) => node.kind === "navigation").length, 2);
history.setCurrent("leaf-a", b.id);
const forwardD = history.addNavigation({
  leafId: "leaf-a",
  containerId: "default",
  url: "https://d.example",
  reason: "forward",
});
assert.equal(forwardD.id, d.id, "Forward must select an existing matching branch instead of duplicating it");
assert.equal(history.childrenOf(b.id).filter((node) => node.kind === "navigation").length, 2);

history.deleteNode(b.id);
assert.equal(state.history.nodes[b.id]?.kind, "tombstone");
assert.equal(history.removeTombstone(b.id).ok, false, "branch-point tombstones must not contract ambiguously");
const residualParent = history.addNavigation({
  leafId: "leaf-a",
  containerId: "default",
  url: "https://redirect.example",
});
const residual = history.addResidual({
  leafId: "leaf-a",
  residualKind: "redirect",
  fromUrl: "https://secret-source.example",
  toUrl: "https://redirect.example",
});
history.deleteNode(residualParent.id);
assert.equal(state.history.nodes[residual.id], undefined, "deleting a visit must redact attached residual URL metadata completely");
history.closeLeaf("leaf-a");
assert.equal(history.recentlyClosed(1)[0]?.id, "leaf-a");
history.beginLeaf({ leafId: "replaced-leaf", containerId: "default" });
history.addNavigation({
  leafId: "replaced-leaf",
  containerId: "default",
  url: "https://replace.example",
});
history.closeLeaf("replaced-leaf", "replaced");
assert.equal(
  history.recentlyClosed(10).some((leaf) => leaf.id === "replaced-leaf"),
  false,
  "tabs replaced internally to continue the same browser task must not appear in Recently Closed",
);
history.beginLeaf({ leafId: "view-replaced-leaf", containerId: "default" });
history.addNavigation({
  leafId: "view-replaced-leaf",
  containerId: "default",
  url: "https://undoable.example",
});
history.closeLeaf("view-replaced-leaf", "view-replaced");
assert.equal(
  history.recentlyClosed(10).some((leaf) => leaf.id === "view-replaced-leaf"),
  true,
  "browser tabs replaced by another Obsidian view must remain undoable through Recently Closed",
);

const redactionState = BrowserCore.normalize(null);
const redactionCore = new BrowserCore({} as any, redactionState, { save: async () => undefined }, "redaction-test");
redactionCore.history.beginLeaf({ leafId: "redacted-leaf", containerId: "default" });
const redactedNode = redactionCore.history.addNavigation({
  leafId: "redacted-leaf",
  containerId: "default",
  url: "https://private.example/path",
});
redactionCore.restore.put({
  leafId: "redacted-leaf",
  capturedAt: Date.now(),
  entries: [{ url: "https://private.example/path", pageState: "opaque" }],
  index: 0,
});
assert.equal(redactionCore.redactHistoryNode(redactedNode.id), true);
assert.equal(redactionState.history.nodes[redactedNode.id]?.kind, "tombstone");
assert.equal(redactionCore.restore.get("redacted-leaf"), undefined, "redaction must invalidate rich restore data");
assert.equal(
  redactionState.history.leaves["redacted-leaf"]?.richRestoreSuppressed,
  true,
  "a redacted live lifecycle must not recapture deleted session-history data",
);
await redactionCore.flush();
history.beginLeaf({ leafId: "shutdown-leaf", containerId: "default" });
history.addNavigation({
  leafId: "shutdown-leaf",
  containerId: "default",
  url: "https://shutdown.example",
});
history.closeLeaf("shutdown-leaf", "shutdown");
assert.equal(
  history.recentlyClosed(10).some((leaf) => leaf.id === "shutdown-leaf"),
  false,
  "shutdown-suspended tabs must not pollute Recently Closed",
);

const earlyMorning = new Date(2026, 0, 2, 3, 30, 0).getTime();
assert.equal(historyDayKey(earlyMorning, 240), "2026-01-01", "03:30 belongs to the previous history day at a 04:00 boundary");
const afterCustomBoundary = new Date(2026, 0, 2, 4, 45, 0).getTime();
assert.equal(historyDayKey(afterCustomBoundary, 270), "2026-01-02", "04:45 belongs to the new day at a 04:30 boundary");
assert.equal(
  BrowserCore.normalize({ settings: { historyDayStartHour: 4 } as any }).settings.historyDayStartMinutes,
  240,
  "legacy hour-based history boundary must migrate to minutes",
);

const containers: typeof state.containers = {};
const rules: typeof state.siteContainerRules = [];
const containerStore = new ContainerStore(containers, rules, "vault-test");
containerStore.ensureDefault();
const work = containerStore.create("Work");
containerStore.assignOrigin("github.com", work.id);
assert.equal(containerStore.resolveForUrl("https://docs.github.com/x", "default"), work.id);
assert.equal(containerStore.assignmentForHostname("docs.github.com")?.containerId, work.id);
assert.notEqual(containerStore.get("default").partition, work.partition);
assert.equal(containerStore.get(work.id).id, work.id, "an explicitly selected container must remain selectable");
assert.equal(
  containerStore.routingStatus("https://docs.github.com/x", "default", "https://docs.github.com", "opener")?.bypassingAssignment,
  true,
  "an opener-inherited cross-container open must be visible as a site-assignment bypass",
);
assert.equal(
  containerStore.routingStatus("https://docs.github.com/x", "default", "https://docs.github.com", "opener")?.bypassReason,
  "opener",
  "opener-inherited context must be distinguishable from an explicit user override",
);
assert.equal(
  containerStore.routingStatus("https://docs.github.com/x", work.id)?.bypassingAssignment,
  false,
);
assert.equal(
  containerStore.bypassOriginForExplicitContainer("https://github.com/openai/example", "default"),
  "https://github.com",
  "explicitly opening an assigned site in another container must create an origin-scoped bypass",
);

const search = containerStore.create("Search");
const personal = containerStore.create("Personal");
containerStore.assignOrigin("google.com", search.id);
containerStore.assignOrigin("chatgpt.com", personal.id);
assert.equal(
  containerStore.resolveForUrl("https://accounts.google.com/o/oauth2/v2/auth", personal.id),
  search.id,
  "a standalone accounts.google.com navigation still follows the google.com Search assignment",
);
const googleAuthInPersonal = containerStore.routingStatus(
  "https://accounts.google.com/o/oauth2/v2/auth",
  personal.id,
  "https://accounts.google.com",
  "opener",
);
assert.equal(googleAuthInPersonal?.assignedContainerId, search.id);
assert.equal(googleAuthInPersonal?.bypassingAssignment, true);
assert.equal(
  googleAuthInPersonal?.bypassReason,
  "opener",
  "Google auth spawned from ChatGPT Personal must retain the opener's Personal session instead of jumping to Search",
);
assert.equal(
  containerStore.openerBypassOriginForCommittedUrl(
    "https://accounts.google.com/o/oauth2/v2/auth",
    personal.id,
  ),
  "https://accounts.google.com",
  "an OAuth redirect onto a differently assigned origin must keep opener affinity",
);
assert.equal(
  containerStore.openerBypassOriginForCommittedUrl("https://chatgpt.com/auth/callback", personal.id),
  undefined,
  "opener affinity may end once the flow returns to a site normally assigned to the opener container",
);
assert.equal(
  containerStore.bypassOriginForExplicitContainer("https://github.com/openai/example", work.id),
  undefined,
);

const bookmarkStore = new BookmarkStore(state.bookmarks);
const folder = bookmarkStore.addFolder("Research");
const bookmarkA = bookmarkStore.addBookmark({ title: "A", url: "https://a.example", parentId: folder.id });
assert.equal(bookmarkStore.children(folder.id).length, 1);
const subfolder = bookmarkStore.addFolder("Sub", folder.id);
const bookmarkB = bookmarkStore.addBookmark({ title: "B", url: "https://b.example", parentId: subfolder.id });
assert.deepEqual(
  bookmarkStore.descendantBookmarks(folder.id).map((entry) => entry.id).sort(),
  [bookmarkA.id, bookmarkB.id].sort(),
);
assert.equal(bookmarkStore.moveFolder(folder.id, subfolder.id), false, "bookmark folders must reject cycles");
assert.equal(bookmarkStore.moveBookmark(bookmarkA.id, null), true);
assert.equal(bookmarkStore.getBookmark(bookmarkA.id)?.parentId, null);
assert.equal(bookmarkStore.isBookmarked("https://a.example/#section"), true, "bookmark matching should ignore fragments");
assert.equal(
  bookmarkStore.addBookmark({ title: "Duplicate A", url: "https://a.example" }).id,
  bookmarkA.id,
  "adding the same URL must reuse the existing bookmark instead of duplicating it",
);
assert.equal(bookmarkStore.setFavorite(bookmarkA.id, true), true);
assert.equal(bookmarkStore.favorites()[0]?.id, bookmarkA.id);
assert.equal(bookmarkStore.updateBookmark(bookmarkA.id, { visualKind: "text", visualValue: "A" }), true);
assert.equal(bookmarkStore.getBookmark(bookmarkA.id)?.visualValue, "A");
assert.equal(bookmarkStore.toggleBookmark({ title: "A", url: "https://a.example" }).bookmarked, false);
assert.equal(bookmarkStore.isBookmarked("https://a.example"), false);

const obsidianBookmarkSnapshot = normalizeObsidianBookmarkItems([
  {
    type: "group",
    title: "Research",
    items: [
      { type: "url", title: "OpenAI", url: "https://openai.com/" },
      {
        type: "group",
        title: "Docs",
        items: [
          { type: "url", title: "Example", url: "https://example.com/docs" },
          { type: "file", title: "Vault note", path: "Notes/Test.md" },
        ],
      },
    ],
  },
  { type: "search", title: "Search", path: "tag:#browser" },
]);
assert.equal(obsidianBookmarkSnapshot.available, true);
assert.equal(obsidianBookmarkSnapshot.entries.length, 2);
assert.deepEqual(obsidianBookmarkSnapshot.entries[0]?.folderPath, ["Research"]);
assert.deepEqual(obsidianBookmarkSnapshot.entries[1]?.folderPath, ["Research", "Docs"]);
assert.equal(obsidianBookmarkSnapshot.skippedNonWeb, 2, "Vault-native Obsidian bookmarks must stay out of Browser Core web bookmarks");

const importState = BrowserCore.normalize(null);
const importStore = new BookmarkStore(importState.bookmarks);
const firstImport = importStore.importWebBookmarks(obsidianBookmarkSnapshot.entries);
assert.deepEqual(firstImport, { added: 2, reused: 0, foldersCreated: 2 });
assert.equal(importStore.findByUrl("https://openai.com")?.parentId !== null, true);
assert.equal(importStore.folders().length, 2);
const secondImport = importStore.importWebBookmarks(obsidianBookmarkSnapshot.entries);
assert.deepEqual(secondImport, { added: 0, reused: 2, foldersCreated: 0 }, "Obsidian bookmark import must be idempotent");

const webViewerSnapshot = normalizeWebViewerBookmarks({
  bookmarks: [
    { url: "https://example.com/search?q={{selection}}", title: "Search", ribbon: true, lucide: "search" },
    { url: "https://docs.example/", title: "", ribbon: false, lucide: "" },
    { url: "file:///local", title: "Local" },
    { url: "not a URL", title: "Invalid" },
  ],
});
assert.equal(webViewerSnapshot.available, true);
assert.equal(webViewerSnapshot.skippedInvalid, 2);
assert.deepEqual(webViewerSnapshot.entries.map(({ title, favorite, visualKind, visualValue }) => ({
  title, favorite, visualKind, visualValue,
})), [
  { title: "Search", favorite: true, visualKind: "icon", visualValue: "search" },
  { title: "docs.example", favorite: false, visualKind: "icon", visualValue: "bookmark" },
]);
const webViewerStore = new BookmarkStore(BrowserCore.normalize(null).bookmarks);
assert.deepEqual(webViewerStore.importWebBookmarks(webViewerSnapshot.entries), { added: 2, reused: 0, foldersCreated: 0 });
assert.equal(webViewerStore.findByUrl("https://example.com/search?q={{selection}}")?.favorite, true);
assert.equal(webViewerStore.findByUrl("https://example.com/search?q={{selection}}")?.visualValue, "search");
assert.deepEqual(webViewerStore.importWebBookmarks(webViewerSnapshot.entries), { added: 0, reused: 2, foldersCreated: 0 });
assert.equal(normalizeWebViewerBookmarks({ bookmarks: "invalid" }).available, false);
let webViewerDataPath = "";
const webViewerAdapter = new WebViewerBookmarksAdapter({
  vault: {
    configDir: ".custom-obsidian",
    adapter: {
      exists: async (path: string) => {
        webViewerDataPath = path;
        return true;
      },
      read: async () => JSON.stringify({ bookmarks: [{ url: "https://example.com", title: "Example" }] }),
    },
  },
} as any);
assert.equal((await webViewerAdapter.scan()).entries.length, 1);
assert.equal(webViewerDataPath, ".custom-obsidian/plugins/webviewer-bookmarks/data.json");

const legacyBookmarkState = BrowserCore.normalize({
  settings: { showBookmarkBar: false } as any,
  bookmarks: {
    folders: {},
    bookmarks: {
      legacy: {
        id: "legacy",
        kind: "bookmark",
        parentId: null,
        title: "Legacy",
        url: "https://legacy.example",
        order: 0,
        createdAt: 1,
      } as any,
    },
  },
} as any);
assert.equal(legacyBookmarkState.version, 6);
assert.equal(legacyBookmarkState.settings.showFavoritesBar, false, "legacy bookmark-bar visibility must migrate to favorites bar visibility");
assert.equal(legacyBookmarkState.bookmarks.bookmarks.legacy?.favorite, true, "legacy root bookmarks must remain visible as favorites after migration");
assert.equal(legacyBookmarkState.bookmarks.bookmarks.legacy?.visualKind, "favicon");

const duplicateBookmarkState = BrowserCore.normalize({
  bookmarks: {
    folders: {},
    bookmarks: {
      first: {
        id: "first",
        kind: "bookmark",
        parentId: null,
        title: "First",
        url: "https://duplicate.example/page#one",
        order: 0,
        createdAt: 1,
        favorite: true,
        favoriteOrder: 0,
        visualKind: "favicon",
      },
      second: {
        id: "second",
        kind: "bookmark",
        parentId: null,
        title: "Second",
        url: "https://duplicate.example/page#two",
        order: 1,
        createdAt: 2,
        favorite: true,
        favoriteOrder: 1,
        visualKind: "text",
        visualValue: "D",
      },
    },
  },
} as any);
assert.equal(Object.keys(duplicateBookmarkState.bookmarks.bookmarks).length, 1, "legacy duplicate URLs must merge into one bookmark");
assert.equal(duplicateBookmarkState.bookmarks.bookmarks.first?.favorite, true);
assert.equal(duplicateBookmarkState.bookmarks.bookmarks.first?.visualKind, "text", "custom bookmark visuals must survive duplicate migration");
assert.equal(duplicateBookmarkState.bookmarks.bookmarks.first?.visualValue, "D");

const modeState = BrowserCore.normalize(null);
const modeCore = new BrowserCore({} as any, modeState, { save: async () => undefined }, "test-mode");
const modeWork = modeCore.containers.create("Work");
modeCore.containers.assignOrigin("example.com", modeWork.id);
modeState.settings.containerMode = "manual";
assert.equal(modeCore.resolveContainerForNavigation("https://example.com", "default"), "default", "manual container mode must not apply site defaults automatically");
modeState.settings.containerMode = "automatic";
assert.equal(modeCore.resolveContainerForNavigation("https://example.com", "default"), modeWork.id);
modeState.settings.containerMode = "off";
modeState.settings.defaultContainerId = modeWork.id;
assert.equal(modeCore.defaultContainerForNewTab(), modeWork.id, "container-off mode must retain the selected default profile, including a migrated Surfing profile");

const restore = new RestoreStore(state);
state.history.leaves["leaf-a"]!.pinned = true;
restore.put({ leafId: "leaf-a", capturedAt: 0, entries: [{ url: "https://a.example" }], index: 0 });
restore.sweep({ ...state.settings, restoreRetentionDays: 0, restoreStorageLimitMb: 16 }, Date.now());
assert.ok(restore.get("leaf-a"), "pinned tabs must protect restore capsules from staleness");
assert.equal(restore.clearAll(), 1);
assert.equal(restore.get("leaf-a"), undefined, "rich restore data must be independently clearable");

const nodeProtectedState = BrowserCore.normalize(null);
const nodeProtectedHistory = new HistoryGraph(nodeProtectedState.history);
nodeProtectedHistory.beginLeaf({ leafId: "node-protected", containerId: "default" });
const nodeProtectedNav = nodeProtectedHistory.addNavigation({
  leafId: "node-protected",
  containerId: "default",
  url: "https://protected-node.example",
});
nodeProtectedNav.manualRetention = "preserve";
const nodeProtectedRestore = new RestoreStore(nodeProtectedState);
nodeProtectedRestore.put({
  leafId: "node-protected",
  capturedAt: 0,
  entries: [{ url: "https://protected-node.example" }],
  index: 0,
});
nodeProtectedRestore.sweep(
  { ...nodeProtectedState.settings, restoreRetentionDays: 0, restoreStorageLimitMb: 16 },
  Date.now(),
);
assert.ok(
  nodeProtectedRestore.get("node-protected"),
  "a DO NOT STALE navigation node must protect its leaf-level restore capsule",
);

const linearState = BrowserCore.normalize(null);
const linearHistory = new HistoryGraph(linearState.history);
linearHistory.beginLeaf({ leafId: "leaf-linear", containerId: "default" });
const linearA = linearHistory.addNavigation({ leafId: "leaf-linear", containerId: "default", url: "https://a.example" });
const linearB = linearHistory.addNavigation({ leafId: "leaf-linear", containerId: "default", url: "https://b.example" });
const linearC = linearHistory.addNavigation({ leafId: "leaf-linear", containerId: "default", url: "https://c.example" });
assert.ok(linearA && linearC);
linearHistory.deleteNode(linearB.id);
assert.equal(linearHistory.canRemoveTombstone(linearB.id).ok, true);
assert.equal(linearHistory.removeTombstone(linearB.id).ok, true);
assert.ok(
  linearState.history.edges.some((edge) => edge.from === linearA.id && edge.to === linearC.id),
  "linear tombstones should contract without losing path continuity",
);

const permissionStore = new PermissionStore(state.permissions);
permissionStore.set("default", "https://example.com", "notifications", "allow");
assert.equal(permissionStore.decision("default", "https://example.com", "notifications"), "allow");
permissionStore.set("default", "https://example.com", "camera", "block");
assert.deepEqual(
  permissionStore.listForOrigin("default", "https://example.com").map((record) => record.permission),
  ["camera", "notifications"],
);
permissionStore.remove("default", "https://example.com", "notifications");
assert.equal(permissionStore.decision("default", "https://example.com", "notifications"), "ask");
permissionStore.set("default", "https://example.com", "geolocation", "allow");
assert.ok(permissionStore.clearAll() > 0);
assert.equal(permissionStore.list().length, 0, "permission reset must clear Browser Core permission decisions");
assert.equal(permissionLabel("openExternal"), "Open external links");
assert.equal(permissionLabel("storage-access"), "Site storage access");
assert.equal(permissionLabel("someNewPermission"), "Some New Permission");
assert.equal(permissionDecisionLabel("ask"), "Ask next time");

const formRecovery = new FormRecoveryStore(state);
assert.equal(
  formRecovery.isEnabledForUrl("default", "https://unconfigured.example/form"),
  false,
  "form recovery must require an explicit per-site opt-in",
);
assert.equal(formRecovery.enableSite("default", "https://secure.example/checkout"), true);
assert.equal(
  formRecovery.put(
    "default",
    "https://secure.example/checkout",
    [{ type: "text", name: "card-number", label: "Credit card number", value: "4111111111111111" }],
    state.settings,
  ),
  undefined,
  "credential and payment-like fields must be rejected by the store even if page-side filtering misses them",
);
assert.equal(formRecovery.enableSite("default", "https://forms.example/form"), true);
formRecovery.put("default", "https://forms.example/form", [
  { type: "text", name: "name", label: "Name", value: "Yui" },
], state.settings);
formRecovery.put("default", "https://forms.example/form", [
  { type: "text", name: "reason", label: "Reason", value: "Because" },
], state.settings);
assert.equal(
  formRecovery.recoveryFields("default", "https://forms.example/form").length,
  2,
  "multi-step form recovery should merge semantic fields across checkpoints",
);
assert.equal(
  formRecovery.excludeField("default", "https://forms.example/form", { type: "text", name: "reason", label: "Reason" }),
  true,
);
assert.equal(formRecovery.recoveryFields("default", "https://forms.example/form").length, 1, "field exclusions must apply to stored recovery data");
assert.equal(formRecovery.disableSite("default", "https://forms.example/form"), true);
assert.equal(formRecovery.isEnabledForUrl("default", "https://forms.example/other"), false, "site policies must apply by origin");
assert.equal(formRecovery.recoveryFields("default", "https://forms.example/form").length, 0);
assert.equal(formRecovery.enableSite("default", "https://forms.example/form"), true);

const documentRecoveryState = BrowserCore.normalize(null);
const documentRecovery = new FormRecoveryStore(documentRecoveryState);
assert.equal(documentRecovery.enableSite("default", "https://forms.example/form?step=1"), true);
documentRecovery.put("default", "https://forms.example/form?step=1", [
  { type: "text", name: "name", label: "Name", value: "Yui" },
], documentRecoveryState.settings);
assert.equal(
  documentRecovery.recoveryFields("default", "https://forms.example/form?step=2").length,
  0,
  "exact form-recovery lookup must keep its URL-scoped contract",
);
assert.equal(
  documentRecovery.recoveryFieldsForDocument("default", "https://forms.example/form?step=2")[0]?.value,
  "Yui",
  "a multi-step form may recover from another query variant on the same origin and pathname",
);
assert.equal(
  documentRecovery.recoveryFieldsForDocument("default", "https://forms.example/other?step=2").length,
  0,
  "document fallback must not cross path boundaries",
);
assert.equal(documentRecovery.enableSite("default", "https://other.example/form?step=2"), true);
assert.equal(
  documentRecovery.recoveryFieldsForDocument("default", "https://other.example/form?step=2").length,
  0,
  "document fallback must not cross origin boundaries",
);
assert.equal(documentRecovery.enableSite("work-container", "https://forms.example/form?step=2"), true);
assert.equal(
  documentRecovery.recoveryFieldsForDocument("work-container", "https://forms.example/form?step=2").length,
  0,
  "document fallback must not cross browser-container boundaries",
);
documentRecovery.put("default", "https://forms.example/form?step=2", [
  { type: "textarea", name: "reason", label: "Reason", value: "Because" },
], documentRecoveryState.settings);
assert.deepEqual(
  documentRecovery.recoveryFieldsForDocument("default", "https://forms.example/form?step=2").map((field) => field.value),
  ["Because"],
  "an exact URL snapshot must take precedence over related query-variant fallback data",
);

assert.equal(formRecovery.enableSite(work.id, "https://forms.example/form"), true);
formRecovery.put(work.id, "https://forms.example/form", [
  { type: "text", name: "name", label: "Name", value: "Work identity" },
], state.settings);
assert.equal(
  formRecovery.recoveryFields(work.id, "https://forms.example/form")[0]?.value,
  "Work identity",
  "form recovery values must be scoped to their browser container",
);
assert.equal(
  formRecovery.recoveryFields("default", "https://forms.example/form").length,
  0,
  "a site opt-in and recovery value in one container must not leak into another container",
);
const clearedWorkRecovery = formRecovery.clearContainer(work.id);
assert.equal(clearedWorkRecovery.snapshots, 1);
assert.equal(clearedWorkRecovery.policies, 1);
assert.equal(
  formRecovery.recoveryFields(work.id, "https://forms.example/form").length,
  0,
  "deleting a container must be able to discard recovery data owned by that web identity",
);

const cappedRecoveryState = BrowserCore.normalize(null);
const cappedRecovery = new FormRecoveryStore(cappedRecoveryState);
const cappedSettings = { ...cappedRecoveryState.settings, formRecoveryMaxSnapshotsPerUrl: 1, formRecoveryMaxUrls: 1 };
assert.equal(cappedRecovery.enableSite("default", "https://one.example/form"), true);
cappedRecovery.put("default", "https://one.example/form", [{ type: "text", name: "a", value: "1" }], cappedSettings);
cappedRecovery.put("default", "https://one.example/form", [{ type: "text", name: "a", value: "2" }], cappedSettings);
assert.equal(cappedRecovery.latest("default", "https://one.example/form")?.fields[0]?.value, "2");
assert.equal(Object.values(cappedRecoveryState.formRecovery)[0]?.length, 1, "per-URL form recovery generations must be bounded");
assert.equal(cappedRecovery.enableSite("default", "https://two.example/form"), true);
cappedRecovery.put("default", "https://two.example/form", [{ type: "text", name: "b", value: "3" }], cappedSettings);
assert.equal(Object.keys(cappedRecoveryState.formRecovery).length, 1, "form recovery URL count must be bounded");

const legacyRecoveryState = BrowserCore.normalize(null);
(legacyRecoveryState.formRecovery as any)["https://legacy.example/form"] = [{
  id: "legacy-form",
  url: "https://legacy.example/form",
  capturedAt: 1,
  fields: [{ type: "text", name: "legacy", value: "kept" }],
}];
(legacyRecoveryState.formRecoveryPolicies as any)["https://legacy.example"] = {
  origin: "https://legacy.example",
  disabled: false,
  excludedFieldKeys: [],
  updatedAt: 1,
};
const migratedRecovery = new FormRecoveryStore(legacyRecoveryState);
assert.equal(
  migratedRecovery.recoveryFields("default", "https://legacy.example/form")[0]?.value,
  "kept",
  "legacy unscoped form recovery must migrate into the Default container",
);

const retentionState = BrowserCore.normalize(null);
const retentionHistory = new HistoryGraph(retentionState.history);
retentionHistory.beginLeaf({ leafId: "old-leaf", containerId: "default" });
retentionHistory.addNavigation({ leafId: "old-leaf", containerId: "default", url: "https://old.example", timestamp: 1 });
retentionState.history.leaves["old-leaf"]!.closedAt = 1;
const historyRemoved = retentionHistory.sweep({ historyRetentionDays: 1, historyMaxNodes: 1000 }, 3 * 24 * 60 * 60 * 1000);
assert.ok(historyRemoved > 0, "expired closed history should be removable by retention policy");

const protectedRetentionState = BrowserCore.normalize(null);
const protectedRetentionHistory = new HistoryGraph(protectedRetentionState.history);
protectedRetentionHistory.beginLeaf({
  leafId: "protected-leaf",
  containerId: "default",
  manualRetention: "preserve",
});
protectedRetentionHistory.addNavigation({
  leafId: "protected-leaf",
  containerId: "default",
  url: "https://protected.example",
  timestamp: 1,
});
protectedRetentionState.history.leaves["protected-leaf"]!.closedAt = 1;
assert.equal(
  protectedRetentionHistory.sweep({ historyRetentionDays: 1, historyMaxNodes: 1000 }, 3 * 24 * 60 * 60 * 1000),
  0,
  "DO NOT STALE lifecycles must survive history retention sweeping",
);

const clearHistoryState = BrowserCore.normalize(null);
const clearHistory = new HistoryGraph(clearHistoryState.history);
clearHistory.beginLeaf({ leafId: "clear-leaf", containerId: "default" });
clearHistory.addNavigation({
  leafId: "clear-leaf",
  containerId: "default",
  url: "https://clear.example",
});
const clearedHistory = clearHistory.clearAll();
assert.equal(clearedHistory.nodes, 1);
assert.equal(clearHistory.allNodes().length, 0);
assert.equal(clearHistory.recentlyClosed().length, 0);

assert.equal(state.sessionCheckpoint.leaves.length, 0);
assert.equal(state.settings.startupBehavior, "restore");
const zoom = new SiteZoomStore(state.siteZoom);
assert.equal(zoom.factorForUrl("https://example.com/a"), 1);
assert.equal(zoom.setForUrl("https://example.com/a", 1.25), 1.25);
assert.equal(zoom.factorForUrl("https://example.com/b"), 1.25, "site zoom should follow the origin rather than a single leaf");
zoom.reset("https://example.com/c");
assert.equal(zoom.factorForUrl("https://example.com/d"), 1);
const defaultZoomState: Record<string, number> = {};
let defaultZoom = 1.2;
const defaultZoomStore = new SiteZoomStore(defaultZoomState, () => defaultZoom);
assert.equal(defaultZoomStore.factorForUrl("https://example.com"), 1.2);
defaultZoomStore.setForUrl("https://example.com", 1.5);
assert.equal(defaultZoomStore.factorForUrl("https://example.com/page"), 1.5);
defaultZoomStore.reset("https://example.com");
assert.equal(defaultZoomStore.factorForUrl("https://example.com"), 1.2);
defaultZoom = 1.3;
assert.equal(defaultZoomStore.factorForUrl("https://example.com"), 1.3);

const restoreLineageState = BrowserCore.normalize(null);
const restoreLineage = new HistoryGraph(restoreLineageState.history);
restoreLineage.beginLeaf({ leafId: "old-leaf", containerId: "default" });
const oldNode = restoreLineage.addNavigation({
  leafId: "old-leaf",
  containerId: "default",
  url: "https://old.example",
});
restoreLineage.closeLeaf("old-leaf");
restoreLineage.beginLeaf({
  leafId: "new-leaf",
  containerId: "default",
  restoredFromLeafId: "old-leaf",
});
const restoredNode = restoreLineage.addNavigation({
  leafId: "new-leaf",
  containerId: "default",
  url: "https://old.example",
});
assert.ok(
  restoreLineageState.history.edges.some(
    (edge) => edge.kind === "restore" && edge.from === oldNode.id && edge.to === restoredNode.id,
  ),
  "restored leaf lifecycles should be connected by an explicit restore edge",
);

let persistedFallback: any = null;
const hybrid = new HybridBrowserPersistence("smoke", {
  load: async () => persistedFallback,
  save: async (value) => { persistedFallback = value; },
});
const persistenceState = BrowserCore.normalize(null);
persistenceState.history.leaves.persisted = {
  id: "persisted",
  openedAt: 1,
  containerId: "default",
  pinned: false,
  manualRetention: "default",
  lastActiveAt: 1,
};
await hybrid.save(persistenceState);
const reloadedFallback = await hybrid.load();
assert.ok(reloadedFallback?.history?.leaves.persisted, "hybrid persistence fallback must preserve heavy state when IndexedDB is unavailable");

console.log("core smoke tests passed");
