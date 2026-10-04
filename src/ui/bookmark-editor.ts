import { Modal, type App } from "obsidian";
import type { BookmarkEntry, BookmarkVisualKind, BookmarkMediaType } from "../core/model";
import type { BookmarkStore } from "../bookmarks/bookmark-store";
import { BOOKMARK_MEDIA } from "../bookmarks/bookmark-media";
import { t } from "../i18n";
import { renderBookmarkVisual } from "./bookmark-visual";

export type BookmarkDraft = {
  title: string;
  url: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
  parentId?: string | null;
  mediaType?: BookmarkMediaType;
};

export interface BookmarkEditorOptions {
  store?: BookmarkStore;
  parentId?: string | null;
  mediaType?: BookmarkMediaType;
  description?: string;
  tags?: string[];
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
}

export function editBookmark(
  app: App,
  title: string,
  url: string,
  heading = "Edit bookmark",
  options: BookmarkEditorOptions = {},
): Promise<BookmarkDraft | undefined> {
  return new Promise((resolve) => {
    new BookmarkEditorModal(app, title, url, heading, options, resolve).open();
  });
}

class BookmarkEditorModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly initialTitle: string,
    private readonly initialUrl: string,
    private readonly heading: string,
    private readonly options: BookmarkEditorOptions,
    private readonly resolveDraft: (draft: BookmarkDraft | undefined) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ubc-bookmark-editor-modal");
    this.contentEl.createEl("h2", { text: this.heading });
    const titleField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    titleField.createSpan({ cls: "ubc-prompt-label", text: t("Title") });
    const title = titleField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: t("Title"), "aria-label": t("Bookmark title") },
    });
    title.value = this.initialTitle;
    const urlField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    urlField.createSpan({ cls: "ubc-prompt-label", text: t("URL") });
    const url = urlField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "url", placeholder: "https://…", "aria-label": t("Bookmark URL") },
    });
    url.value = this.initialUrl;

    let folder: HTMLSelectElement | undefined;
    if (this.options.store) {
      const field = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
      field.createSpan({ cls: "ubc-prompt-label", text: t("Save in") });
      folder = field.createEl("select");
      folder.createEl("option", { value: "", text: t("Bookmarks root") });
      for (const item of this.options.store.folders()) folder.createEl("option", { value: item.id, text: this.options.store.folderPath(item.id) });
      folder.value = this.options.parentId ?? "";
    }
    const typeField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    typeField.createSpan({ cls: "ubc-prompt-label", text: t("Media type") });
    const mediaType = typeField.createEl("select");
    mediaType.createEl("option", { value: "", text: t("Automatic classification") });
    for (const entry of BOOKMARK_MEDIA) mediaType.createEl("option", { value: entry.type, text: t(entry.label) });
    mediaType.value = this.options.mediaType ?? "";

    const descriptionField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    descriptionField.createSpan({ cls: "ubc-prompt-label", text: t("Description") });
    const description = descriptionField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": t("Bookmark description") },
    });
    description.value = this.options.description ?? "";
    const tagsField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    tagsField.createSpan({ cls: "ubc-prompt-label", text: t("Tags") });
    const tags = tagsField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: t("Separate tags with spaces"), "aria-label": t("Bookmark tags") },
    });
    tags.value = (this.options.tags ?? []).join(" ");

    const favoriteField = this.contentEl.createEl("label", { cls: "ubc-prompt-check" });
    const favorite = favoriteField.createEl("input", { attr: { type: "checkbox" } });
    favorite.checked = Boolean(this.options.favorite);
    favoriteField.createSpan({ text: t("Show in favorites bar") });

    const appearanceField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    appearanceField.createSpan({ cls: "ubc-prompt-label", text: t("Bookmark image") });
    const visualKind = appearanceField.createEl("select", { attr: { "aria-label": t("Bookmark image type") } });
    visualKind.createEl("option", { text: t("Website favicon"), value: "favicon" });
    visualKind.createEl("option", { text: t("Custom image"), value: "image" });
    visualKind.createEl("option", { text: t("Custom text"), value: "text" });
    visualKind.createEl("option", { text: t("Lucide icon"), value: "icon" });
    visualKind.value = this.options.visualKind ?? "favicon";

    const visualValueField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    visualValueField.createSpan({ cls: "ubc-prompt-label", text: t("Custom value") });
    const visualValue = visualValueField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": t("Custom bookmark image or text") },
    });
    visualValue.value = this.options.visualValue ?? "";
    const previewField = this.contentEl.createDiv({ cls: "ubc-bookmark-editor-preview-row" });
    previewField.createSpan({ cls: "ubc-prompt-label", text: t("Preview") });
    const preview = previewField.createDiv({ cls: "ubc-bookmark-editor-preview" });
    const renderPreview = () => {
      preview.empty();
      const kind = visualKind.value as BookmarkVisualKind;
      const previewBookmark: BookmarkEntry = {
        id: "preview",
        kind: "bookmark",
        parentId: null,
        title: title.value.trim() || "Bookmark",
        url: url.value.trim() || "https://example.com",
        order: 0,
        createdAt: 0,
        favorite: favorite.checked,
        visualKind: kind,
        visualValue: kind === "favicon" ? undefined : visualValue.value.trim() || undefined,
      };
      renderBookmarkVisual(preview, previewBookmark, "ubc-bookmark-editor-preview-icon", this.app);
      preview.createSpan({ cls: "ubc-bookmark-editor-preview-title", text: previewBookmark.title });
    };
    const syncVisualField = () => {
      const kind = visualKind.value as BookmarkVisualKind;
      visualValueField.toggleClass("is-hidden", kind === "favicon");
      visualValue.placeholder = kind === "image"
        ? "https://… or Images/icon.png"
        : kind === "icon" ? "bookmark, globe, link, etc." : "AI, G, ★, etc.";
      renderPreview();
    };
    visualKind.addEventListener("change", syncVisualField);
    visualValue.addEventListener("input", renderPreview);
    title.addEventListener("input", renderPreview);
    url.addEventListener("input", renderPreview);
    syncVisualField();
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: t("Cancel") }).addEventListener("click", () => this.finish(undefined));
    const save = actions.createEl("button", { text: t("Save") });
    const submit = () => {
      const nextUrl = url.value.trim();
      if (!nextUrl) return;
      const kind = visualKind.value as BookmarkVisualKind;
      this.finish({
        title: title.value.trim() || nextUrl,
        url: nextUrl,
        description: description.value.trim(),
        tags: tags.value.trim() ? tags.value.trim().split(/\s+/) : [],
        ...(folder ? { parentId: folder.value || null } : {}),
        mediaType: (mediaType.value || undefined) as BookmarkMediaType | undefined,
        favorite: favorite.checked,
        visualKind: kind,
        visualValue: kind === "favicon" ? undefined : visualValue.value.trim() || undefined,
      });
    };
    const syncSave = () => {
      const enabled = Boolean(url.value.trim());
      save.disabled = !enabled;
      save.toggleClass("mod-cta", enabled);
    };
    save.addEventListener("click", submit);
    url.addEventListener("input", syncSave);
    title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!url.value.trim()) {
        url.focus();
        return;
      }
      submit();
    });
    url.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || save.disabled) return;
      event.preventDefault();
      submit();
    });
    syncSave();
    title.focus();
    title.select();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveDraft(undefined);
  }

  private finish(draft: BookmarkDraft | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDraft(draft);
    this.close();
  }
}
