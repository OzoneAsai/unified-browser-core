import { t } from "../i18n";
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
    this.contentEl.createEl("h2", { text: t("Site permission") });
    this.contentEl.createEl("p", {
      text: t("{v0} is requesting “{v1}”.", { v0: this.origin, v1: permissionLabel(this.permission) }),
    });
    this.contentEl.createEl("p", {
      text: t("Allow and Block are remembered for this site in the current container. Not now denies this request without saving a decision."),
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-permission-actions" });
    const notNow = actions.createEl("button", { text: t("Not now") });
    notNow.addEventListener("click", () => this.finish("ask"));
    actions
      .createEl("button", { text: t("Block") })
      .addEventListener("click", () => this.finish("block"));
    const allow = actions.createEl("button", { text: t("Allow"), cls: "mod-cta" });
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
