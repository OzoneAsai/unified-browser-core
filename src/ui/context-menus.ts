import { t } from "../i18n";
import { Menu, Notice } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { BrowserView } from "./browser-view";
import type { BookmarkEntry, BookmarkFolder } from "../core/model";
import type { WebviewContextMenuParams } from "./webview-types";
import { editBookmark } from "./bookmark-editor";
import { resolveBookmarkUrl } from "../bookmarks/bookmark-url";
import { pickBookmarkFolder } from "./folder-picker-modal";
import { promptText } from "./text-prompt";
import { buildWebContentMenuEntries } from "./web-content-menu-model";
import { showDismissibleMenu } from "./popup-dismissal";
import { confirmAction } from "./confirm-modal";

export function showPageMenu(plugin: UnifiedBrowserCorePlugin, view: BrowserView, event: MouseEvent): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle(t("Back")).setIcon("arrow-left").setDisabled(!view.canGoBack()).onClick(() => view.goBack()),
  );
  menu.addItem((item) =>
    item.setTitle(t("Forward")).setIcon("arrow-right").setDisabled(!view.canGoForward()).onClick(() => view.goForward()),
  );
  menu.addItem((item) => item.setTitle(t("Reload")).setIcon("rotate-cw").onClick(() => view.reload()));
  menu.addItem((item) => item.setTitle(t("Stop loading")).setIcon("square").onClick(() => view.stopLoading()));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Open home")).setIcon("home").onClick(() => view.showInternal("home")));
  menu.addItem((item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => plugin.openBrowserTabSearch()));
  menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => plugin.openQuickSwitcher()));
  menu.addItem((item) =>
    item
      .setTitle(view.currentPageBookmarked() ? t("Edit bookmark") : t("Bookmark this page"))
      .setIcon(view.currentPageBookmarked() ? "bookmark-check" : "bookmark")
      .onClick(() => view.bookmarkCurrentPage()),
  );
  menu.addItem((item) => item.setTitle(t("Copy page URL")).setIcon("copy").onClick(async () => {
    await navigator.clipboard.writeText(view.currentUrl());
    new Notice(t("URL copied."));
  }));
  menu.addItem((item) =>
    item
      .setTitle(t("View page in history"))
      .setIcon("history")
      .onClick(() => view.showHistoryQuery(view.currentUrl())),
  );
  if (view.hasRecoverableFormValues()) {
    menu.addItem((item) =>
      item
        .setTitle(t("Restore saved form values"))
        .setIcon("form-input")
        .onClick(() => view.restoreFormValues()),
    );
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Zoom in")).setIcon("zoom-in").onClick(() => view.zoomIn()));
  menu.addItem((item) => item.setTitle(t("Zoom out")).setIcon("zoom-out").onClick(() => view.zoomOut()));
  menu.addItem((item) => item.setTitle(t("Reset site zoom")).onClick(() => view.resetZoom()));
  menu.addItem((item) => item.setTitle(t("Inspect page")).setIcon("code").onClick(() => view.inspectPage()));
  if (plugin.core.settings().containerMode !== "off") {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("Container…"))
        .setIcon("boxes")
        .onClick(() => view.openContainerPicker()),
    );
  }
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
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
  showDismissibleMenu(menu, () => menu.showAtPosition(position));
}

export function showBookmarkMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  bookmark: BookmarkEntry,
  event: MouseEvent,
): void {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle(t("Open")).setIcon("external-link").onClick(() => view.navigate(resolveBookmarkUrl(bookmark.url, plugin.app))));
  menu.addItem((item) => item.setTitle(t("Open in new tab")).setIcon("plus").onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app) })));
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem((item) =>
        item
          .setTitle(t("Open in {v0}", { v0: container.name }))
          .setIcon("box")
          .onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app), containerId: container.id })),
      );
    }
  }
  menu.addItem((item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => navigator.clipboard.writeText(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(bookmark.favorite ? t("Remove from favorites") : t("Add to favorites"))
      .setIcon(bookmark.favorite ? "star-off" : "star")
      .onClick(() => {
        plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
        plugin.core.scheduleSave();
        view.refreshBookmarks();
      }),
  );
  menu.addItem((item) => item.setTitle(t("Edit")).setIcon("pencil").onClick(async () => {
    const draft = await editBookmark(plugin.app, bookmark.title, bookmark.url, t("Edit bookmark"), {
      store: plugin.core.bookmarks,
      parentId: bookmark.parentId,
      mediaType: bookmark.mediaType,
      favorite: bookmark.favorite,
      visualKind: bookmark.visualKind,
      visualValue: bookmark.visualValue,
      description: bookmark.description,
      tags: bookmark.tags,
    });
    if (!draft) return;
    if (!plugin.core.bookmarks.updateBookmark(bookmark.id, draft)) return;
    if (draft.parentId !== undefined) plugin.core.bookmarks.moveBookmark(bookmark.id, draft.parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Move to folder")).setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks);
    if (parentId === undefined) return;
    plugin.core.bookmarks.moveBookmark(bookmark.id, parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Show in history")).setIcon("history").onClick(() => view.showHistoryQuery(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Delete")).setIcon("trash").onClick(() => {
    void (async () => {
      const confirmed = await confirmAction(
        plugin.app,
        t("Delete bookmark"),
        t("Delete “{v0}” from your bookmarks?", { v0: bookmark.title || bookmark.url }),
        t("Delete bookmark"),
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteBookmark(bookmark.id);
      plugin.core.scheduleSave();
      view.renderFavoritesBar();
      if (view.currentInternalSurface() === "bookmarks") view.showInternal("bookmarks");
    })();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
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
      .setTitle(t("Open all"))
      .setDisabled(bookmarks.length === 0)
      .onClick(() => view.openBookmarkSet(bookmarks, undefined, true)),
  );
  menu.addItem((item) =>
    item
      .setTitle(t("Open all in new tabs"))
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
  menu.addItem((item) => item.setTitle(t("New bookmark")).setIcon("bookmark-plus").onClick(async () => {
    const draft = await editBookmark(plugin.app, "", "", t("New bookmark"), { store: plugin.core.bookmarks, parentId: folder.id });
    if (!draft) return;
    plugin.core.bookmarks.addBookmark(draft);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("New folder")).setIcon("folder-plus").onClick(async () => {
    const title = await promptText(plugin.app, t("New bookmark folder"), "", t("Folder name"));
    if (title === undefined) return;
    plugin.core.bookmarks.addFolder(title, folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Rename")).setIcon("pencil").onClick(async () => {
    const title = await promptText(plugin.app, t("Rename bookmark folder"), folder.title, t("Folder name"));
    if (title === undefined) return;
    plugin.core.bookmarks.renameFolder(folder.id, title);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Move")).setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks, { excludeFolderId: folder.id });
    if (parentId === undefined) return;
    if (!plugin.core.bookmarks.moveFolder(folder.id, parentId)) {
      new Notice(t("That move would create an invalid bookmark-folder cycle."));
      return;
    }
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Sort contents")).setIcon("arrow-down-a-z").onClick(() => {
    plugin.core.bookmarks.sortChildren(folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Delete folder")).setIcon("trash").onClick(() => {
    void (async () => {
      const descendants = plugin.core.bookmarks.descendantBookmarks(folder.id);
      const confirmed = await confirmAction(
        plugin.app,
        t("Delete bookmark folder"),
        descendants.length
          ? t("Delete “{v0}” and its {v1} bookmark{v2}?", { v0: folder.title, v1: descendants.length, v2: descendants.length === 1 ? "" : "s" })
          : t("Delete the empty folder “{v0}”?", { v0: folder.title }),
        t("Delete folder"),
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteFolder(folder.id);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}

export function showFavoritesBarMenu(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  event: MouseEvent,
): void {
  const menu = new Menu();
  if (!view.currentUrl().startsWith("browser://")) {
    menu.addItem((item) => item.setTitle(t("Add current page to favorites")).setIcon("star").onClick(() => view.favoriteCurrentPage()));
  }
  menu.addItem((item) => item.setTitle(t("Open bookmarks")).setIcon("book-open").onClick(() => view.showInternal("bookmarks")));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Hide favorites bar")).onClick(() => {
    plugin.core.updateSettings({ showFavoritesBar: false });
    plugin.refreshBrowserViews();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}
