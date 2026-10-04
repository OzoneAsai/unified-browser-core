import { t } from "../i18n";
import { Modal, type App } from "obsidian";

export function confirmAction(app: App, title: string, message: string, confirmLabel = "Delete"): Promise<boolean> {
  return new Promise((resolve) => new ConfirmActionModal(app, title, message, confirmLabel, resolve).open());
}

class ConfirmActionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly resolveResult: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "ubc-confirm-actions" });
    const cancel = actions.createEl("button", { text: t("Cancel") });
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = actions.createEl("button", { cls: "mod-warning", text: this.confirmLabel });
    confirm.addEventListener("click", () => this.finish(true));
    cancel.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveResult(false);
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(value);
    this.close();
  }
}
