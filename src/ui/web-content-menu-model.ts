import type UnifiedBrowserCorePlugin from "../main";
import type { BrowserView } from "./browser-view";
import type { WebviewContextMenuParams } from "./webview-types";

export type WebContentMenuEntry =
  | {
      kind: "item";
      title: string;
      icon?: string;
      disabled?: boolean;
      action: () => void;
    }
  | { kind: "separator" };

export function buildWebContentMenuEntries(
  plugin: UnifiedBrowserCorePlugin,
  view: BrowserView,
  params: WebviewContextMenuParams,
): WebContentMenuEntry[] {
  const entries: WebContentMenuEntry[] = [];
  const add = (
    title: string,
    action: () => void,
    options: { icon?: string; disabled?: boolean } = {},
  ) => entries.push({ kind: "item", title, action, ...options });
  const separator = () => {
    if (entries.length > 0 && entries[entries.length - 1]?.kind !== "separator") {
      entries.push({ kind: "separator" });
    }
  };
  const link = params.linkURL?.trim();
  const media = params.srcURL?.trim();
  const selection = params.selectionText?.trim();
  const bookmarkStore = plugin.core.bookmarks;
  const containerMode = typeof plugin.core.settings === "function"
    ? plugin.core.settings().containerMode
    : "automatic";

  if (link) {
    add("Open link", () => view.navigate(link), { icon: "external-link" });
    add("Open link in new tab", () => void plugin.openBrowser({ url: link }), { icon: "plus" });
    add("Open link in background tab", () => void plugin.openBrowser({ url: link, reveal: false }), { icon: "copy-plus" });
    add("Open link in new window", () => void plugin.openBrowser({ url: link, placement: "window" }), { icon: "picture-in-picture" });
    if (containerMode !== "off") {
      for (const container of plugin.core.containers.list()) {
        add("Open link in " + container.name, () => void plugin.openBrowser({ url: link, containerId: container.id }), { icon: "box" });
      }
    }
    const linkedBookmark = bookmarkStore?.findByUrl?.(link);
    add(linkedBookmark ? "Remove bookmark" : "Bookmark link", () => {
      bookmarkStore?.toggleBookmark?.({ title: params.linkText || link, url: link });
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    }, { icon: linkedBookmark ? "bookmark-check" : "bookmark" });
    add("Copy link", () => void navigator.clipboard.writeText(link), { icon: "copy" });
    add("Show link in history", () => view.showHistoryQuery(link), { icon: "history" });
    separator();
  }

  if (media && params.mediaType === "image") {
    const imageMatchesLink = Boolean(link && link === media);
    if (!imageMatchesLink) {
      add("Open image in new tab", () => void plugin.openBrowser({ url: media }), { icon: "image" });
    }
    add("Copy image", () => view.copyWebImageAt(params.x, params.y), { icon: "copy" });
    if (!imageMatchesLink) {
      add("Copy image URL", () => void navigator.clipboard.writeText(media), { icon: "copy" });
    }
    add("Download image", () => view.downloadWebResource(media), { icon: "download" });
    separator();
  }

  if (selection && !params.isEditable) {
    const shown = selection.slice(0, 40) + (selection.length > 40 ? "…" : "");
    add("Search “" + shown + "”", () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
    add("Copy selected text", () => void navigator.clipboard.writeText(selection), { icon: "copy" });
    separator();
  }

  if (params.isEditable) {
    const flags = params.editFlags ?? {};
    add("Undo", () => view.executeWebEdit("undo"), { disabled: flags.canUndo === false });
    add("Redo", () => view.executeWebEdit("redo"), { disabled: flags.canRedo === false });
    separator();
    add("Cut", () => view.executeWebEdit("cut"), { disabled: flags.canCut === false });
    add("Copy", () => view.executeWebEdit("copy"), { disabled: flags.canCopy === false });
    add("Paste", () => view.executeWebEdit("paste"), { disabled: flags.canPaste === false });
    add("Delete", () => view.executeWebEdit("delete"), { disabled: flags.canDelete === false });
    add("Select all", () => view.executeWebEdit("selectAll"), { disabled: flags.canSelectAll === false });
    separator();
    if (selection) {
      const shown = selection.slice(0, 40) + (selection.length > 40 ? "…" : "");
      add("Search “" + shown + "”", () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
      separator();
    }
  }

  if (params.isEditable && view.hasRecoverableFormValues()) {
    add("Restore previous value", () => void view.restoreFocusedFormValue(), { icon: "form-input" });
    add("Restore all saved form values", () => void view.restoreFormValues(), { icon: "form-input" });
    add("Show saved form values", () => view.showRecoveryCandidates());
    add("Disable recovery for this field", () => void view.disableFocusedFormRecoveryField(), { icon: "circle-off" });
    separator();
  }
  if (params.isEditable && view.formRecoveryEnabledForSite()) {
    add("Disable form recovery for this site", () => view.disableFormRecoveryForSite(), { icon: "shield-off" });
    separator();
  } else if (params.isEditable && view.formRecoveryMasterEnabled()) {
    add("Enable form recovery for this site", () => view.enableFormRecoveryForSite(), { icon: "shield-check" });
    separator();
  }

  const contextualTarget = Boolean(link || media || selection || params.isEditable);
  if (!contextualTarget) {
    const currentPageBookmarked = typeof view.currentPageBookmarked === "function"
      ? view.currentPageBookmarked()
      : false;
    add("Back", () => view.goBack(), { icon: "arrow-left", disabled: !view.canGoBack() });
    add("Forward", () => view.goForward(), { icon: "arrow-right", disabled: !view.canGoForward() });
    add("Reload", () => view.reload(), { icon: "rotate-cw" });
    add("Hard reload", () => view.hardReload());
    add("Stop loading", () => view.stopLoading());
    separator();
    add("Home", () => view.showInternal("home"), { icon: "home" });
    add(currentPageBookmarked ? "Remove bookmark" : "Bookmark this page", () => view.bookmarkCurrentPage(), {
      icon: currentPageBookmarked ? "bookmark-check" : "bookmark",
    });
    add("Copy page URL", () => void navigator.clipboard.writeText(view.currentUrl()), { icon: "copy" });
    add("View page in history", () => view.showHistoryQuery(view.currentUrl()), { icon: "history" });
    if (containerMode !== "off") {
      add("Reopen in container…", () => view.openContainerPicker(), { icon: "boxes" });
    }
    separator();
    add("Zoom in", () => view.zoomIn(), { icon: "zoom-in" });
    add("Zoom out", () => view.zoomOut(), { icon: "zoom-out" });
    add("Reset site zoom", () => view.resetZoom());
    add("Inspect page", () => view.inspectPage(), { icon: "code" });
  }

  while (entries[entries.length - 1]?.kind === "separator") entries.pop();
  return entries;
}
