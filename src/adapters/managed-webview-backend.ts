import { resolvePartitionSession } from "./electron-compat";
import type { BrowserSettings } from "../core/model";
import type { WebviewElement } from "../ui/webview-types";

/**
 * Compatibility backend for Browser Core features that need a dedicated
 * persistent Electron partition. Keep direct <webview> construction here so
 * a future WebContentsView or Obsidian-provided backend can replace it.
 */
export class ManagedWebviewBackend {
  private readonly liveGuests = new Set<WebviewElement>();

  private readonly policySessions = new Map<string, PolicySession>();
  private settings?: () => BrowserSettings;

  create(partition: string, settings?: () => BrowserSettings): WebviewElement {
    this.settings = settings ?? this.settings;
    this.bindPolicy(partition);
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
      `contextIsolation=yes,nodeIntegration=no,sandbox=yes,autoplayPolicy=${settings?.().autoplayPolicy === "allow" ? "no-user-gesture-required" : "document-user-activation-required"}`,
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

  private bindPolicy(partition: string): void {
    if (this.policySessions.has(partition)) return;
    const session = resolvePartitionSession<PolicySession>(partition);
    if (!session?.webRequest?.onHeadersReceived) return;
    session.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      const ownGuest = [...this.liveGuests].some((guest) => {
        try { return guest.getWebContentsId?.() === details.webContentsId; } catch { return false; }
      });
      const headers = { ...details.responseHeaders };
      if (ownGuest && this.settings?.().blockPasskeyRequests && ["mainFrame", "subFrame"].includes(details.resourceType)) {
        const key = Object.keys(headers).find((name) => name.toLowerCase() === "permissions-policy");
        const existing = key ? headers[key]?.join(", ") ?? "" : "";
        // Replace these directives, retaining the site's other policies.
        const rest = existing.split(/,(?![^()]*\))/).filter((part) => !/^\s*publickey-credentials-(get|create)\s*=/.test(part));
        if (key) delete headers[key];
        headers["Permissions-Policy"] = [[...rest.filter(Boolean), "publickey-credentials-get=()", "publickey-credentials-create=()"].join(", ")];
      }
      callback({ responseHeaders: headers });
    });
    this.policySessions.set(partition, session);
  }

  dispose(): void {
    for (const session of this.policySessions.values()) session.webRequest?.onHeadersReceived(null);
    this.policySessions.clear();
    for (const webview of [...this.liveGuests]) this.destroy(webview);
  }

  activeGuestCount(): number {
    return this.liveGuests.size;
  }
}

interface PolicySession {
  webRequest?: {
    onHeadersReceived: {
      (filter: { urls: string[] }, listener: (details: { webContentsId: number; resourceType: string; responseHeaders?: Record<string, string[]> }, callback: (response: { responseHeaders: Record<string, string[]> }) => void) => void): void;
      (listener: null): void;
    };
  };
}
