import { Modal, type App } from "obsidian";
import type { BookmarkEntry, BookmarkVisualKind } from "../core/model";
import { renderBookmarkVisual } from "./bookmark-visual";

export type BookmarkDraft = {
  title: string;
  url: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
  visualKind?: BookmarkVisualKind;
  visualValue?: string;
};

export interface BookmarkEditorOptions {
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
    this.contentEl.createEl("h2", { text: this.heading });
    const titleField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    titleField.createSpan({ cls: "ubc-prompt-label", text: "Title" });
    const title = titleField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: "Title", "aria-label": "Bookmark title" },
    });
    title.value = this.initialTitle;
    const urlField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    urlField.createSpan({ cls: "ubc-prompt-label", text: "URL" });
    const url = urlField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "url", placeholder: "https://…", "aria-label": "Bookmark URL" },
    });
    url.value = this.initialUrl;

    const descriptionField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    descriptionField.createSpan({ cls: "ubc-prompt-label", text: "Description" });
    const description = descriptionField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": "Bookmark description" },
    });
    description.value = this.options.description ?? "";
    const tagsField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    tagsField.createSpan({ cls: "ubc-prompt-label", text: "Tags" });
    const tags = tagsField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: "Separate tags with spaces", "aria-label": "Bookmark tags" },
    });
    tags.value = (this.options.tags ?? []).join(" ");

    const favoriteField = this.contentEl.createEl("label", { cls: "ubc-prompt-check" });
    const favorite = favoriteField.createEl("input", { attr: { type: "checkbox" } });
    favorite.checked = Boolean(this.options.favorite);
    favoriteField.createSpan({ text: "Show in favorites bar" });

    const appearanceField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    appearanceField.createSpan({ cls: "ubc-prompt-label", text: "Bookmark image" });
    const visualKind = appearanceField.createEl("select", { attr: { "aria-label": "Bookmark image type" } });
    visualKind.createEl("option", { text: "Website favicon", value: "favicon" });
    visualKind.createEl("option", { text: "Custom image", value: "image" });
    visualKind.createEl("option", { text: "Custom text", value: "text" });
    visualKind.createEl("option", { text: "Lucide icon", value: "icon" });
    visualKind.value = this.options.visualKind ?? "favicon";

    const visualValueField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    visualValueField.createSpan({ cls: "ubc-prompt-label", text: "Custom value" });
    const visualValue = visualValueField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": "Custom bookmark image or text" },
    });
    visualValue.value = this.options.visualValue ?? "";
    const previewField = this.contentEl.createDiv({ cls: "ubc-bookmark-editor-preview-row" });
    previewField.createSpan({ cls: "ubc-prompt-label", text: "Preview" });
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
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(undefined));
    const save = actions.createEl("button", { text: "Save" });
    const submit = () => {
      const nextUrl = url.value.trim();
      if (!nextUrl) return;
      const kind = visualKind.value as BookmarkVisualKind;
      this.finish({
        title: title.value.trim() || nextUrl,
        url: nextUrl,
        description: description.value.trim(),
        tags: tags.value.trim() ? tags.value.trim().split(/\s+/) : [],
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
