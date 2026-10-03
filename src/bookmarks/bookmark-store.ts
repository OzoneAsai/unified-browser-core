import { createId } from "../core/id";
import type { BookmarkChangeEvent } from "../core/events";
import type {
  BookmarkEntry,
  BookmarkFolder,
  BookmarkFolderId,
  BookmarkState,
  BookmarkVisualKind,
} from "../core/model";

export interface BookmarkInput {
  title: string;
  url: string;
  parentId?: BookmarkFolderId | null;
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
  faviconUrl?: string;
}

export interface ImportedWebBookmark {
  title: string;
  url: string;
  folderPath: string[];
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
}

export interface BookmarkImportSummary {
  added: number;
  reused: number;
  foldersCreated: number;
}

export class BookmarkStore {
  constructor(
    private readonly state: BookmarkState,
    private readonly onChanged: (event: BookmarkChangeEvent) => void = () => undefined,
  ) {}

  addBookmark(input: BookmarkInput): BookmarkEntry {
    const existing = this.findByUrl(input.url);
    if (existing) {
      let changed = false;
      if (!existing.faviconUrl && input.faviconUrl) {
        existing.faviconUrl = input.faviconUrl;
        changed = true;
      }
      if (input.favorite === true && !existing.favorite) {
        existing.favorite = true;
        existing.favoriteOrder = this.nextFavoriteOrder();
        changed = true;
      }
      if (changed) this.onChanged({ action: "updated", kind: "bookmark", id: existing.id, entry: existing });
      return existing;
    }
    const siblings = this.children(input.parentId ?? null);
    const bookmark: BookmarkEntry = {
      id: createId("bookmark"),
      kind: "bookmark",
      parentId: input.parentId ?? null,
      title: input.title || input.url,
      url: input.url,
      order: siblings.length,
      createdAt: Date.now(),
      favorite: input.favorite ?? false,
      favoriteOrder: input.favorite ? this.nextFavoriteOrder() : undefined,
      visualKind: input.visualKind ?? "favicon",
      visualValue: cleanOptional(input.visualValue),
      faviconUrl: cleanOptional(input.faviconUrl),
    };
    this.state.bookmarks[bookmark.id] = bookmark;
    this.onChanged({ action: "added", kind: "bookmark", id: bookmark.id, entry: bookmark });
    return bookmark;
  }

  addFolder(title: string, parentId: BookmarkFolderId | null = null): BookmarkFolder {
    const siblings = this.children(parentId);
    const folder: BookmarkFolder = {
      id: createId("folder"),
      kind: "folder",
      parentId,
      title: title.trim() || "Folder",
      order: siblings.length,
    };
    this.state.folders[folder.id] = folder;
    this.onChanged({ action: "added", kind: "folder", id: folder.id, entry: folder });
    return folder;
  }

  importWebBookmarks(entries: ImportedWebBookmark[]): BookmarkImportSummary {
    let added = 0;
    let reused = 0;
    let foldersCreated = 0;

    for (const entry of entries) {
      let parentId: BookmarkFolderId | null = null;
      for (const rawTitle of entry.folderPath) {
        const title = rawTitle.trim();
        if (!title) continue;
        const existing: BookmarkFolder | undefined = this.children(parentId).find(
          (child): child is BookmarkFolder => child.kind === "folder" && child.title === title,
        );
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const folder = this.addFolder(title, parentId);
        parentId = folder.id;
        foldersCreated += 1;
      }

      const existing = this.findByUrl(entry.url);
      if (existing) {
        reused += 1;
        continue;
      }
      this.addBookmark({
        title: entry.title,
        url: entry.url,
        parentId,
        favorite: entry.favorite,
        visualKind: entry.visualKind,
        visualValue: entry.visualValue,
      });
      added += 1;
    }

    return { added, reused, foldersCreated };
  }

  deleteBookmark(id: string): void {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return;
    delete this.state.bookmarks[id];
    this.onChanged({ action: "deleted", kind: "bookmark", id });
  }

  getBookmark(id: string): BookmarkEntry | undefined {
    return this.state.bookmarks[id];
  }

  findByUrl(url: string): BookmarkEntry | undefined {
    const normalized = normalizeBookmarkUrl(url);
    return Object.values(this.state.bookmarks).find((bookmark) => normalizeBookmarkUrl(bookmark.url) === normalized);
  }

  isBookmarked(url: string): boolean {
    return Boolean(this.findByUrl(url));
  }

  toggleBookmark(input: BookmarkInput): { bookmarked: boolean; bookmark?: BookmarkEntry } {
    const existing = this.findByUrl(input.url);
    if (existing) {
      this.deleteBookmark(existing.id);
      return { bookmarked: false };
    }
    return { bookmarked: true, bookmark: this.addBookmark(input) };
  }

  setFavorite(id: string, favorite: boolean): boolean {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark || bookmark.favorite === favorite) return Boolean(bookmark);
    bookmark.favorite = favorite;
    if (favorite) bookmark.favoriteOrder = this.nextFavoriteOrder();
    else bookmark.favoriteOrder = undefined;
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }

  favorites(): BookmarkEntry[] {
    return Object.values(this.state.bookmarks)
      .filter((bookmark) => bookmark.favorite)
      .sort((a, b) => (a.favoriteOrder ?? Number.MAX_SAFE_INTEGER) - (b.favoriteOrder ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
  }

  getFolder(id: BookmarkFolderId): BookmarkFolder | undefined {
    return this.state.folders[id];
  }

  renameBookmark(id: string, title: string): boolean {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return false;
    bookmark.title = title.trim() || bookmark.url;
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }

  updateBookmark(
    id: string,
    patch: Partial<Pick<BookmarkEntry, "title" | "url" | "favorite" | "visualKind" | "visualValue" | "faviconUrl">>,
  ): boolean {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return false;
    const previousUrl = bookmark.url;
    if (patch.url !== undefined) bookmark.url = patch.url.trim() || bookmark.url;
    if (bookmark.url !== previousUrl && patch.faviconUrl === undefined) bookmark.faviconUrl = undefined;
    if (patch.title !== undefined) bookmark.title = patch.title.trim() || bookmark.url;
    if (patch.favorite !== undefined) bookmark.favorite = patch.favorite;
    if (patch.visualKind !== undefined) {
      bookmark.visualKind = patch.visualKind;
      bookmark.visualValue = cleanOptional(patch.visualValue);
    } else if (patch.visualValue !== undefined) {
      bookmark.visualValue = cleanOptional(patch.visualValue);
    }
    if (patch.faviconUrl !== undefined) bookmark.faviconUrl = cleanOptional(patch.faviconUrl);
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }

  renameFolder(id: BookmarkFolderId, title: string): boolean {
    const folder = this.state.folders[id];
    if (!folder) return false;
    folder.title = title.trim() || "Folder";
    this.onChanged({ action: "updated", kind: "folder", id, entry: folder });
    return true;
  }

  moveBookmark(id: string, parentId: BookmarkFolderId | null): boolean {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark || (parentId && !this.state.folders[parentId])) return false;
    bookmark.parentId = parentId;
    bookmark.order = this.children(parentId).filter((entry) => entry.id !== id).length;
    this.normalizeOrders();
    this.onChanged({ action: "moved", kind: "bookmark", id, entry: bookmark });
    return true;
  }

  moveFolder(id: BookmarkFolderId, parentId: BookmarkFolderId | null): boolean {
    const folder = this.state.folders[id];
    if (!folder || !this.canMoveFolder(id, parentId)) return false;
    folder.parentId = parentId;
    folder.order = this.children(parentId).filter((entry) => entry.id !== id).length;
    this.normalizeOrders();
    this.onChanged({ action: "moved", kind: "folder", id, entry: folder });
    return true;
  }

  folders(): BookmarkFolder[] {
    return Object.values(this.state.folders).sort((a, b) => a.title.localeCompare(b.title));
  }

  folderPath(id: BookmarkFolderId): string {
    const parts: string[] = [];
    let current = this.state.folders[id];
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.title);
      current = current.parentId ? this.state.folders[current.parentId] : undefined;
    }
    return parts.join(" / ");
  }

  canMoveFolder(id: BookmarkFolderId, parentId: BookmarkFolderId | null): boolean {
    if (!this.state.folders[id] || id === parentId || (parentId && !this.state.folders[parentId])) return false;
    return !parentId || !this.isDescendantFolder(parentId, id);
  }

  descendantBookmarks(folderId: BookmarkFolderId): BookmarkEntry[] {
    const result: BookmarkEntry[] = [];
    const visit = (parentId: BookmarkFolderId): void => {
      for (const child of this.children(parentId)) {
        if (child.kind === "bookmark") result.push(child);
        else visit(child.id);
      }
    };
    visit(folderId);
    return result;
  }

  sortChildren(parentId: BookmarkFolderId | null): void {
    const children = this.children(parentId).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    children.forEach((entry, index) => {
      entry.order = index;
    });
    this.onChanged({ action: "sorted", kind: "folder", id: parentId ?? "root" });
  }

  deleteFolder(id: BookmarkFolderId): void {
    for (const child of Object.values(this.state.bookmarks)) {
      if (child.parentId === id) this.deleteBookmark(child.id);
    }
    for (const child of Object.values(this.state.folders)) {
      if (child.parentId === id) this.deleteFolder(child.id);
    }
    if (!this.state.folders[id]) return;
    delete this.state.folders[id];
    this.normalizeOrders();
    this.onChanged({ action: "deleted", kind: "folder", id });
  }

  children(parentId: BookmarkFolderId | null): Array<BookmarkEntry | BookmarkFolder> {
    return [
      ...Object.values(this.state.folders).filter((entry) => entry.parentId === parentId),
      ...Object.values(this.state.bookmarks).filter((entry) => entry.parentId === parentId),
    ].sort((a, b) => a.order - b.order);
  }

  search(query: string): BookmarkEntry[] {
    const needle = query.toLowerCase();
    return Object.values(this.state.bookmarks)
      .filter((bookmark) => bookmark.title.toLowerCase().includes(needle) || bookmark.url.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  allBookmarks(): BookmarkEntry[] {
    return Object.values(this.state.bookmarks).sort((a, b) => a.order - b.order);
  }

  private isDescendantFolder(candidateId: BookmarkFolderId, ancestorId: BookmarkFolderId): boolean {
    let current: BookmarkFolder | undefined = this.state.folders[candidateId];
    while (current) {
      if (current.parentId === ancestorId) return true;
      current = current.parentId ? this.state.folders[current.parentId] : undefined;
    }
    return false;
  }

  private normalizeOrders(): void {
    const parentIds = new Set<BookmarkFolderId | null>([null]);
    for (const folder of Object.values(this.state.folders)) parentIds.add(folder.parentId);
    for (const bookmark of Object.values(this.state.bookmarks)) parentIds.add(bookmark.parentId);
    for (const parentId of parentIds) {
      this.children(parentId).forEach((entry, index) => {
        entry.order = index;
      });
    }
  }

  private nextFavoriteOrder(): number {
    return Object.values(this.state.bookmarks).reduce(
      (max, bookmark) => bookmark.favorite ? Math.max(max, bookmark.favoriteOrder ?? -1) : max,
      -1,
    ) + 1;
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next || undefined;
}

export function normalizeBookmarkUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return trimmed;
  }
}
