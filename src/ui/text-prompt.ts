import { Modal, type App } from "obsidian";

export function promptText(
  app: App,
  title: string,
  initialValue = "",
  placeholder = "",
): Promise<string | undefined> {
  return new Promise((resolve) => {
    new TextPromptModal(app, title, initialValue, placeholder, resolve).open();
  });
}

class TextPromptModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly promptTitle: string,
    private readonly initialValue: string,
    private readonly placeholder: string,
    private readonly resolveValue: (value: string | undefined) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.promptTitle });
    const field = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    if (this.placeholder) field.createSpan({ cls: "ubc-prompt-label", text: this.placeholder });
    const input = field.createEl("input", {
      attr: {
        type: "text",
        placeholder: this.placeholder,
        "aria-label": this.placeholder || this.promptTitle,
      },
    });
    input.value = this.initialValue;
    input.addClass("ubc-prompt-input");
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(undefined));
    const save = actions.createEl("button", { text: "Save" });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.finish(value);
    };
    const syncSave = () => {
      const enabled = Boolean(input.value.trim());
      save.disabled = !enabled;
      save.toggleClass("mod-cta", enabled);
    };
    save.addEventListener("click", submit);
    input.addEventListener("input", syncSave);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || save.disabled) return;
      event.preventDefault();
      submit();
    });
    syncSave();
    input.focus();
    input.select();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveValue(undefined);
  }

  private finish(value: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveValue(value);
    this.close();
  }
}
