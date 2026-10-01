import type { App } from "obsidian";

export interface ObsidianWebBookmarkImportEntry {
  title: string;
  url: string;
  folderPath: string[];
}

export interface ObsidianBookmarkImportSnapshot {
  available: boolean;
  source: "runtime" | "bookmarks-json" | "none";
  entries: ObsidianWebBookmarkImportEntry[];
  skippedNonWeb: number;
}

type BookmarkItemLike = {
  type?: string;
  title?: string;
  url?: string;
  path?: string;
  items?: BookmarkItemLike[];
  children?: BookmarkItemLike[];
};

type BookmarksPluginLike = {
  enabled?: boolean;
  instance?: {
    getBookmarks?: () => BookmarkItemLike[];
    items?: BookmarkItemLike[];
  };
};

type InternalPluginsLike = {
  getPluginById?: (id: string) => BookmarksPluginLike | undefined;
  plugins?: Record<string, BookmarksPluginLike | undefined>;
};

type BookmarkFileLike = {
  items?: BookmarkItemLike[];
};

export class ObsidianBookmarksAdapter {
  constructor(private readonly app: App) {}

  async scan(): Promise<ObsidianBookmarkImportSnapshot> {
    const runtimeItems = this.runtimeItems();
    if (runtimeItems) return normalizeObsidianBookmarkItems(runtimeItems, "runtime");

    const fileItems = await this.fileItems();
    if (fileItems) return normalizeObsidianBookmarkItems(fileItems, "bookmarks-json");

    return { available: false, source: "none", entries: [], skippedNonWeb: 0 };
  }

  private runtimeItems(): BookmarkItemLike[] | undefined {
    const internal = (this.app as App & { internalPlugins?: InternalPluginsLike }).internalPlugins;
    const plugin = internal?.getPluginById?.("bookmarks") ?? internal?.plugins?.bookmarks;
    if (!plugin?.instance) return undefined;
    const items = plugin.instance.getBookmarks?.() ?? plugin.instance.items;
    return Array.isArray(items) ? items : undefined;
  }

  private async fileItems(): Promise<BookmarkItemLike[] | undefined> {
    const vault = this.app.vault as typeof this.app.vault & { configDir?: string };
    const configDir = vault.configDir || ".obsidian";
    const path = `${configDir}/bookmarks.json`;
    try {
      if (!(await vault.adapter.exists(path))) return undefined;
      const raw = JSON.parse(await vault.adapter.read(path)) as BookmarkFileLike | BookmarkItemLike[];
      const items = Array.isArray(raw) ? raw : raw?.items;
      return Array.isArray(items) ? items : undefined;
    } catch {
      return undefined;
    }
  }
}

export function normalizeObsidianBookmarkItems(
  items: BookmarkItemLike[],
  source: ObsidianBookmarkImportSnapshot["source"] = "runtime",
): ObsidianBookmarkImportSnapshot {
  const entries: ObsidianWebBookmarkImportEntry[] = [];
  let skippedNonWeb = 0;

  const visit = (item: BookmarkItemLike, folderPath: string[]) => {
    const type = item.type?.toLowerCase();
    if (type === "group") {
      const nextPath = item.title?.trim() ? [...folderPath, item.title.trim()] : folderPath;
      for (const child of item.items ?? item.children ?? []) visit(child, nextPath);
      return;
    }

    const candidate = (type === "url" || type === "link") ? item.url ?? item.path : undefined;
    if (candidate && isWebUrl(candidate)) {
      entries.push({
        title: item.title?.trim() || candidate,
        url: candidate.trim(),
        folderPath,
      });
      return;
    }

    // Obsidian Bookmarks also stores files, folders, searches and other
    // Vault-native targets. Browser Core intentionally imports only web URLs;
    // the source plugin remains untouched so those entries are not lost.
    skippedNonWeb += 1;
  };

  for (const item of items) visit(item, []);
  return { available: true, source, entries, skippedNonWeb };
}

function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
