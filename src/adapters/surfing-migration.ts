import type { App, WorkspaceLeaf } from "obsidian";
import type { ImportedWebBookmark } from "../bookmarks/bookmark-store";
import type { BrowserTransientHistoryEntry } from "../core/model";
import { resolveGuestWebContents } from "./electron-compat";
import type { WebviewElement } from "../ui/webview-types";

export interface SurfingMigrationTab {
  sourceKey: string;
  url: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  history: BrowserTransientHistoryEntry[];
  historyIndex: number;
}

export interface SurfingMigrationSnapshot {
  sourcePartition: string;
  settingsPath: string;
  bookmarksPath: string;
  settings: Record<string, unknown> | null;
  bookmarksRaw: unknown;
  bookmarks: ImportedWebBookmark[];
  folderPaths: string[][];
  tabs: SurfingMigrationTab[];
  invalidBookmarks: number;
  invalidTabs: number;
  warnings: string[];
  settingsFound: boolean;
  bookmarksFound: boolean;
  bookmarksValid: boolean;
  tabsSource: "live" | "workspace" | "none";
}

export class SurfingMigrationAdapter {
  constructor(private readonly app: App) {}

  async scan(): Promise<SurfingMigrationSnapshot> {
    const vault = this.app.vault as typeof this.app.vault & { configDir?: string };
    const configDir = vault.configDir || ".obsidian";
    const appId = (this.app as App & { appId?: string }).appId;
    if (!appId) throw new Error("Obsidian did not expose a vault app ID, so the Surfing profile cannot be identified safely.");
    const settingsPath = `${configDir}/plugins/surfing/data.json`;
    const bookmarksPath = `${configDir}/surfing-bookmark.json`;
    const warnings: string[] = [];
    const settingsResult = await this.readJson(settingsPath, warnings);
    const bookmarksResult = await this.readJson(bookmarksPath, warnings);
    const settings = isRecord(settingsResult.data) ? settingsResult.data : null;
    if (settingsResult.found && !settings) warnings.push("Surfing settings have an unsupported format.");
    const parsedBookmarks = normalizeSurfingBookmarks(bookmarksResult.data);
    if (bookmarksResult.found && !parsedBookmarks.valid) warnings.push("Surfing bookmarks have an unsupported format.");
    if (parsedBookmarks.invalid) warnings.push(`${parsedBookmarks.invalid} invalid Surfing bookmark(s) cannot be opened; their source records are preserved in the backup.`);

    const liveLeaves = this.app.workspace.getLeavesOfType("surfing-view");
    const liveTabs = liveLeaves.map((leaf) => tabFromLeaf(leaf, this.app.workspace.activeLeaf))
      .filter((tab): tab is SurfingMigrationTab => Boolean(tab));
    const savedTabs = liveTabs.length ? [] : await this.savedWorkspaceTabs(`${configDir}/workspace.json`, warnings);
    const tabs = liveTabs.length ? liveTabs : savedTabs;
    const invalidTabs = liveLeaves.length > 0 ? liveLeaves.length - liveTabs.length : 0;
    if (invalidTabs) warnings.push(`${invalidTabs} Surfing tab(s) have URLs Browser Core cannot open; the source layout is left untouched.`);

    return {
      sourcePartition: `persist:surfing-vault-${appId}`,
      settingsPath,
      bookmarksPath,
      settings,
      bookmarksRaw: bookmarksResult.data,
      bookmarks: parsedBookmarks.entries,
      folderPaths: surfingFolderPaths(bookmarksResult.data),
      tabs,
      invalidBookmarks: parsedBookmarks.invalid,
      invalidTabs,
      warnings,
      settingsFound: settingsResult.found,
      bookmarksFound: bookmarksResult.found,
      bookmarksValid: parsedBookmarks.valid,
      tabsSource: liveTabs.length ? "live" : savedTabs.length ? "workspace" : "none",
    };
  }

  private async readJson(path: string, warnings: string[]): Promise<{ found: boolean; data: unknown }> {
    if (!(await this.app.vault.adapter.exists(path))) return { found: false, data: null };
    try {
      return { found: true, data: JSON.parse(await this.app.vault.adapter.read(path)) };
    } catch {
      warnings.push(`Could not read ${path}.`);
      return { found: true, data: null };
    }
  }

  private async savedWorkspaceTabs(path: string, warnings: string[]): Promise<SurfingMigrationTab[]> {
    if (!(await this.app.vault.adapter.exists(path))) return [];
    try {
      const root: unknown = JSON.parse(await this.app.vault.adapter.read(path));
      const tabs: SurfingMigrationTab[] = [];
      const visit = (value: unknown): void => {
        if (!isRecord(value)) {
          if (Array.isArray(value)) for (const child of value) visit(child);
          return;
        }
        if (value.type === "leaf" && isRecord(value.state) &&
          value.state.type === "surfing-view" && isRecord(value.state.state) && isWebUrl(value.state.state.url)) {
          tabs.push({
            sourceKey: `workspace-${tabs.length}`,
            url: value.state.state.url,
            pinned: value.pinned === true || value.state.pinned === true,
            active: false,
            history: [{ kind: "web", url: value.state.state.url }],
            historyIndex: 0,
          });
          return;
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(root);
      return tabs;
    } catch {
      warnings.push(`Could not read saved Surfing tabs from ${path}.`);
      return [];
    }
  }
}

export function normalizeSurfingBookmarks(data: unknown): { valid: boolean; entries: ImportedWebBookmark[]; invalid: number } {
  if (!isRecord(data) || !Array.isArray(data.bookmarks)) return { valid: false, entries: [], invalid: 0 };
  const entries: ImportedWebBookmark[] = [];
  let invalid = 0;
  for (const raw of data.bookmarks) {
    if (!isRecord(raw) || !isWebUrl(raw.url)) {
      invalid++;
      continue;
    }
    const folderPath = Array.isArray(raw.category)
      ? raw.category.filter((part): part is string => typeof part === "string")
        .map((part) => part.trim()).filter((part) => part.length > 0 && part.toUpperCase() !== "ROOT")
      : [];
    entries.push({
      title: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.url,
      url: raw.url,
      folderPath,
      favorite: folderPath.length === 0,
      description: typeof raw.description === "string" ? raw.description : undefined,
      tags: typeof raw.tags === "string" ? raw.tags.split(/\s+/).filter(Boolean) : undefined,
      createdAt: typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created : undefined,
    });
  }
  return { valid: true, entries, invalid };
}

export function surfingFolderPaths(data: unknown): string[][] {
  if (!isRecord(data) || !Array.isArray(data.categories)) return [];
  const paths: string[][] = [];
  const visit = (category: unknown, parent: string[]): void => {
    if (!isRecord(category)) return;
    const name = typeof category.text === "string" && category.text.trim()
      ? category.text.trim()
      : typeof category.value === "string" ? category.value.trim() : "";
    const path = name && name.toUpperCase() !== "ROOT" ? [...parent, name] : parent;
    if (path.length) paths.push(path);
    if (Array.isArray(category.children)) for (const child of category.children) visit(child, path);
  };
  for (const category of data.categories) visit(category, []);
  return paths;
}

export function surfingSearchTemplate(settings: Record<string, unknown> | null): string | undefined {
  if (!settings || typeof settings.defaultSearchEngine !== "string") return undefined;
  const selected = settings.defaultSearchEngine.toLowerCase();
  const custom = Array.isArray(settings.customSearchEngine)
    ? settings.customSearchEngine.find((entry) => isRecord(entry) &&
      typeof entry.name === "string" && entry.name.toLowerCase() === selected && typeof entry.url === "string")
    : undefined;
  const builtIn: Record<string, string> = {
    google: "https://www.google.com/search?q=",
    bing: "https://www.bing.com/search?q=",
    duckduckgo: "https://duckduckgo.com/?q=",
    yahoo: "https://search.yahoo.com/search?p=",
    baidu: "https://www.baidu.com/s?wd=",
    yandex: "https://yandex.com/search/?text=",
    wikipedia: "https://en.wikipedia.org/w/index.php?search=",
  };
  const raw = custom?.url ?? builtIn[selected];
  if (typeof raw !== "string" || !isWebUrl(raw)) return undefined;
  if (raw.includes("{query}")) return raw;
  if (raw.includes("%s")) return raw.replace("%s", "{query}");
  return raw + "{query}";
}

function tabFromLeaf(leaf: WorkspaceLeaf, activeLeaf: WorkspaceLeaf | null): SurfingMigrationTab | null {
  const viewState = leaf.getViewState();
  const state = isRecord(viewState.state) ? viewState.state : null;
  if (!state || !isWebUrl(state.url)) return null;
  const history = (leaf as WorkspaceLeaf & { history?: { backHistory?: unknown[]; forwardHistory?: unknown[] } }).history;
  const previous = (history?.backHistory ?? []).map(historyUrl).filter((url): url is string => Boolean(url));
  const forward = (history?.forwardHistory ?? []).map(historyUrl).filter((url): url is string => Boolean(url)).reverse();
  const entries = [...previous, state.url, ...forward].map((url): BrowserTransientHistoryEntry => ({ kind: "web", url }));
  const guestHistory = historyFromSurfingGuest(leaf, state.url);
  return {
    sourceKey: (leaf as WorkspaceLeaf & { id?: string }).id ?? `live-${state.url}`,
    url: state.url,
    title: leaf.view.getDisplayText(),
    pinned: Boolean((leaf as WorkspaceLeaf & { pinned?: boolean }).pinned),
    active: leaf === activeLeaf,
    history: guestHistory?.entries ?? entries,
    historyIndex: guestHistory?.index ?? previous.length,
  };
}

function historyFromSurfingGuest(
  leaf: WorkspaceLeaf,
  currentUrl: string,
): { entries: BrowserTransientHistoryEntry[]; index: number } | null {
  const webview = (leaf.view as typeof leaf.view & { webviewEl?: WebviewElement }).webviewEl;
  if (!webview) return null;
  const guest = resolveGuestWebContents<{
    navigationHistory?: {
      getAllEntries?: () => Array<{ url?: string; title?: string }>;
      getActiveIndex?: () => number;
    };
  }>(webview);
  const navigation = guest?.navigationHistory;
  if (!navigation?.getAllEntries) return null;
  try {
    const raw = navigation.getAllEntries();
    const rawIndex = navigation.getActiveIndex?.() ?? raw.length - 1;
    const entries: BrowserTransientHistoryEntry[] = [];
    let index = 0;
    for (let position = 0; position < raw.length; position++) {
      const entry = raw[position];
      if (!isWebUrl(entry?.url)) continue;
      if (position <= rawIndex) index = entries.length;
      entries.push({ kind: "web", url: entry.url, title: entry.title });
    }
    if (!entries.length) return null;
    if (entries[index]?.url !== currentUrl) {
      entries.push({ kind: "web", url: currentUrl });
      index = entries.length - 1;
    }
    return { entries, index };
  } catch {
    return null;
  }
}

function historyUrl(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.state.state)) return null;
  return isWebUrl(value.state.state.url) ? value.state.state.url : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}
