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
};

type WebContentsLike = {
  setWindowOpenHandler?: (
    handler: (details: WindowOpenDetails) => { action: "deny" },
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

const WINDOW_OPEN_CHANNEL = "unified-browser-core:window-open:v2";
const MAIN_RUNTIME_FILENAME = "/tmp/unified-browser-core-window-open-runtime-v2.cjs";
// Main-process handlers must make their deny decision synchronously. Renderer
// callbacks crossing @electron/remote cannot safely supply that decision.
export const MAIN_RUNTIME_SOURCE = String.raw`
"use strict";
const { webContents } = require("electron");
const singletonKey = Symbol.for("unified-browser-core.window-open-runtime.v2");

if (!globalThis[singletonKey]) {
  const bindings = new Map();

  const normalizeDisposition = (value) => {
    if (value === "background-tab") return "background";
    return "new-tab";
  };
  const unbind = (bindingId) => {
    const state = bindings.get(bindingId);
    if (!state) return;
    bindings.delete(bindingId);
    try { state.guest.removeListener("destroyed", state.onDestroyed); } catch {}
    try { state.guest.setWindowOpenHandler(() => ({ action: "deny" })); } catch {}
  };
  const bind = ({ bindingId, guestId, hostId, channel }) => {
    unbind(bindingId);
    const guest = webContents.fromId(guestId);
    const host = webContents.fromId(hostId);
    if (!guest || !host || guest.isDestroyed() || host.isDestroyed()) return false;
    const onDestroyed = () => unbind(bindingId);
    const state = { guest, host, onDestroyed };
    bindings.set(bindingId, state);
    guest.once("destroyed", onDestroyed);
    guest.setWindowOpenHandler((details) => {
      // Surfing-like policy: every web popup becomes an Obsidian tab,
      // including named windows and requests with popup/size features.
      setImmediate(() => {
        try {
          if (bindings.get(bindingId) === state && !host.isDestroyed()) {
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
    diagnostics: () => ({ activeAuxiliaryWindows: 0 }),
  };
}

module.exports = globalThis[singletonKey];
`;

export class ElectronWindowOpenAdapter {
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

    // Fallback keeps the same routing policy when main-process installation
    // is unavailable. Do not create an auxiliary OS-level window.
    let bound = true;
    contents.setWindowOpenHandler((details) => {
      const disposition = normalizePopupDisposition(details.disposition);
      window.setTimeout(() => {
        if (bound) open(details.url, disposition);
      }, 0);
      return { action: "deny" };
    });
    return () => {
      bound = false;
      contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
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
  }

  activeAuxiliaryWindowCount(): number {
    return 0;
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
        value.disposition === "background" ? "background" : "new-tab";
      callback(value.url, disposition);
    };
    ipcRenderer.on?.(WINDOW_OPEN_CHANNEL, this.ipcListener);
  }
}

export function normalizePopupDisposition(value: string | undefined): BrowserOpenDisposition {
  return value === "background-tab" ? "background" : "new-tab";
}
