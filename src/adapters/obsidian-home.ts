import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
  TFile,
  normalizePath,
  type App,
  type SearchResultContainer,
  type WorkspaceLeaf,
} from "obsidian";
import { matchesHomeFilter, safeHomeNoteName, type HomeSearchFilter } from "../home/search-model";

export interface VaultHomeFile {
  path: string;
  name: string;
  extension: string;
  matchedAlias?: string;
  unresolved?: boolean;
  excerpt?: string;
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
    removeItem?: (item: BookmarkItemLike) => void;
  };
};

type InternalPluginsLike = {
  getPluginById?: (id: string) => BookmarksPluginLike | undefined;
};

type OmniResult = { path: string; basename: string; excerpt?: string };
type OmniAPI = { search: (query: string) => Promise<OmniResult[]> };
type OmnisearchPlugin = { api?: OmniAPI };

export class ObsidianHomeAdapter {
  constructor(private readonly app: App) {}

  searchFiles(query: string, limit = 8, filter?: HomeSearchFilter, markdownOnly = false, includeUnresolved = false): VaultHomeFile[] {
    const needle = query.trim();
    if (!needle) return [];
    const normalizedNeedle = needle.toLocaleLowerCase();
    const fuzzy = prepareFuzzySearch(needle);
    const nameMatches: RankedVaultFile[] = [];
    const pathMatches: RankedVaultFile[] = [];

    for (const file of this.app.vault.getFiles()) {
      if (markdownOnly && !filter && file.extension !== "md") continue;
      if (!matchesHomeFilter(file.extension, filter)) continue;
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
    const found: VaultHomeFile[] = [...nameMatches, ...pathMatches]
      .map(({ file, matchedAlias }) => ({
        ...toHomeFile(file),
        matchedAlias,
      }));
    if (includeUnresolved && (!filter || matchesHomeFilter("md", filter))) {
      const unresolved = this.unresolvedFiles();
      for (const item of unresolved) {
        if (!item.name.toLocaleLowerCase().includes(normalizedNeedle)) continue;
        if (found.some((existing) => existing.path === item.path)) continue;
        found.push(item);
      }
    }
    return found.slice(0, limit);
  }

  recentFiles(limit = 6, hiddenPaths: readonly string[] = []): VaultHomeFile[] {
    return this.app.workspace
      .getLastOpenFiles()
      .filter((path) => !hiddenPaths.includes(path))
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

  removeBookmark(path: string): boolean {
    const internal = (this.app as App & { internalPlugins?: InternalPluginsLike }).internalPlugins;
    const instance = internal?.getPluginById?.("bookmarks")?.instance;
    const item = flattenBookmarkItems(instance?.getBookmarks?.() ?? instance?.items ?? [])
      .find((entry) => entry.type === "file" && entry.path === path);
    if (!item || !instance?.removeItem) return false;
    instance.removeItem(item);
    return true;
  }

  hasOmnisearch(): boolean {
    return Boolean(this.omnisearchAPI());
  }

  async searchOmnisearch(query: string, limit = 8): Promise<VaultHomeFile[]> {
    const api = this.omnisearchAPI();
    if (!api || !query.trim()) return [];
    const result = await api.search(query);
    return result.slice(0, limit).flatMap((item) => {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      return file instanceof TFile ? [{ ...toHomeFile(file), excerpt: item.excerpt }] : [];
    });
  }

  private omnisearchAPI(): OmniAPI | undefined {
    const host = this.app as App & { plugins?: { getPlugin?: (id: string) => OmnisearchPlugin | undefined } };
    const plugin = host.plugins?.getPlugin?.("omnisearch");
    // Omnisearch also exposes its API as a global in older versions.
    const legacy = (globalThis as typeof globalThis & { omnisearch?: OmniAPI }).omnisearch;
    return plugin?.api?.search ? plugin.api : legacy?.search ? legacy : undefined;
  }

  private unresolvedFiles(): VaultHomeFile[] {
    const paths = new Set<string>();
    const references = this.app.metadataCache.unresolvedLinks;
    for (const [source, unresolved] of Object.entries(references)) {
      for (const text of Object.keys(unresolved)) {
        const name = text.split("#")[0]?.split("|")[0]?.trim();
        if (!name) continue;
        const destination = this.app.metadataCache.getFirstLinkpathDest(name, source);
        if (destination) continue;
        const safe = safeHomeNoteName(name.split("/").pop() || "");
        if (!safe) continue;
        const path = normalizePath(name.endsWith(".md") ? name : name + ".md");
        if (path.startsWith("../") || path === ".." || paths.has(path)) continue;
        if (this.app.vault.getAbstractFileByPath(path)) continue;
        paths.add(path);
      }
    }
    return [...paths].map((path) => ({ path, name: path.split("/").pop()!.replace(/\.md$/i, ""), extension: "md", unresolved: true }));
  }

  async createNote(name: string, unresolvedPath?: string): Promise<TFile> {
    const safeName = safeHomeNoteName(name);
    if (!safeName) throw new Error("Invalid note name");
    const baseFolder = this.app.fileManager.getNewFileParent("");
    const desired = unresolvedPath || normalizePath((baseFolder.path === "/" ? "" : baseFolder.path + "/") + safeName + ".md");
    const segments = desired.split("/");
    if (segments.some((segment) => segment === "." || segment === ".." || !segment)) throw new Error("Invalid note path");
    const existing = this.app.vault.getAbstractFileByPath(desired);
    if (existing instanceof TFile) return existing;
    if (existing) throw new Error("A folder exists at that path");
    if (unresolvedPath) {
      let folder = "";
      for (const segment of segments.slice(0, -1)) {
        folder = folder ? folder + "/" + segment : segment;
        if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      }
    }
    return this.app.vault.create(desired, "");
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
