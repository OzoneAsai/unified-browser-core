import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
  TFile,
  type App,
  type SearchResultContainer,
  type WorkspaceLeaf,
} from "obsidian";

export interface VaultHomeFile {
  path: string;
  name: string;
  extension: string;
  matchedAlias?: string;
}

type RankedVaultFile = SearchResultContainer & {
  file: TFile;
  matchedAlias?: string;
};

type BookmarkItemLike = {
  type?: string;
  path?: string;
  title?: string;
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
};

export class ObsidianHomeAdapter {
  constructor(private readonly app: App) {}

  searchFiles(query: string, limit = 8): VaultHomeFile[] {
    const needle = query.trim();
    if (!needle) return [];
    const normalizedNeedle = needle.toLocaleLowerCase();
    const fuzzy = prepareFuzzySearch(needle);
    const nameMatches: RankedVaultFile[] = [];
    const pathMatches: RankedVaultFile[] = [];

    for (const file of this.app.vault.getFiles()) {
      const fileNameMatches: RankedVaultFile[] = [];
      const basenameMatch = fuzzy(file.basename);
      if (basenameMatch) fileNameMatches.push({ file, match: basenameMatch });
      if (file.extension === "md") {
        const aliases = parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter ?? null) ?? [];
        for (const alias of aliases) {
          const aliasMatch = fuzzy(alias);
          if (aliasMatch) fileNameMatches.push({ file, match: aliasMatch, matchedAlias: alias });
        }
      }
      if (fileNameMatches.length) {
        sortSearchResults(fileNameMatches);
        nameMatches.push(fileNameMatches[0]!);
        continue;
      }
      // Home Tab is filename-first. Keep path lookup as a useful extension,
      // but require the user text to occur contiguously in the path so weak
      // fuzzy coincidences in generated assets do not fill the Home results.
      if (!file.path.toLocaleLowerCase().includes(normalizedNeedle)) continue;
      const pathMatch = fuzzy(file.path);
      if (pathMatch) pathMatches.push({ file, match: pathMatch });
    }

    sortSearchResults(nameMatches);
    sortSearchResults(pathMatches);
    return [...nameMatches, ...pathMatches]
      .slice(0, limit)
      .map(({ file, matchedAlias }) => ({
        ...toHomeFile(file),
        matchedAlias,
      }));
  }

  recentFiles(limit = 6): VaultHomeFile[] {
    return this.app.workspace
      .getLastOpenFiles()
      .flatMap((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? [toHomeFile(file)] : [];
      })
      .slice(0, limit);
  }

  bookmarkedFiles(limit = 8): VaultHomeFile[] {
    const internal = (this.app as App & { internalPlugins?: InternalPluginsLike }).internalPlugins;
    const plugin = internal?.getPluginById?.("bookmarks");
    const items = plugin?.instance?.getBookmarks?.() ?? plugin?.instance?.items ?? [];
    return flattenBookmarkItems(items)
      .flatMap((item) => {
        if (item.type !== "file" || !item.path) return [];
        const file = this.app.vault.getAbstractFileByPath(item.path);
        return file instanceof TFile ? [toHomeFile(file)] : [];
      })
      .slice(0, limit);
  }

  async openFile(leaf: WorkspaceLeaf, path: string, newTab = false): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const target = newTab ? this.app.workspace.getLeaf("tab") : leaf;
    await target.openFile(file);
    if (newTab) await this.app.workspace.revealLeaf(target);
    return true;
  }
}

function flattenBookmarkItems(items: BookmarkItemLike[]): BookmarkItemLike[] {
  const result: BookmarkItemLike[] = [];
  const visit = (item: BookmarkItemLike) => {
    result.push(item);
    for (const child of item.items ?? item.children ?? []) visit(child);
  };
  for (const item of items) visit(item);
  return result;
}

function toHomeFile(file: TFile): VaultHomeFile {
  return {
    path: file.path,
    name: file.basename || file.name,
    extension: file.extension,
  };
}
