import type { BrowserOpenDisposition } from "../api/browser-api";
import type { WebviewElement } from "../ui/webview-types";
import {
  compileMainProcessModule,
  resolveElectronRemote,
  resolveElectronRenderer,
  resolveGuestWebContents,
} from "./electron-compat";

type WindowOpenDetails = {
  url: string;
  disposition?: string;
  frameName?: string;
  features?: string;
};

type BrowserWindowLike = {
  close?: () => void;
  isDestroyed?: () => boolean;
  once?: (event: "closed", listener: () => void) => void;
};

type WindowOpenHandlerResponse =
  | { action: "deny" }
  | {
      action: "allow";
      outlivesOpener?: boolean;
      overrideBrowserWindowOptions?: {
        show?: boolean;
        webPreferences?: {
          nodeIntegration?: boolean;
          contextIsolation?: boolean;
          sandbox?: boolean;
        };
      };
    };

type WebContentsLike = {
  setWindowOpenHandler?: (
    handler: (details: WindowOpenDetails) => WindowOpenHandlerResponse,
  ) => void;
  on?: (
    event: "did-create-window",
    listener: (window: BrowserWindowLike, details: WindowOpenDetails) => void,
  ) => void;
  removeListener?: (
    event: "did-create-window",
    listener: (window: BrowserWindowLike, details: WindowOpenDetails) => void,
  ) => void;
};

type IpcRendererLike = {
  on?: (channel: string, listener: (_event: unknown, payload: unknown) => void) => void;
  removeListener?: (channel: string, listener: (_event: unknown, payload: unknown) => void) => void;
};

type MainWindowOpenRuntime = {
  bind?: (input: {
    bindingId: string;
    guestId: number;
    hostId: number;
    channel: string;
  }) => boolean;
  unbind?: (bindingId: string) => void;
  diagnostics?: () => {
    activeAuxiliaryWindows: number;
  };
};

const WINDOW_OPEN_CHANNEL = "unified-browser-core:window-open:v1";
const MAIN_RUNTIME_FILENAME = "/tmp/unified-browser-core-window-open-runtime.cjs";
const MAIN_RUNTIME_SOURCE = String.raw`
"use strict";
const { webContents } = require("electron");
const singletonKey = Symbol.for("unified-browser-core.window-open-runtime.v1");

if (!globalThis[singletonKey]) {
  const bindings = new Map();

  const normalizeDisposition = (value) => {
    if (value === "background-tab") return "background";
    if (value === "new-window") return "new-window";
    return "new-tab";
  };
  const classify = (details) => {
    const frameName = details.frameName && details.frameName.trim();
    if (frameName && !["_blank", "_self", "_top", "_parent"].includes(frameName.toLowerCase())) {
      return "auxiliary";
    }
    if (details.features && details.features.trim()) return "auxiliary";
    return "core-tab";
  };
  const closeChild = (child) => {
    try {
      if (child && !child.isDestroyed()) child.close();
    } catch {}
  };
  const unbind = (bindingId) => {
    const state = bindings.get(bindingId);
    if (!state) return;
    bindings.delete(bindingId);
    try { state.guest.removeListener("did-create-window", state.onCreated); } catch {}
    try { state.guest.removeListener("destroyed", state.onDestroyed); } catch {}
    try { state.guest.setWindowOpenHandler(() => ({ action: "deny" })); } catch {}
    for (const child of state.children) closeChild(child);
    state.children.clear();
  };
  const bind = ({ bindingId, guestId, hostId, channel }) => {
    unbind(bindingId);
    const guest = webContents.fromId(guestId);
    const host = webContents.fromId(hostId);
    if (!guest || !host || guest.isDestroyed() || host.isDestroyed()) return false;
    const children = new Set();
    const onCreated = (child, details) => {
      children.add(child);
      child.once("closed", () => children.delete(child));
      if (details && details.url && details.url !== "about:blank" && !details.postBody) {
        setTimeout(() => {
          try {
            if (child.isDestroyed()) return;
            const current = child.webContents && child.webContents.getURL();
            if (!current || current === "about:blank") {
              child.webContents.loadURL(details.url);
            }
          } catch {}
        }, 100);
      }
    };
    const onDestroyed = () => unbind(bindingId);
    const state = { guest, host, children, onCreated, onDestroyed };
    bindings.set(bindingId, state);
    guest.on("did-create-window", onCreated);
    guest.once("destroyed", onDestroyed);
    guest.setWindowOpenHandler((details) => {
      const classification = classify(details);
      if (classification === "auxiliary") {
        return { action: "allow", outlivesOpener: false };
      }
      setImmediate(() => {
        try {
          if (!host.isDestroyed()) {
            host.send(channel, {
              bindingId,
              url: details.url,
              disposition: normalizeDisposition(details.disposition),
            });
          }
        } catch {}
      });
      return { action: "deny" };
    });
    return true;
  };
  globalThis[singletonKey] = {
    bind,
    unbind,
    diagnostics: () => {
      let activeAuxiliaryWindows = 0;
      for (const state of bindings.values()) {
        activeAuxiliaryWindows += state.children.size;
      }
      return { activeAuxiliaryWindows };
    },
  };
}

module.exports = globalThis[singletonKey];
`;

export class ElectronWindowOpenAdapter {
  private readonly auxiliaryWindows = new Set<BrowserWindowLike>();
  private readonly rendererBindings = new Map<
    string,
    (url: string, disposition: BrowserOpenDisposition) => void
  >();
  private mainRuntime: MainWindowOpenRuntime | undefined;
  private ipcRenderer: IpcRendererLike | undefined;
  private ipcListener:
    | ((_event: unknown, payload: unknown) => void)
    | undefined;

  bind(
    webview: WebviewElement,
    open: (url: string, disposition: BrowserOpenDisposition) => void,
  ): (() => void) | undefined {
    const contents = resolveGuestWebContents<WebContentsLike>(webview);
    if (!contents?.setWindowOpenHandler) return undefined;
    const guestId = this.guestId(webview);
    const hostId = this.hostWebContentsId();
    const mainRuntime = this.resolveMainRuntime();
    const ipcRenderer = this.resolveIpcRenderer();
    if (
      typeof guestId === "number" &&
      typeof hostId === "number" &&
      mainRuntime?.bind &&
      ipcRenderer?.on
    ) {
      const bindingId = `${hostId}:${guestId}`;
      this.ensureIpcListener(ipcRenderer);
      this.rendererBindings.set(bindingId, open);
      let bound = false;
      try {
        bound = Boolean(mainRuntime.bind({
          bindingId,
          guestId,
          hostId,
          channel: WINDOW_OPEN_CHANNEL,
        }));
      } catch {
        bound = false;
      }
      if (bound) {
        return () => {
          this.rendererBindings.delete(bindingId);
          try {
            mainRuntime.unbind?.(bindingId);
          } catch {
            // The guest or host renderer may already be gone.
          }
        };
      }
      this.rendererBindings.delete(bindingId);
    }

    // Compatibility fallback for hosts where a main-process runtime cannot
    // be installed. It still keeps ordinary target=_blank navigation under
    // Browser Core ownership, but auxiliary opener semantics may be degraded.
    const ownedChildren = new Set<BrowserWindowLike>();
    const trackChild = (window: BrowserWindowLike) => {
      this.auxiliaryWindows.add(window);
      ownedChildren.add(window);
      window.once?.("closed", () => {
        ownedChildren.delete(window);
        this.auxiliaryWindows.delete(window);
      });
    };
    const onCreated = (window: BrowserWindowLike) => {
      trackChild(window);
    };
    contents.on?.("did-create-window", onCreated);
    contents.setWindowOpenHandler((details) => {
      const classification = classifyWindowOpen(details);
      if (classification === "auxiliary") {
        window.setTimeout(() => open(details.url, "new-tab"), 0);
        return { action: "deny" };
      }
      const disposition = normalizeDisposition(details.disposition);
      window.setTimeout(() => open(details.url, disposition), 0);
      return { action: "deny" };
    });
    return () => {
      contents.removeListener?.("did-create-window", onCreated);
      contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
      for (const child of [...ownedChildren]) {
        try {
          if (!child.isDestroyed?.()) child.close?.();
        } catch {
          // The child may already be tearing down with its opener.
        }
        ownedChildren.delete(child);
        this.auxiliaryWindows.delete(child);
      }
    };
  }

  dispose(): void {
    for (const bindingId of [...this.rendererBindings.keys()]) {
      try {
        this.mainRuntime?.unbind?.(bindingId);
      } catch {
        // Best effort during renderer/plugin teardown.
      }
      this.rendererBindings.delete(bindingId);
    }
    if (this.ipcListener && this.ipcRenderer?.removeListener) {
      this.ipcRenderer.removeListener(WINDOW_OPEN_CHANNEL, this.ipcListener);
    }
    this.ipcListener = undefined;
    for (const child of [...this.auxiliaryWindows]) {
      try {
        if (!child.isDestroyed?.()) child.close?.();
      } catch {
        // The host may already be tearing the window down.
      }
      this.auxiliaryWindows.delete(child);
    }
  }

  activeAuxiliaryWindowCount(): number {
    try {
      return (
        this.mainRuntime?.diagnostics?.().activeAuxiliaryWindows ??
        this.auxiliaryWindows.size
      );
    } catch {
      return this.auxiliaryWindows.size;
    }
  }

  private resolveMainRuntime(): MainWindowOpenRuntime | undefined {
    if (this.mainRuntime) return this.mainRuntime;
    this.mainRuntime = compileMainProcessModule<MainWindowOpenRuntime>(
      MAIN_RUNTIME_FILENAME,
      MAIN_RUNTIME_SOURCE,
    );
    return this.mainRuntime;
  }

  private resolveIpcRenderer(): IpcRendererLike | undefined {
    if (this.ipcRenderer) return this.ipcRenderer;
    this.ipcRenderer = resolveElectronRenderer<{ ipcRenderer?: IpcRendererLike }>()
      ?.ipcRenderer;
    return this.ipcRenderer;
  }

  private hostWebContentsId(): number | undefined {
    try {
      return resolveElectronRemote<{
        getCurrentWebContents?: () => { id?: number };
      }>()?.getCurrentWebContents?.()?.id;
    } catch {
      return undefined;
    }
  }

  private guestId(webview: WebviewElement): number | undefined {
    try {
      const id = webview.getWebContentsId?.();
      return typeof id === "number" ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private ensureIpcListener(ipcRenderer: IpcRendererLike): void {
    if (this.ipcListener) return;
    this.ipcListener = (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as {
        bindingId?: unknown;
        url?: unknown;
        disposition?: unknown;
      };
      if (
        typeof value.bindingId !== "string" ||
        typeof value.url !== "string"
      ) return;
      const callback = this.rendererBindings.get(value.bindingId);
      if (!callback) return;
      const disposition: BrowserOpenDisposition =
        value.disposition === "background" ||
        value.disposition === "new-window" ||
        value.disposition === "current"
          ? value.disposition
          : "new-tab";
      callback(value.url, disposition);
    };
    ipcRenderer.on?.(WINDOW_OPEN_CHANNEL, this.ipcListener);
  }
}

function normalizeDisposition(value: string | undefined): BrowserOpenDisposition {
  if (value === "background-tab") return "background";
  if (value === "new-window") return "new-window";
  return "new-tab";
}

export function classifyWindowOpen(
  details: Pick<WindowOpenDetails, "disposition" | "frameName" | "features">,
): "auxiliary" | "core-tab" {
  const frameName = details.frameName?.trim();
  if (frameName && !["_blank", "_self", "_top", "_parent"].includes(frameName.toLowerCase())) return "auxiliary";
  if (details.features?.trim()) return "auxiliary";
  return "core-tab";
}
