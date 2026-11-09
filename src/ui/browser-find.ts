import { setIcon } from "obsidian";
import type { WebviewElement } from "./webview-types";
import { resolveGuestWebContents } from "../adapters/electron-compat";
import { t } from "../i18n";

type FindResult = { requestId?: number; matches?: number; activeMatchOrdinal?: number };
type FindGuest = {
  findInPage: (text: string, options: { forward: boolean; findNext: boolean }) => number;
  stopFindInPage: (action: "clearSelection") => void;
  on: (event: "found-in-page", callback: (_event: unknown, result: FindResult) => void) => void;
  removeListener: (event: "found-in-page", callback: (_event: unknown, result: FindResult) => void) => void;
};

export class BrowserFindBar {
  readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLSpanElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private contents: FindGuest | undefined;
  private webview: WebviewElement | null = null;
  private query = "";
  private requestId: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement) {
    const root = parent.createDiv({ cls: "ubc-find-bar is-hidden", attr: { role: "search", "aria-label": t("Find in page") } });
    this.element = root;
    this.input = root.createEl("input", {
      cls: "ubc-find-input",
      attr: { type: "search", "aria-label": t("Find in page"), placeholder: t("Find in page"), autocomplete: "off" },
    });
    this.results = root.createSpan({ cls: "ubc-find-results", attr: { role: "status", "aria-live": "polite" } });
    const button = (icon: string, title: string, action: () => void) => {
      const el = root.createEl("button", { cls: "ubc-find-button clickable-icon", attr: { type: "button", title, "aria-label": title } });
      setIcon(el, icon);
      el.addEventListener("click", action);
      return el;
    };
    this.prev = button("chevron-up", t("Previous match"), () => this.step(false));
    this.next = button("chevron-down", t("Next match"), () => this.step(true));
    button("x", t("Close find"), () => this.close());

    this.input.addEventListener("input", () => {
      this.cancelPending();
      this.timer = setTimeout(() => { this.timer = undefined; this.search(true); }, 120);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        this.step(!event.shiftKey);
      }
    });
    this.updateStatus();
  }

  get isOpen(): boolean { return !this.element.hasClass("is-hidden"); }

  attach(webview: WebviewElement): void {
    if (this.webview === webview && this.contents) return;
    this.detachGuest();
    this.webview = webview;
    const guest = resolveGuestWebContents<FindGuest>(webview);
    if (!guest?.findInPage || !guest.stopFindInPage || !guest.on || !guest.removeListener) return;
    this.contents = guest;
    guest.on("found-in-page", this.found);
    if (this.isOpen && this.input.value) this.search(true);
  }

  open(): void {
    this.element.removeClass("is-hidden");
    this.input.focus();
    this.input.select();
    // Reopening restores the last query without retaining an old highlight.
    if (this.input.value && this.contents) this.search(true);
  }

  step(forward: boolean): void {
    this.cancelPending();
    this.search(forward);
  }

  close(): void {
    this.cancelPending();
    this.element.addClass("is-hidden");
    this.clearFind();
    this.webview?.focus();
  }

  navigate(): void {
    this.cancelPending();
    this.element.addClass("is-hidden");
    this.clearFind();
  }

  dispose(): void {
    this.navigate();
    this.detachGuest();
    this.element.remove();
  }

  private cancelPending(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private search(forward: boolean): void {
    if (!this.isOpen) return;
    const query = this.input.value;
    if (!query) { this.clearFind(); return; }
    if (this.query !== query) {
      try { this.contents?.stopFindInPage("clearSelection"); } catch { /* guest closing */ }
      this.query = query;
    }
    try {
      // Chromium/Surfing's reliable initial search path uses findNext=true.
      // Reset the previous search explicitly on a query change above, then
      // advance within the current query for both keyboard and button usage.
      this.requestId = this.contents?.findInPage(query, { forward, findNext: true });
      this.updateStatus(undefined, undefined);
    } catch {
      this.results.textContent = t("Find unavailable");
    }
  }

  private clearFind(): void {
    try { this.contents?.stopFindInPage("clearSelection"); } catch { /* guest closing */ }
    this.query = "";
    this.requestId = undefined;
    this.updateStatus();
  }

  private found = (_event: unknown, result: FindResult): void => {
    if (!this.isOpen || !this.query) return;
    if (this.requestId !== undefined && result.requestId !== undefined && result.requestId !== this.requestId) return;
    this.updateStatus(result.activeMatchOrdinal ?? 0, result.matches ?? 0);
  };

  private updateStatus(active?: number, matches?: number): void {
    const empty = !this.query;
    this.results.textContent = empty ? "" :
      matches === undefined ? t("Searching…") : `${active ?? 0}/${matches}`;
    this.prev.disabled = empty;
    this.next.disabled = empty;
  }

  private detachGuest(): void {
    if (this.contents) {
      try { this.contents.removeListener("found-in-page", this.found); } catch { /* guest already detached */ }
    }
    this.contents = undefined;
    this.webview = null;
    this.requestId = undefined;
  }
}
