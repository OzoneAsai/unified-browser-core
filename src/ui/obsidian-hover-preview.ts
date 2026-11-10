import type UnifiedBrowserCorePlugin from "../main";
import { EmbeddedBrowser } from "./embedded-browser";

/** Non-invasive page preview: one delayed managed guest for one hovered link. */
export class ObsidianHoverPreview {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dismissTimer: ReturnType<typeof setTimeout> | undefined;
  private anchor: Element | null = null;
  private url = "";
  private pane: HTMLDivElement | undefined;
  private component: EmbeddedBrowser | undefined;

  constructor(private readonly plugin: UnifiedBrowserCorePlugin) {}

  enter(anchor: Element, url: string): void {
    // A hidden window cannot have an actionable hover target. Chromium can
    // defer timers there and fire them much later when the window reappears.
    if (anchor.ownerDocument.hidden) return;
    if (this.anchor === anchor && this.url === url) { this.cancelDismiss(); return; }
    this.close();
    this.anchor = anchor;
    this.url = url;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!anchor.isConnected || this.plugin.isUnloading()) return;
      this.show(anchor, url);
    }, 550);
  }

  leave(anchor: Element): void {
    if (this.anchor !== anchor) return;
    if (this.timer !== undefined) { this.close(); return; }
    this.scheduleDismiss();
  }

  close(): void {
    this.cancelDismiss();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.anchor = null;
    this.url = "";
    this.component?.unload();
    this.component = undefined;
    this.pane?.remove();
    this.pane = undefined;
  }

  private show(anchor: Element, url: string): void {
    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    if (!win || this.anchor !== anchor || this.url !== url || doc.hidden) {
      this.close();
      return;
    }
    const pane = doc.createElement("div");
    pane.className = "ubc-hover-preview";
    pane.setAttribute("role", "region");
    pane.setAttribute("aria-label", "Web link preview");
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(520, win.innerWidth - 24);
    const height = Math.min(365, win.innerHeight - 24);
    const left = Math.min(Math.max(12, rect.left), Math.max(12, win.innerWidth - width - 12));
    const top = rect.bottom + height + 8 < win.innerHeight
      ? rect.bottom + 8 : Math.max(12, rect.top - height - 8);
    pane.style.left = `${left}px`;
    pane.style.top = `${top}px`;
    pane.style.width = `${width}px`;
    pane.style.height = `${height}px`;
    pane.addEventListener("pointerenter", () => this.cancelDismiss());
    pane.addEventListener("pointerleave", () => this.scheduleDismiss());
    pane.addEventListener("keydown", event => { if (event.key === "Escape") this.close(); });
    doc.body.appendChild(pane);
    this.pane = pane;
    const component = new EmbeddedBrowser(pane, this.plugin, url);
    this.component = component;
    component.load();
  }

  private scheduleDismiss(): void {
    this.cancelDismiss();
    this.dismissTimer = setTimeout(() => this.close(), 240);
  }

  private cancelDismiss(): void {
    if (this.dismissTimer !== undefined) clearTimeout(this.dismissTimer);
    this.dismissTimer = undefined;
  }
}
