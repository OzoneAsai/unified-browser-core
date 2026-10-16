import { resolvePartitionSession } from "./electron-compat";
import type { BrowserSettings } from "../core/model";
import type { WebviewElement } from "../ui/webview-types";
import { GuestBrowserApis } from "./guest-browser-apis";
import { pathToFileURL } from "node:url";

/**
 * Compatibility backend for Browser Core features that need a dedicated
 * persistent Electron partition. Keep direct <webview> construction here so
 * a future WebContentsView or Obsidian-provided backend can replace it.
 */
export class ManagedWebviewBackend {
  private readonly liveGuests = new Set<WebviewElement>();
  readonly browserApis = new GuestBrowserApis();

  private readonly policySessions = new Map<string, PolicySession>();
  private storageFlushTimer?: ReturnType<typeof setTimeout>;
  private storageFlushQueue: Promise<void> = Promise.resolve();
  private shutdownPreparation?: Promise<void>;
  private settings?: () => BrowserSettings;

  create(partition: string, settings?: () => BrowserSettings, doc: Document = document): WebviewElement {
    this.settings = settings ?? this.settings;
    this.bindPolicy(partition);
    const webview = doc.createElement("webview") as WebviewElement;
    webview.addClass("ubc-webview");
    webview.partition = partition;
    const preload = this.browserApis.preload();
    if (preload) webview.setAttribute("preload", pathToFileURL(preload).href);
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
    this.browserApis.remove(webview);
    this.liveGuests.delete(webview);
    try {
      webview.stop?.();
    } catch {
      // The guest may already have been destroyed by the host.
    }
    webview.remove();
  }

  /** A detached Electron webview does not dispatch normal page unload events.
   * Navigate it first so sites can persist their own state, then flush the
   * partition without inspecting or copying any site data. */
  async destroyGracefully(webview: WebviewElement): Promise<void> {
    try {
      await this.unloadGuestPage(webview);
      await this.flushPersistentSessions();
    } finally {
      this.destroy(webview);
    }
  }

  /** Called while the Obsidian leaf is still attached. The host may detach
   * its DOM before View.onClose, so this must run before leaf.detach(). */
  async prepareGuestForRemoval(webview: WebviewElement): Promise<void> {
    await this.unloadGuestPage(webview);
    await this.flushPersistentSessions();
  }

  private async unloadGuestPage(webview: WebviewElement): Promise<void> {
    if (!this.liveGuests.has(webview) || !webview.loadURL) return;
    let url = "";
    try { url = webview.getURL?.() || ""; } catch { return; }
    if (!/^https?:\/\//i.test(url)) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        webview.loadURL("about:blank").catch(() => undefined),
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000); }),
      ]);
    } catch {
      // Guest may already be destroyed; bounded best-effort shutdown.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /** Run before the host tears down renderer contents. Sites get a real
   * pagehide/beforeunload and their own persistence code runs first. */
  prepareForShutdown(): Promise<void> {
    if (!this.shutdownPreparation) {
      this.shutdownPreparation = (async () => {
        await Promise.all([...this.liveGuests].map((guest) => this.unloadGuestPage(guest)));
        await this.flushPersistentSessions();
      })();
    }
    return this.shutdownPreparation;
  }

  /** Flush all active persistent guest partitions, including cookies. This
   * does not copy site credentials or browser data into plugin settings. */
  flushPersistentSessions(): Promise<void> {
    if (this.storageFlushTimer !== undefined) {
      clearTimeout(this.storageFlushTimer);
      this.storageFlushTimer = undefined;
    }
    const sessions = [...new Set(this.policySessions.values())];
    const next = this.storageFlushQueue.then(async () => {
      await Promise.all(sessions.map(async (session) => {
        await session.flushStorageData?.();
        await session.cookies?.flushStore?.();
      }));
    });
    this.storageFlushQueue = next.catch(() => undefined);
    return next;
  }

  scheduleStorageFlush(delayMs = 1500): void {
    if (this.storageFlushTimer !== undefined) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = setTimeout(() => {
      this.storageFlushTimer = undefined;
      void this.flushPersistentSessions().catch(error =>
        console.warn("Unified Browser Core: failed to flush guest storage", error));
    }, delayMs);
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
    if (this.storageFlushTimer !== undefined) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = undefined;
    this.browserApis.dispose();
    for (const session of this.policySessions.values()) session.webRequest?.onHeadersReceived(null);
    this.policySessions.clear();
    for (const webview of [...this.liveGuests]) this.destroy(webview);
  }

  activeGuestCount(): number {
    return this.liveGuests.size;
  }
}

interface PolicySession {
  flushStorageData?: () => Promise<void>;
  cookies?: { flushStore?: () => Promise<void> };
  webRequest?: {
    onHeadersReceived: {
      (filter: { urls: string[] }, listener: (details: { webContentsId: number; resourceType: string; responseHeaders?: Record<string, string[]> }, callback: (response: { responseHeaders: Record<string, string[]> }) => void) => void): void;
      (listener: null): void;
    };
  };
}
