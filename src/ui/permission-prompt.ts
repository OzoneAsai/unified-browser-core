import { Modal, type App } from "obsidian";
import type { PermissionDecision } from "../core/model";
import { permissionLabel } from "./permission-label";

export function promptPermission(app: App, origin: string, permission: string): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    new PermissionPromptModal(app, origin, permission, resolve).open();
  });
}

class PermissionPromptModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly origin: string,
    private readonly permission: string,
    private readonly resolve: (decision: PermissionDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: "Site permission" });
    this.contentEl.createEl("p", {
      text: `${this.origin} is requesting “${permissionLabel(this.permission)}”.`,
    });
    this.contentEl.createEl("p", {
      text: "Allow and Block are remembered for this site in the current container. Not now denies this request without saving a decision.",
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-permission-actions" });
    const notNow = actions.createEl("button", { text: "Not now" });
    notNow.addEventListener("click", () => this.finish("ask"));
    actions
      .createEl("button", { text: "Block" })
      .addEventListener("click", () => this.finish("block"));
    const allow = actions.createEl("button", { text: "Allow", cls: "mod-cta" });
    allow.addEventListener("click", () => this.finish("allow"));
    notNow.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve("ask");
  }

  private finish(decision: PermissionDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(decision);
    this.close();
  }
}
