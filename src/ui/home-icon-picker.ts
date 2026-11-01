import { FuzzySuggestModal, getIconIds, setIcon, type App } from "obsidian";
import { t } from "../i18n";

/** A complete, searchable Lucide picker rather than a fixed icon subset. */
export class HomeIconPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private readonly choose: (icon: string | undefined) => void) {
    super(app);
    this.setPlaceholder(t("Search Lucide icons"));
    this.limit = 60;
  }

  getItems(): string[] {
    return ["", ...getIconIds()];
  }

  getItemText(icon: string): string {
    return icon || t("Reset to default icon");
  }

  renderSuggestion(match: { item: string }, el: HTMLElement): void {
    const row = el.createDiv({ cls: "ubc-home-icon-choice" });
    const preview = row.createSpan();
    setIcon(preview, match.item || "rotate-ccw");
    row.createSpan({ text: this.getItemText(match.item) });
  }

  onChooseItem(item: string): void {
    this.choose(item || undefined);
  }
}
