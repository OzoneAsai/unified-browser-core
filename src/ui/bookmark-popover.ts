import { setIcon } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { BookmarkEntry, BookmarkMediaType } from "../core/model";
import { BOOKMARK_MEDIA, inferBookmarkMedia } from "../bookmarks/bookmark-media";
import { t } from "../i18n";
import { renderBookmarkVisual } from "./bookmark-visual";
import { promptText } from "./text-prompt";

export function showBookmarkPopover(
  plugin: UnifiedBrowserCorePlugin,
  bookmark: BookmarkEntry,
  anchor: HTMLElement,
  content: HTMLElement,
  onClose?: () => void,
): () => void {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView ?? window;
  const dismiss = content.createDiv({ cls: "ubc-menu-dismiss-layer" });
  const panel = doc.body.createDiv({ cls: "ubc-bookmark-popover", attr: { role: "dialog", "aria-label": t("Edit bookmark") } });
  panel.style.maxWidth = `${Math.max(0, doc.documentElement.clientWidth - 16)}px`;
  const header = panel.createDiv({ cls: "ubc-bookmark-popover-heading" });
  renderBookmarkVisual(header, bookmark, "ubc-bookmark-editor-preview-icon", plugin.app);
  const heading = header.createDiv();
  heading.createEl("strong", { text: t("Bookmark saved") });
  heading.createDiv({ cls: "ubc-bookmark-meta", text: bookmark.url });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove(); dismiss.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", escape, true);
    win.removeEventListener("resize", close);
    onClose?.();
  };
  const outside = (event: PointerEvent) => {
    if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); close(); anchor.focus();
  };
  dismiss.addEventListener("pointerdown", close);
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", escape, true);
  win.addEventListener("resize", close);
  const save = () => { plugin.core.scheduleSave(); plugin.refreshBrowserViews(); };
  const field = (label: string) => {
    const container = panel.createEl("label", { cls: "ubc-prompt-field" });
    container.createSpan({ cls: "ubc-prompt-label", text: t(label) });
    return container;
  };
  const name = field("Title").createEl("input", { attr: { type: "text" } });
  name.value = bookmark.title;
  name.addEventListener("input", () => { plugin.core.bookmarks.updateBookmark(bookmark.id, { title: name.value }); save(); });
  const folderField = field("Save in");
  const folderRow = folderField.createDiv({ cls: "ubc-bookmark-folder-select" });
  const folder = folderRow.createEl("select");
  const renderFolders = () => {
    folder.empty();
    folder.createEl("option", { value: "", text: t("Bookmarks root") });
    for (const item of plugin.core.bookmarks.folders()) {
      folder.createEl("option", { value: item.id, text: plugin.core.bookmarks.folderPath(item.id) });
    }
    folder.value = bookmark.parentId ?? "";
  };
  renderFolders();
  folder.addEventListener("change", () => { plugin.core.bookmarks.moveBookmark(bookmark.id, folder.value || null); save(); });
  const newFolder = folderRow.createEl("button", { attr: { type: "button", title: t("New folder"), "aria-label": t("New folder") } });
  setIcon(newFolder, "folder-plus");
  newFolder.addEventListener("click", async () => {
    const title = await promptText(plugin.app, t("New bookmark folder"), "", t("Folder name"));
    if (!title?.trim() || !plugin.core.bookmarks.getBookmark(bookmark.id)) return;
    const created = plugin.core.bookmarks.addFolder(title, bookmark.parentId);
    plugin.core.bookmarks.moveBookmark(bookmark.id, created.id); save(); renderFolders();
  });
  const type = field("Media type").createEl("select");
  type.createEl("option", { value: "", text: t("Detected: {type}", { type: t(BOOKMARK_MEDIA.find((entry) => entry.type === inferBookmarkMedia(bookmark.url))!.label) }) });
  for (const entry of BOOKMARK_MEDIA) type.createEl("option", { value: entry.type, text: t(entry.label) });
  type.value = bookmark.mediaType ?? "";
  type.addEventListener("change", () => { plugin.core.bookmarks.updateBookmark(bookmark.id, { mediaType: (type.value || undefined) as BookmarkMediaType | undefined }); save(); });
  const selectedField = panel.createEl("label", { cls: "ubc-selected-check" });
  const selected = selectedField.createEl("input", { attr: { type: "checkbox" } });
  selected.checked = bookmark.favorite;
  const selectedLabel = selectedField.createDiv();
  selectedLabel.createEl("strong", { text: t("Show in selected members") });
  selectedLabel.createDiv({ cls: "ubc-bookmark-meta", text: t("Your everyday pages, one click away.") });
  selected.addEventListener("change", () => { plugin.core.bookmarks.setFavorite(bookmark.id, selected.checked); save(); });
  const details = panel.createEl("details", { cls: "ubc-bookmark-details" });
  details.createEl("summary", { text: t("Details") });
  const description = details.createEl("input", { attr: { placeholder: t("Description"), "aria-label": t("Description") } });
  description.value = bookmark.description ?? "";
  description.addEventListener("input", () => { plugin.core.bookmarks.updateBookmark(bookmark.id, { description: description.value }); save(); });
  const tags = details.createEl("input", { attr: { placeholder: t("Separate tags with spaces"), "aria-label": t("Tags") } });
  tags.value = (bookmark.tags ?? []).join(" ");
  tags.addEventListener("input", () => { plugin.core.bookmarks.updateBookmark(bookmark.id, { tags: tags.value.trim().split(/\s+/).filter(Boolean) }); save(); });
  const footer = panel.createDiv({ cls: "ubc-modal-actions" });
  const remove = footer.createEl("button", { text: t("Delete bookmark"), cls: "ubc-bookmark-remove" });
  remove.addEventListener("click", () => { plugin.core.bookmarks.deleteBookmark(bookmark.id); save(); close(); });
  footer.createEl("button", { text: t("Done"), cls: "mod-cta" }).addEventListener("click", () => { close(); anchor.focus(); });
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, doc.documentElement.clientWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(rect.bottom + 8, win.innerHeight - panel.offsetHeight - 8))}px`;
  name.focus(); name.select();
  return close;
}
