import { MarkdownRenderChild, Notice, parseYaml, setIcon } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import { parseObsidianWebLink } from "../integrations/obsidian-link-router";
import type { WebviewElement, WebviewNavigateEvent } from "./webview-types";

/** WebView ownership shared by Markdown embeds, Canvas and hover previews. */
export class EmbeddedBrowser extends MarkdownRenderChild {
  private webview: WebviewElement | undefined;
  private popupDispose: (() => void) | undefined;
  private disposed = false;
  private address!: HTMLSpanElement;
  private status!: HTMLSpanElement;
  private currentUrl: string;
  private containerId: string;

  constructor(container: HTMLElement, private readonly plugin: UnifiedBrowserCorePlugin, url: string) {
    super(container);
    this.currentUrl = url;
    this.containerId = plugin.core.resolveContainerForNavigation(url, plugin.core.defaultContainerForNewTab());
  }

  onload(): void {
    const root = this.containerEl.createDiv({ cls: "ubc-embedded-browser" });
    const bar = root.createDiv({ cls: "ubc-embedded-browser-bar" });
    this.address = bar.createSpan({ cls: "ubc-embedded-browser-address", text: this.currentUrl });
    this.address.title = this.currentUrl;
    this.status = bar.createSpan({ cls: "ubc-embedded-browser-status", text: "Loading…", attr: { "aria-live": "polite" } });
    const open = bar.createEl("button", { attr: { type: "button", title: "Open in UBC tab", "aria-label": "Open in UBC tab" } });
    setIcon(open, "external-link");
    open.addEventListener("click", () => void this.plugin.openBrowser({ url: this.currentUrl }));
    const reload = bar.createEl("button", { attr: { type: "button", title: "Reload", "aria-label": "Reload" } });
    setIcon(reload, "refresh-cw");
    reload.addEventListener("click", () => this.webview?.reload());

    const guest = this.plugin.managedWebviewBackend.create(
      this.plugin.core.containers.get(this.containerId).partition,
      () => this.plugin.core.settings(), this.containerEl.ownerDocument,
    );
    this.webview = guest;
    const bind = (rebind: boolean) => {
      if (this.disposed || this.webview !== guest) return;
      if (rebind) { this.popupDispose?.(); this.popupDispose = undefined; }
      this.popupDispose ??= this.plugin.windowOpenAdapter.bind(guest, (url, disposition) => {
        if (!this.disposed) void this.plugin.openFromOpener(url, this.containerId, disposition);
      });
      if (rebind && !this.popupDispose) guest.removeAttribute("allowpopups");
      this.plugin.bindPermissions(guest, this.containerId);
    };
    guest.addEventListener("did-attach", () => bind(false));
    guest.addEventListener("dom-ready", () => { bind(true); this.status.textContent = "Ready"; });
    guest.addEventListener("did-navigate", (raw) => {
      const event = raw as WebviewNavigateEvent;
      if (event.isMainFrame === false) return;
      const next = parseObsidianWebLink(event.url);
      if (next) { this.currentUrl = next; this.address.textContent = next; this.address.title = next; }
    });
    guest.addEventListener("did-fail-load", () => { this.status.textContent = "Load failed"; });
    guest.addEventListener("did-start-loading", () => { this.status.textContent = "Loading…"; });
    guest.addEventListener("did-stop-loading", () => { this.status.textContent = "Ready"; });
    root.appendChild(guest);
    guest.src = this.currentUrl;
  }

  onunload(): void {
    this.disposed = true;
    this.popupDispose?.();
    this.popupDispose = undefined;
    if (this.webview) this.plugin.managedWebviewBackend.destroy(this.webview);
    this.webview = undefined;
    this.containerEl.empty();
  }
}

export function parseSurfingEmbedSource(source: string): string | null {
  const value = source.trim();
  if (!value) return null;
  const plain = parseObsidianWebLink(value);
  if (plain) return plain;
  try {
    const settings: unknown = parseYaml(value);
    if (!settings || typeof settings !== "object") return null;
    return parseObsidianWebLink((settings as { url?: unknown }).url as string | undefined);
  } catch {
    return null;
  }
}

export function addEmbeddedBrowser(container: HTMLElement, plugin: UnifiedBrowserCorePlugin, source: string): EmbeddedBrowser | null {
  const url = parseSurfingEmbedSource(source);
  if (!url) {
    const message = container.createDiv({ cls: "ubc-embed-error", text: "Expected a valid http:// or https:// URL (or YAML: url: https://…)." });
    message.setAttribute("role", "alert");
    return null;
  }
  return new EmbeddedBrowser(container, plugin, url);
}
