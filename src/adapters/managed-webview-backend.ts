import type { WebviewElement } from "../ui/webview-types";

/**
 * Compatibility backend for Browser Core features that need a dedicated
 * persistent Electron partition. Keep direct <webview> construction here so
 * a future WebContentsView or Obsidian-provided backend can replace it.
 */
export class ManagedWebviewBackend {
  private readonly liveGuests = new Set<WebviewElement>();

  create(partition: string): WebviewElement {
    const webview = document.createElement("webview") as WebviewElement;
    webview.addClass("ubc-webview");
    webview.partition = partition;
    // Keep the Surfing-compatible popup capability available while the guest
    // is attaching. BrowserView binds ElectronWindowOpenAdapter as soon as
    // guest WebContents is addressable and removes this attribute if that
    // control point is still unavailable by dom-ready.
    webview.setAttribute("allowpopups", "");
    webview.setAttribute(
      "webpreferences",
      "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
    );
    this.liveGuests.add(webview);
    return webview;
  }

  destroy(webview: WebviewElement): void {
    this.liveGuests.delete(webview);
    try {
      webview.stop?.();
    } catch {
      // The guest may already have been destroyed by the host.
    }
    webview.remove();
  }

  dispose(): void {
    for (const webview of [...this.liveGuests]) this.destroy(webview);
  }

  activeGuestCount(): number {
    return this.liveGuests.size;
  }
}
