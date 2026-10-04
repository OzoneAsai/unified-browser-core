import { t } from "../i18n";
import { Modal, type App } from "obsidian";
import type { FormRecoveryField } from "../core/model";

export function showFormRecoveryCandidates(
  app: App,
  fields: FormRecoveryField[],
  restoreSafeMatches: () => void,
): void {
  new FormRecoveryCandidatesModal(app, fields, restoreSafeMatches).open();
}

class FormRecoveryCandidatesModal extends Modal {
  constructor(
    app: App,
    private readonly fields: FormRecoveryField[],
    private readonly restoreSafeMatches: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("Saved form values") });
    this.contentEl.createEl("p", {
      text: t("These values were saved for this page. Browser Core restores only fields it can match confidently; ambiguous fields remain unchanged."),
    });

    const list = this.contentEl.createDiv({ cls: "ubc-recovery-candidate-list" });
    for (const field of this.fields) {
      const row = list.createDiv({ cls: "ubc-recovery-candidate" });
      const heading = row.createDiv({ cls: "ubc-recovery-candidate-heading" });
      heading.createEl("strong", { text: fieldLabel(field) });
      heading.createEl("span", { text: fieldTypeLabel(field.type), cls: "ubc-recovery-candidate-type" });
      row.createDiv({ cls: "ubc-recovery-candidate-value", text: fieldValue(field) });
      const details = fieldDetails(field);
      if (details) row.createDiv({ cls: "ubc-recovery-candidate-meta", text: details });
    }

    const actions = this.contentEl.createDiv({ cls: "ubc-recovery-candidate-actions" });
    const close = actions.createEl("button", { text: t("Close") });
    close.addEventListener("click", () => this.close());
    const restore = actions.createEl("button", { text: t("Restore matching fields"), cls: "mod-cta" });
    restore.addEventListener("click", () => {
      this.close();
      this.restoreSafeMatches();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function fieldLabel(field: FormRecoveryField): string {
  return field.label || field.ariaLabel || field.placeholder || field.name || field.id || "Unnamed field";
}

function fieldTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    text: t("Text field"),
    textarea: "Text area",
    email: "Email",
    tel: "Phone",
    url: "URL",
    search: "Search field",
    number: "Number",
    date: "Date",
    "datetime-local": "Date and time",
    month: "Month",
    week: "Week",
    time: "Time",
    checkbox: "Checkbox",
    radio: "Radio button",
    select: "Select menu",
    range: "Range",
    color: "Color",
  };
  return labels[type] ?? humanizeToken(type || "field");
}

function fieldDetails(field: FormRecoveryField): string {
  const label = fieldLabel(field);
  const details: string[] = [];
  if (field.autocomplete && field.autocomplete !== "off") {
    details.push("Autofill: " + humanizeToken(field.autocomplete));
  }
  if (field.name && field.name !== label) details.push("Field name: " + truncate(field.name, 80));
  if (field.placeholder && field.placeholder !== label) {
    details.push("Placeholder: " + truncate(field.placeholder, 80));
  }
  if (!field.name && !field.placeholder && field.id && field.id !== label) {
    details.push("Field identifier: " + truncate(field.id, 80));
  }
  return details.join(" · ");
}

function humanizeToken(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Field";
}

function fieldValue(field: FormRecoveryField): string {
  if (field.type === "checkbox" || field.type === "radio") {
    return field.checked ? "Selected" : "Not selected";
  }
  if (field.values?.length) return field.values.join(", ");
  if (typeof field.value === "string") return truncate(field.value, 240);
  return "Saved state available";
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}
