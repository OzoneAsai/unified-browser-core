import type { BookmarkEntry, BookmarkFolder } from "../core/model";

/** Display state and selection-editing state are distinct user tasks. */
export type BookmarkPresentationMode = "type" | "folder" | "selected" | "manage";

export function bookmarksForPresentation(
  bookmarks: readonly BookmarkEntry[],
  mode: BookmarkPresentationMode,
): BookmarkEntry[] {
  if (mode === "selected") return bookmarks.filter((bookmark) => bookmark.favorite)
    .sort((a, b) => (a.favoriteOrder ?? a.order) - (b.favoriteOrder ?? b.order));
  if (mode === "manage") return [...bookmarks]
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.favoriteOrder ?? a.order) - (b.favoriteOrder ?? b.order));
  return [...bookmarks];
}

/** Show populated folders and loose bookmarks first, retaining empty folders as manageable objects. */
export function partitionBookmarkChildren(
  children: readonly (BookmarkFolder | BookmarkEntry)[],
  descendantCount: (folderId: string) => number,
): { main: (BookmarkFolder | BookmarkEntry)[]; empty: BookmarkFolder[] } {
  const main: (BookmarkFolder | BookmarkEntry)[] = [];
  const empty: BookmarkFolder[] = [];
  for (const item of children) {
    if (item.kind === "folder" && descendantCount(item.id) === 0) empty.push(item);
    else main.push(item);
  }
  return { main, empty };
}
