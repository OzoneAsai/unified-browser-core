import { Menu, Notice } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { BrowserView } from "./browser-view";
import type { BookmarkEntry, BookmarkFolder } from "../core/model";
import type { WebviewContextMenuParams } from "./webview-types";
import { editBookmark } from "./bookmark-editor";
import { pickBookmarkFolder } from "./folder-picker-modal";
import { promptText } from "./text-prompt";
import { buildWebContentMenuEntries } from "./web-content-menu-model";
import { confirmAction } from "./confirm-modal";

export function showPageMenu(plugin: UnifiedBrowserCorePlugin, view: BrowserView, event: MouseEvent): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle("Back").setIcon("arrow-left").setDisabled(!view.canGoBack()).onClick(() => view.goBack()),
  );
  menu.addItem((item) =>
    item.setTitle("Forward").setIcon("arrow-right").setDisabled(!view.canGoForward()).onClick(() => view.goForward()),
  );
  menu.addItem((item) => item.setTitle("Reload").setIcon("rotate-cw").onClick(() => view.reload()));
  menu.addItem((item) => item.setTitle("Stop loading").setIcon("square").onClick(() => view.stopLoading()));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Open home").setIcon("home").onClick(() => view.showInternal("home")));
  menu.addItem((item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => plugin.openBrowserTabSearch()));
  menu.addItem((item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => plugin.openQuickSwitcher()));
  menu.addItem((item) =>
    item
      .setTitle(view.currentPageBookmarked() ? "Remove bookmark" : "Bookmark this page")
      .setIcon(view.currentPageBookmarked() ? "bookmark-check" : "bookmark")
      .onClick(() => view.bookmarkCurrentPage()),
  );
  menu.addItem((item) => item.setTitle("Copy page URL").setIcon("copy").onClick(async () => {
    await navigator.clipboard.writeText(view.currentUrl());
    new Notice("URL copied.");
  }));
  menu.addItem((item) =>
    item
      .setTitle("View page in history")
      .setIcon("history")
      .onClick(() => view.showHistoryQuery(view.currentUrl())),
  );
  if (view.hasRecoverableFormValues()) {
    menu.addItem((item) =>
      item
        .setTitle("Restore saved form values")
        .setIcon("form-input")
        .onClick(() => view.restoreFormValues()),
    );
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Zoom in").setIcon("zoom-in").onClick(() => view.zoomIn()));
  menu.addItem((item) => item.setTitle("Zoom out").setIcon("zoom-out").onClick(() => view.zoomOut()));
  menu.addItem((item) => item.setTitle("Reset site zoom").onClick(() => view.resetZoom()));
  menu.addItem((item) => item.setTitle("Inspect page").setIcon("code").onClick(() => view.inspectPage()));
  if (plugin.core.settings().containerMode !== "off") {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Container…")
        .setIcon("boxes")
        .onClick(() => view.openContainerPicker()),
    );
  }
  menu.showAtMouseEvent(event);
}

export function showWebContentMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  params: WebviewContextMenuParams,
  position: { x: number; y: number },
): void {
  const menu = new Menu();
  for (const entry of buildWebContentMenuEntries(plugin, view, params)) {
    if (entry.kind === "separator") {
      menu.addSeparator();
      continue;
    }
    menu.addItem((item) => {
      item.setTitle(entry.title);
      if (entry.icon) item.setIcon(entry.icon);
      if (entry.disabled) item.setDisabled(true);
      item.onClick(entry.action);
    });
  }
  menu.showAtPosition(position);
}

export function showBookmarkMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  bookmark: BookmarkEntry,
  event: MouseEvent,
): void {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle("Open").setIcon("external-link").onClick(() => view.navigate(bookmark.url)));
  menu.addItem((item) => item.setTitle("Open in new tab").setIcon("plus").onClick(() => plugin.openBrowser({ url: bookmark.url })));
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem((item) =>
        item
          .setTitle(`Open in ${container.name}`)
          .setIcon("box")
          .onClick(() => plugin.openBrowser({ url: bookmark.url, containerId: container.id })),
      );
    }
  }
  menu.addItem((item) => item.setTitle("Copy URL").setIcon("copy").onClick(() => navigator.clipboard.writeText(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(bookmark.favorite ? "Remove from favorites" : "Add to favorites")
      .setIcon(bookmark.favorite ? "star-off" : "star")
      .onClick(() => {
        plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
        plugin.core.scheduleSave();
        view.refreshBookmarks();
      }),
  );
  menu.addItem((item) => item.setTitle("Edit").setIcon("pencil").onClick(async () => {
    const draft = await editBookmark(plugin.app, bookmark.title, bookmark.url, "Edit bookmark", {
      favorite: bookmark.favorite,
      visualKind: bookmark.visualKind,
      visualValue: bookmark.visualValue,
    });
    if (!draft) return;
    if (!plugin.core.bookmarks.updateBookmark(bookmark.id, draft)) return;
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Move to folder").setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks);
    if (parentId === undefined) return;
    plugin.core.bookmarks.moveBookmark(bookmark.id, parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Show in history").setIcon("history").onClick(() => view.showHistoryQuery(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Delete").setIcon("trash").onClick(() => {
    void (async () => {
      const confirmed = await confirmAction(
        plugin.app,
        "Delete bookmark",
        `Delete “${bookmark.title || bookmark.url}” from your bookmarks?`,
        "Delete bookmark",
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteBookmark(bookmark.id);
      plugin.core.scheduleSave();
      view.renderFavoritesBar();
      if (view.currentInternalSurface() === "bookmarks") view.showInternal("bookmarks");
    })();
  }));
  menu.showAtMouseEvent(event);
}

export function showBookmarkFolderMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  folder: BookmarkFolder,
  event: MouseEvent,
): void {
  const menu = new Menu();
  const bookmarks = plugin.core.bookmarks.descendantBookmarks(folder.id);
  menu.addItem((item) =>
    item
      .setTitle("Open all")
      .setDisabled(bookmarks.length === 0)
      .onClick(() => view.openBookmarkSet(bookmarks, undefined, true)),
  );
  menu.addItem((item) =>
    item
      .setTitle("Open all in new tabs")
      .setDisabled(bookmarks.length === 0)
      .onClick(() => view.openBookmarkSet(bookmarks)),
  );
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem((item) =>
        item
          .setTitle("Open all in " + container.name)
          .setIcon("box")
          .setDisabled(bookmarks.length === 0)
          .onClick(() => view.openBookmarkSet(bookmarks, container.id)),
      );
    }
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("New bookmark").setIcon("bookmark-plus").onClick(async () => {
    const draft = await editBookmark(plugin.app, "", "", "New bookmark");
    if (!draft) return;
    plugin.core.bookmarks.addBookmark({ ...draft, parentId: folder.id });
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("New folder").setIcon("folder-plus").onClick(async () => {
    const title = await promptText(plugin.app, "New bookmark folder", "", "Folder name");
    if (title === undefined) return;
    plugin.core.bookmarks.addFolder(title, folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(async () => {
    const title = await promptText(plugin.app, "Rename bookmark folder", folder.title, "Folder name");
    if (title === undefined) return;
    plugin.core.bookmarks.renameFolder(folder.id, title);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Move").setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks, { excludeFolderId: folder.id });
    if (parentId === undefined) return;
    if (!plugin.core.bookmarks.moveFolder(folder.id, parentId)) {
      new Notice("That move would create an invalid bookmark-folder cycle.");
      return;
    }
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Sort contents").setIcon("arrow-down-a-z").onClick(() => {
    plugin.core.bookmarks.sortChildren(folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Delete folder").setIcon("trash").onClick(() => {
    void (async () => {
      const descendants = plugin.core.bookmarks.descendantBookmarks(folder.id);
      const confirmed = await confirmAction(
        plugin.app,
        "Delete bookmark folder",
        descendants.length
          ? `Delete “${folder.title}” and its ${descendants.length} bookmark${descendants.length === 1 ? "" : "s"}?`
          : `Delete the empty folder “${folder.title}”?`,
        "Delete folder",
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteFolder(folder.id);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })();
  }));
  menu.showAtMouseEvent(event);
}

export function showFavoritesBarMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  event: MouseEvent,
): void {
  const menu = new Menu();
  if (!view.currentUrl().startsWith("browser://")) {
    menu.addItem((item) => item.setTitle("Add current page to favorites").setIcon("star").onClick(() => view.favoriteCurrentPage()));
  }
  menu.addItem((item) => item.setTitle("Open bookmarks").setIcon("book-open").onClick(() => view.showInternal("bookmarks")));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Hide favorites bar").onClick(() => {
    plugin.core.updateSettings({ showFavoritesBar: false });
    plugin.refreshBrowserViews();
  }));
  menu.showAtMouseEvent(event);
}
