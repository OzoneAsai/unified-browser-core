import { t } from "../i18n";
import { Modal, type App } from "obsidian";

export interface RecoveryDetails {
  richRestoreAvailable: boolean;
  navigationEntries: number;
  formFields: number;
  stale: boolean;
  url: string;
}

export function showRecoveryDetails(app: App, details: RecoveryDetails): void {
  new RecoveryDetailsModal(app, details).open();
}

class RecoveryDetailsModal extends Modal {
  constructor(app: App, private readonly details: RecoveryDetails) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("Recovery details") });
    const list = this.contentEl.createEl("dl", { cls: "ubc-recovery-details" });
    addRow(list, "URL", this.details.url || "Unknown");
    addRow(list, "Detailed tab state", this.details.richRestoreAvailable ? "Available" : "Not available");
    addRow(
      list,
      "Saved back/forward pages",
      `${this.details.navigationEntries} page${this.details.navigationEntries === 1 ? "" : "s"}`,
    );
    addRow(
      list,
      "Saved form values",
      `${this.details.formFields} field${this.details.formFields === 1 ? "" : "s"}`,
    );
    addRow(
      list,
      "Reopen behavior",
      this.details.stale
        ? "Reload the saved URL and use available site data"
        : "Restore detailed tab state when possible",
    );
    this.contentEl.createEl("p", {
      text: t("Browser Core does not save a full live copy of the page. Some page state can only be restored by the browser engine, while saved form values and the website's own drafts are recovered separately."),
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: t("Close") }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function addRow(parent: HTMLElement, term: string, value: string): void {
  parent.createEl("dt", { text: term });
  parent.createEl("dd", { text: value });
}
