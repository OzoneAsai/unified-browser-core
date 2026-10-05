"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => UnifiedBrowserCorePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian16 = require("obsidian");

// src/adapters/electron-compat.ts
function resolveElectronRemote() {
  const req = rendererRequire();
  if (!req) return void 0;
  try {
    return req("@electron/remote");
  } catch {
    try {
      return req("electron")?.remote;
    } catch {
      return void 0;
    }
  }
}
function resolveElectronRenderer() {
  const req = rendererRequire();
  if (!req) return void 0;
  try {
    return req("electron");
  } catch {
    return void 0;
  }
}
function compileMainProcessModule(virtualFilename, source) {
  const remote = resolveElectronRemote();
  if (!remote?.require) return void 0;
  try {
    const Module = remote.require("module");
    if (typeof Module !== "function") return void 0;
    const compiled = new Module(virtualFilename);
    compiled.filename = virtualFilename;
    compiled.paths = [];
    compiled._compile(source, virtualFilename);
    return compiled.exports;
  } catch {
    return void 0;
  }
}
function resolveGuestWebContents(webview) {
  try {
    const id = webview.getWebContentsId?.();
    if (typeof id !== "number") return void 0;
    const remote = resolveElectronRemote();
    return remote?.webContents?.fromId?.(id);
  } catch {
    return void 0;
  }
}
function resolvePartitionSession(partition) {
  const remote = resolveElectronRemote();
  return remote?.session?.fromPartition?.(partition);
}
function rendererRequire() {
  return window.require;
}

// src/adapters/electron-permissions.ts
var ElectronPermissionAdapter = class {
  boundSessions = /* @__PURE__ */ new Map();
  bind(webview, containerId, store, prompt, onChanged) {
    if (this.boundSessions.has(containerId)) return true;
    const session = this.resolve(webview)?.session;
    if (!session?.setPermissionCheckHandler || !session.setPermissionRequestHandler) return false;
    session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const origin = normalizeOrigin(requestingOrigin);
      if (!origin) return false;
      return store.decision(containerId, origin, permission) === "allow";
    });
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = normalizeOrigin(details?.requestingUrl || webContents?.getURL?.() || "");
      if (!origin) {
        callback(false);
        return;
      }
      const remembered = store.decision(containerId, origin, permission);
      if (remembered !== "ask") {
        callback(remembered === "allow");
        return;
      }
      void prompt(origin, permission).then((decision) => {
        if (decision !== "ask") {
          store.set(containerId, origin, permission, decision);
          onChanged();
        }
        callback(decision === "allow");
      });
    });
    this.boundSessions.set(containerId, session);
    return true;
  }
  release(containerId) {
    const session = this.boundSessions.get(containerId);
    if (!session) return;
    session.setPermissionCheckHandler?.(null);
    session.setPermissionRequestHandler?.(null);
    this.boundSessions.delete(containerId);
  }
  dispose() {
    for (const containerId of [...this.boundSessions.keys()]) this.release(containerId);
  }
  boundSessionCount() {
    return this.boundSessions.size;
  }
  resolve(webview) {
    return resolveGuestWebContents(webview);
  }
};
function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return void 0;
  }
}

// src/adapters/electron-session-data.ts
var ElectronSessionDataAdapter = class {
  async clearPartition(partition) {
    const session = this.resolve(partition);
    if (!session) return false;
    try {
      if (session.clearData) {
        await session.clearData();
      } else {
        await Promise.all([
          session.clearStorageData?.(),
          session.clearCache?.(),
          session.clearAuthCache?.()
        ]);
      }
      return true;
    } catch {
      return false;
    }
  }
  resolve(partition) {
    return resolvePartitionSession(partition);
  }
};

// src/adapters/electron-window-open.ts
var WINDOW_OPEN_CHANNEL = "unified-browser-core:window-open:v1";
var MAIN_RUNTIME_FILENAME = "/tmp/unified-browser-core-window-open-runtime.cjs";
var MAIN_RUNTIME_SOURCE = String.raw`
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
  const parseFeatures = (value) => {
    const features = new Map();
    for (const rawPart of (value || "").split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const equals = part.indexOf("=");
      const key = (equals >= 0 ? part.slice(0, equals) : part).trim().toLowerCase();
      if (!key) continue;
      const featureValue = equals >= 0 ? part.slice(equals + 1).trim().toLowerCase() : "";
      features.set(key, featureValue);
    }
    return features;
  };
  const featureEnabled = (features, key) => {
    if (!features.has(key)) return false;
    return !["0", "no", "false", "off"].includes(features.get(key));
  };
  const classify = (details) => {
    const features = parseFeatures(details.features);
    if (featureEnabled(features, "noopener") || featureEnabled(features, "noreferrer")) {
      return "core-tab";
    }
    const frameName = details.frameName && details.frameName.trim();
    if (frameName && !["_blank", "_self", "_top", "_parent"].includes(frameName.toLowerCase())) {
      return "auxiliary";
    }
    if (featureEnabled(features, "popup")) return "auxiliary";
    if (["width", "height", "left", "top", "screenx", "screeny"].some((key) => features.has(key))) {
      return "auxiliary";
    }
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
var ElectronWindowOpenAdapter = class {
  auxiliaryWindows = /* @__PURE__ */ new Set();
  rendererBindings = /* @__PURE__ */ new Map();
  mainRuntime;
  ipcRenderer;
  ipcListener;
  bind(webview, open) {
    const contents = resolveGuestWebContents(webview);
    if (!contents?.setWindowOpenHandler) return void 0;
    const guestId = this.guestId(webview);
    const hostId = this.hostWebContentsId();
    const mainRuntime = this.resolveMainRuntime();
    const ipcRenderer = this.resolveIpcRenderer();
    if (typeof guestId === "number" && typeof hostId === "number" && mainRuntime?.bind && ipcRenderer?.on) {
      const bindingId = `${hostId}:${guestId}`;
      this.ensureIpcListener(ipcRenderer);
      this.rendererBindings.set(bindingId, open);
      let bound = false;
      try {
        bound = Boolean(mainRuntime.bind({
          bindingId,
          guestId,
          hostId,
          channel: WINDOW_OPEN_CHANNEL
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
          }
        };
      }
      this.rendererBindings.delete(bindingId);
    }
    const ownedChildren = /* @__PURE__ */ new Set();
    const trackChild = (window2) => {
      this.auxiliaryWindows.add(window2);
      ownedChildren.add(window2);
      window2.once?.("closed", () => {
        ownedChildren.delete(window2);
        this.auxiliaryWindows.delete(window2);
      });
    };
    const onCreated = (window2) => {
      trackChild(window2);
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
        }
        ownedChildren.delete(child);
        this.auxiliaryWindows.delete(child);
      }
    };
  }
  dispose() {
    for (const bindingId of [...this.rendererBindings.keys()]) {
      try {
        this.mainRuntime?.unbind?.(bindingId);
      } catch {
      }
      this.rendererBindings.delete(bindingId);
    }
    if (this.ipcListener && this.ipcRenderer?.removeListener) {
      this.ipcRenderer.removeListener(WINDOW_OPEN_CHANNEL, this.ipcListener);
    }
    this.ipcListener = void 0;
    for (const child of [...this.auxiliaryWindows]) {
      try {
        if (!child.isDestroyed?.()) child.close?.();
      } catch {
      }
      this.auxiliaryWindows.delete(child);
    }
  }
  activeAuxiliaryWindowCount() {
    try {
      return this.mainRuntime?.diagnostics?.().activeAuxiliaryWindows ?? this.auxiliaryWindows.size;
    } catch {
      return this.auxiliaryWindows.size;
    }
  }
  resolveMainRuntime() {
    if (this.mainRuntime) return this.mainRuntime;
    this.mainRuntime = compileMainProcessModule(
      MAIN_RUNTIME_FILENAME,
      MAIN_RUNTIME_SOURCE
    );
    return this.mainRuntime;
  }
  resolveIpcRenderer() {
    if (this.ipcRenderer) return this.ipcRenderer;
    this.ipcRenderer = resolveElectronRenderer()?.ipcRenderer;
    return this.ipcRenderer;
  }
  hostWebContentsId() {
    try {
      return resolveElectronRemote()?.getCurrentWebContents?.()?.id;
    } catch {
      return void 0;
    }
  }
  guestId(webview) {
    try {
      const id = webview.getWebContentsId?.();
      return typeof id === "number" ? id : void 0;
    } catch {
      return void 0;
    }
  }
  ensureIpcListener(ipcRenderer) {
    if (this.ipcListener) return;
    this.ipcListener = (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload;
      if (typeof value.bindingId !== "string" || typeof value.url !== "string") return;
      const callback = this.rendererBindings.get(value.bindingId);
      if (!callback) return;
      const disposition = value.disposition === "background" || value.disposition === "new-window" || value.disposition === "current" ? value.disposition : "new-tab";
      callback(value.url, disposition);
    };
    ipcRenderer.on?.(WINDOW_OPEN_CHANNEL, this.ipcListener);
  }
};
function normalizeDisposition(value) {
  if (value === "background-tab") return "background";
  if (value === "new-window") return "new-window";
  return "new-tab";
}
function classifyWindowOpen(details) {
  const features = parseWindowFeatures(details.features);
  if (featureEnabled2(features, "noopener") || featureEnabled2(features, "noreferrer")) return "core-tab";
  const frameName = details.frameName?.trim();
  if (frameName && !["_blank", "_self", "_top", "_parent"].includes(frameName.toLowerCase())) return "auxiliary";
  if (featureEnabled2(features, "popup")) return "auxiliary";
  if (["width", "height", "left", "top", "screenx", "screeny"].some((key) => features.has(key))) return "auxiliary";
  return "core-tab";
}
function parseWindowFeatures(value) {
  const features = /* @__PURE__ */ new Map();
  for (const rawPart of (value ?? "").split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const equals = part.indexOf("=");
    const key = (equals >= 0 ? part.slice(0, equals) : part).trim().toLowerCase();
    if (!key) continue;
    const featureValue = equals >= 0 ? part.slice(equals + 1).trim().toLowerCase() : "";
    features.set(key, featureValue);
  }
  return features;
}
function featureEnabled2(features, key) {
  if (!features.has(key)) return false;
  return !["0", "no", "false", "off"].includes(features.get(key) ?? "");
}

// src/adapters/electron-context-menu.ts
var EDITABLE_CONTEXT_MARKER = "__UBC_EDITABLE_CONTEXT__";
var ElectronContextMenuAdapter = class {
  bind(webview, buildEntries) {
    const contents = resolveGuestWebContents(webview);
    const remote = resolveElectronRemote();
    if (!contents?.on || !contents.removeListener || !contents.listeners || !remote?.Menu || !remote.MenuItem) return void 0;
    const MenuCtor = remote.Menu;
    const MenuItemCtor = remote.MenuItem;
    const displacedListeners = contents.listeners("context-menu").slice();
    for (const displaced of displacedListeners) {
      contents.removeListener("context-menu", displaced);
    }
    void contents.executeJavaScript?.(`
      (() => {
        if (window.__ubcLinkContextGuardInstalled) return;
        window.__ubcLinkContextGuardInstalled = true;
        const pendingKey = "__ubcBrowserCorePendingContextSelection";
        let suppressSelectionUntil = 0;
        const linkFor = (target) => target instanceof Element ? target.closest('a[href]') : null;
        const editableFor = (target) => {
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target;
          if (!(target instanceof Element)) return null;
          const editable = target.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
          return editable instanceof HTMLElement && editable.isContentEditable ? editable : null;
        };
        const emitContext = console.debug.bind(console);
        const restorePending = () => {
          const snapshot = window[pendingKey];
          delete window[pendingKey];
          if (!snapshot) return;
          if (snapshot.kind === "input") {
            if (!snapshot.element?.isConnected) return;
            snapshot.element.focus({ preventScroll: true });
            snapshot.element.setSelectionRange(
              snapshot.start,
              snapshot.end,
              snapshot.direction,
            );
            return;
          }
          const selection = window.getSelection();
          if (!selection) return;
          selection.removeAllRanges();
          for (const range of snapshot.ranges || []) selection.addRange(range);
        };
        window.__ubcRestoreBrowserCoreContextSelection = restorePending;
        const scheduleFallbackRestore = () => {
          window.setTimeout(() => {
            if (performance.now() >= suppressSelectionUntil) restorePending();
          }, 1600);
        };
        const beginGuard = (event) => {
          if (event.button !== 2) return;
          if (performance.now() < suppressSelectionUntil) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            return;
          }

          if (linkFor(event.target)) {
            delete window[pendingKey];
            suppressSelectionUntil = performance.now() + 1500;
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            return;
          }

          const editable = editableFor(event.target);
          if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
            if (document.activeElement !== editable) editable.focus({ preventScroll: true });
            const start = editable.selectionStart ?? 0;
            const end = editable.selectionEnd ?? start;
            window[pendingKey] = {
              kind: "input",
              text: editable.value.slice(Math.min(start, end), Math.max(start, end)),
              element: editable,
              start,
              end,
              direction: editable.selectionDirection || "none",
            };
            suppressSelectionUntil = performance.now() + 1500;
            event.preventDefault();
            if (start !== end) {
              editable.setSelectionRange(end, end, editable.selectionDirection || "none");
            }
            scheduleFallbackRestore();
            return;
          }

          if (editable instanceof HTMLElement && editable.isContentEditable) {
            if (document.activeElement !== editable) editable.focus({ preventScroll: true });
            const selection = window.getSelection();
            const ranges = [];
            if (selection) {
              for (let index = 0; index < selection.rangeCount; index += 1) {
                ranges.push(selection.getRangeAt(index).cloneRange());
              }
            }
            window[pendingKey] = {
              kind: "ranges",
              text: selection?.toString() || "",
              ranges,
            };
            suppressSelectionUntil = performance.now() + 1500;
            event.preventDefault();
            selection?.removeAllRanges();
            scheduleFallbackRestore();
            return;
          }

          const selection = window.getSelection();
          const text = selection?.toString() || "";
          if (!selection || selection.rangeCount === 0 || !text.trim()) return;
          const ranges = [];
          for (let index = 0; index < selection.rangeCount; index += 1) {
            ranges.push(selection.getRangeAt(index).cloneRange());
          }
          window[pendingKey] = { kind: "ranges", text, ranges };
          suppressSelectionUntil = performance.now() + 1500;
          event.preventDefault();
          selection.removeAllRanges();
          scheduleFallbackRestore();
        };
        window.addEventListener('pointerdown', beginGuard, true);
        window.addEventListener('mousedown', beginGuard, true);
        window.addEventListener('selectstart', (event) => {
          if (performance.now() > suppressSelectionUntil) return;
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
        }, true);
        window.addEventListener('contextmenu', (event) => {
          if (linkFor(event.target)) {
            suppressSelectionUntil = performance.now() + 250;
            window.getSelection()?.removeAllRanges();
            return;
          }
          const editable = editableFor(event.target);
          if (editable) {
            event.preventDefault();
            const pending = window[pendingKey];
            const selectionText = pending?.text || (
              editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
                ? editable.value.slice(
                    Math.min(editable.selectionStart ?? 0, editable.selectionEnd ?? 0),
                    Math.max(editable.selectionStart ?? 0, editable.selectionEnd ?? 0),
                  )
                : window.getSelection()?.toString() || ""
            );
            const readOnly = editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
              ? editable.readOnly || editable.disabled
              : false;
            const hasSelection = Boolean(selectionText);
            const canCommand = (command) => {
              try {
                return document.queryCommandEnabled(command);
              } catch {
                return false;
              }
            };
            emitContext("__UBC_EDITABLE_CONTEXT__" + JSON.stringify({
              x: event.clientX,
              y: event.clientY,
              pageURL: location.href,
              mediaType: "none",
              isEditable: true,
              selectionText,
              editFlags: {
                canUndo: canCommand("undo"),
                canRedo: canCommand("redo"),
                canCut: hasSelection && !readOnly,
                canCopy: hasSelection,
                canPaste: !readOnly,
                canDelete: hasSelection && !readOnly,
                canSelectAll: true,
              },
            }));
            return;
          }
          if (performance.now() < suppressSelectionUntil) {
            window.getSelection()?.removeAllRanges();
          }
        }, true);
      })();
    `, false).catch(() => void 0);
    let activeMenu;
    const restorePendingSelection = () => {
      if (!contents.executeJavaScript) return;
      window.setTimeout(() => {
        void contents.executeJavaScript?.(
          "window.__ubcRestoreBrowserCoreContextSelection?.();",
          false
        ).catch(() => void 0);
      }, 0);
    };
    const popupFor = (params) => {
      const entries = buildEntries(params);
      if (!entries.length) {
        restorePendingSelection();
        return;
      }
      const menu = new MenuCtor();
      activeMenu = menu;
      for (const entry of entries) {
        if (entry.kind === "separator") {
          menu.append(new MenuItemCtor({ type: "separator" }));
          continue;
        }
        menu.append(new MenuItemCtor({
          label: entry.title,
          enabled: entry.disabled !== true,
          click: entry.action
        }));
      }
      menu.popup(contents);
      restorePendingSelection();
    };
    const consoleListener = (_event, _level, message) => {
      if (!message.startsWith(EDITABLE_CONTEXT_MARKER)) return;
      try {
        const params = JSON.parse(message.slice(EDITABLE_CONTEXT_MARKER.length));
        popupFor(params);
      } catch {
        restorePendingSelection();
      }
    };
    const listener = (event, params) => {
      event.preventDefault?.();
      if (params.linkURL?.trim()) {
        popupFor(params.selectionText?.trim() ? { ...params, selectionText: "" } : params);
        return;
      }
      if (!contents.executeJavaScript) {
        popupFor(params);
        return;
      }
      void contents.executeJavaScript(
        "window.__ubcBrowserCorePendingContextSelection?.text || '';",
        false
      ).then((pending) => {
        const pendingText = typeof pending === "string" ? pending : "";
        popupFor(pendingText ? { ...params, selectionText: pendingText } : params);
      }, () => popupFor(params));
    };
    contents.on("console-message", consoleListener);
    contents.on("context-menu", listener);
    return () => {
      contents.removeListener?.("console-message", consoleListener);
      contents.removeListener?.("context-menu", listener);
      activeMenu = void 0;
      for (const displaced of displacedListeners) {
        contents.on?.("context-menu", displaced);
      }
    };
  }
};

// src/adapters/managed-webview-backend.ts
var ManagedWebviewBackend = class {
  liveGuests = /* @__PURE__ */ new Set();
  policySessions = /* @__PURE__ */ new Map();
  settings;
  create(partition, settings, doc = document) {
    this.settings = settings ?? this.settings;
    this.bindPolicy(partition);
    const webview = doc.createElement("webview");
    webview.addClass("ubc-webview");
    webview.partition = partition;
    webview.setAttribute("allowpopups", "");
    webview.setAttribute(
      "webpreferences",
      `contextIsolation=yes,nodeIntegration=no,sandbox=yes,autoplayPolicy=${settings?.().autoplayPolicy === "allow" ? "no-user-gesture-required" : "document-user-activation-required"}`
    );
    this.liveGuests.add(webview);
    return webview;
  }
  destroy(webview) {
    this.liveGuests.delete(webview);
    try {
      webview.stop?.();
    } catch {
    }
    webview.remove();
  }
  bindPolicy(partition) {
    if (this.policySessions.has(partition)) return;
    const session = resolvePartitionSession(partition);
    if (!session?.webRequest?.onHeadersReceived) return;
    session.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      const ownGuest = [...this.liveGuests].some((guest) => {
        try {
          return guest.getWebContentsId?.() === details.webContentsId;
        } catch {
          return false;
        }
      });
      const headers = { ...details.responseHeaders };
      if (ownGuest && this.settings?.().blockPasskeyRequests && ["mainFrame", "subFrame"].includes(details.resourceType)) {
        const key = Object.keys(headers).find((name) => name.toLowerCase() === "permissions-policy");
        const existing = key ? headers[key]?.join(", ") ?? "" : "";
        const rest = existing.split(/,(?![^()]*\))/).filter((part) => !/^\s*publickey-credentials-(get|create)\s*=/.test(part));
        if (key) delete headers[key];
        headers["Permissions-Policy"] = [[...rest.filter(Boolean), "publickey-credentials-get=()", "publickey-credentials-create=()"].join(", ")];
      }
      callback({ responseHeaders: headers });
    });
    this.policySessions.set(partition, session);
  }
  dispose() {
    for (const session of this.policySessions.values()) session.webRequest?.onHeadersReceived(null);
    this.policySessions.clear();
    for (const webview of [...this.liveGuests]) this.destroy(webview);
  }
  activeGuestCount() {
    return this.liveGuests.size;
  }
};

// src/adapters/obsidian-tab-strip.ts
var ObsidianTabStripAdapter = class {
  dragging = false;
  pendingStrips = /* @__PURE__ */ new Set();
  scheduleStripStyle(strip) {
    if (this.pendingStrips.has(strip)) return;
    this.pendingStrips.add(strip);
    strip.ownerDocument.defaultView?.requestAnimationFrame(() => {
      this.pendingStrips.delete(strip);
      if (strip.isConnected) this.refreshStripStyle(strip);
    });
  }
  leavesInSameGroup(leaf) {
    const parent = leaf.parent;
    return Array.isArray(parent.children) ? parent.children.filter(Boolean) : [leaf];
  }
  bind(plugin, shouldHandle, onContextMenu) {
    let source;
    let sourceStrip;
    let marker;
    let insertion = 0;
    const overStrip = (event) => {
      if (!sourceStrip) return false;
      const rect = sourceStrip.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    const clear = () => {
      marker?.removeClass("ubc-drop-before", "ubc-drop-after");
      if (source) this.tabHeader(source)?.removeClass("ubc-tab-dragging");
      source = void 0;
      sourceStrip = void 0;
      marker = void 0;
      this.dragging = false;
    };
    plugin.register(clear);
    plugin.registerDomEvent(document, "dragstart", (event) => {
      const target = event.target;
      const header = target.closest?.(".workspace-tab-header.ubc-browser-tab");
      const strip = header?.parentElement;
      if (!header || !strip?.querySelector(".workspace-tab-header.ubc-browser-tab") || event.altKey) return;
      let leaf;
      plugin.app.workspace.iterateAllLeaves((candidate) => {
        if (this.tabHeader(candidate) === header) leaf = candidate;
      });
      const group = leaf?.parent;
      if (!leaf || this.leavesInSameGroup(leaf).length < 2 || typeof group?.updateTabDisplay !== "function") return;
      clear();
      source = leaf;
      sourceStrip = strip;
      insertion = this.leavesInSameGroup(leaf).indexOf(leaf);
      this.dragging = true;
      header.addClass("ubc-tab-dragging");
    }, true);
    plugin.registerDomEvent(document, "dragover", (event) => {
      if (!source || !sourceStrip || !overStrip(event)) {
        marker?.removeClass("ubc-drop-before", "ubc-drop-after");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const others = this.leavesInSameGroup(source).filter((leaf) => leaf !== source);
      insertion = others.findIndex((leaf) => {
        const rect2 = this.tabHeader(leaf)?.getBoundingClientRect();
        return rect2 ? event.clientX < rect2.left + rect2.width / 2 : false;
      });
      if (insertion < 0) insertion = others.length;
      marker?.removeClass("ubc-drop-before", "ubc-drop-after");
      marker = others.length ? this.tabHeader(others[Math.min(insertion, others.length - 1)]) : void 0;
      marker?.addClass(insertion === others.length ? "ubc-drop-after" : "ubc-drop-before");
      const rect = sourceStrip.getBoundingClientRect();
      if (event.clientX < rect.left + 24) sourceStrip.scrollLeft -= 16;
      else if (event.clientX > rect.right - 24) sourceStrip.scrollLeft += 16;
    }, true);
    plugin.registerDomEvent(document, "drop", (event) => {
      if (!source || !sourceStrip || !overStrip(event)) {
        clear();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const leaf = source;
      const group = leaf.parent;
      const selected = group.children[group.currentTab];
      const oldIndex = group.children.indexOf(leaf);
      try {
        if (oldIndex >= 0 && oldIndex !== insertion && group.children.length > 1) {
          group.children.splice(oldIndex, 1);
          group.children.splice(insertion, 0, leaf);
          group.currentTab = selected ? group.children.indexOf(selected) : insertion;
          group.updateTabDisplay();
        }
      } finally {
        clear();
      }
      plugin.app.workspace.requestSaveLayout();
      plugin.app.workspace.trigger("layout-change");
    }, true);
    plugin.registerDomEvent(document, "dragend", clear, true);
    plugin.registerDomEvent(document, "contextmenu", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const strip = target.closest(".workspace-tab-header-container-inner");
      if (!strip || target.closest(".workspace-tab-header")) return;
      if (!shouldHandle(strip)) return;
      event.preventDefault();
      onContextMenu(event);
    });
  }
  applyLeafStyle(leaf, policy, enabled, pinned, containerColor) {
    if (!enabled) {
      this.clearLeafStyle(leaf);
      return;
    }
    const header = this.tabHeader(leaf);
    if (!header) return;
    header.addClass("ubc-browser-tab");
    header.toggleClass("ubc-browser-tab-pinned", pinned);
    header.toggleClass("ubc-browser-tab-title-adaptive", policy.titleVisibility === "adaptive");
    header.toggleClass("ubc-browser-tab-favicon-priority", policy.faviconPriority);
    header.style.setProperty("--ubc-tab-preferred", `${policy.preferredWidth}px`);
    header.style.setProperty("--ubc-tab-min", `${policy.minimumWidth}px`);
    header.style.setProperty("--ubc-tab-max", `${policy.maximumWidth}px`);
    header.style.setProperty("--ubc-tab-grow", String(policy.flexGrow));
    header.style.setProperty("--ubc-tab-shrink", String(policy.flexShrink));
    header.style.setProperty("--ubc-pinned-tab-width", `${policy.pinnedWidth}px`);
    header.dataset.ubcTabOverflow = policy.overflow;
    if (containerColor) header.style.setProperty("--ubc-tab-container-color", containerColor);
    else header.style.removeProperty("--ubc-tab-container-color");
    const strip = header.parentElement;
    if (!(strip instanceof HTMLElement)) return;
    this.scheduleStripStyle(strip);
  }
  clearLeafStyle(leaf) {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const strip = header.parentElement;
    header.removeClass(
      "ubc-browser-tab",
      "ubc-browser-tab-pending",
      "ubc-browser-tab-layout",
      "ubc-browser-tab-pinned",
      "ubc-browser-tab-title-adaptive",
      "ubc-browser-tab-favicon-priority"
    );
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width"
    ]) header.style.removeProperty(variable);
    delete header.dataset.ubcTabOverflow;
    header.style.removeProperty("--ubc-tab-container-color");
    this.applyLeafFavicon(leaf);
    if (!(strip instanceof HTMLElement)) return;
    this.scheduleStripStyle(strip);
  }
  refreshLeafHeader(leaf, activeInWindow = false, savedTitle) {
    const compatLeaf = leaf;
    const title = savedTitle || leaf.view.getDisplayText();
    const viewCompat = leaf.view;
    const viewTitleEl = viewCompat.titleEl ?? leaf.view.containerEl.querySelector(".view-header-title");
    if (viewTitleEl && viewTitleEl.innerText !== title) viewTitleEl.innerText = title;
    compatLeaf.updateHeader?.();
    if (compatLeaf.tabHeaderInnerTitleEl && compatLeaf.tabHeaderInnerTitleEl.innerText !== title) {
      compatLeaf.tabHeaderInnerTitleEl.innerText = title;
    }
    this.tabHeader(leaf)?.setAttribute("aria-label", title);
    this.tabHeader(leaf)?.setAttribute("title", title);
    if (activeInWindow) {
      const doc = leaf.getContainer().doc;
      const separator = doc.title.indexOf(" - ");
      doc.title = separator >= 0 ? title + doc.title.slice(separator) : title;
    }
  }
  applyLeafFavicon(leaf, dataUrl) {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const icon = header.querySelector(".workspace-tab-header-inner-icon");
    if (!icon) return;
    icon.querySelector(".ubc-tab-favicon")?.remove();
    header.toggleClass("ubc-browser-tab-has-favicon", Boolean(dataUrl));
    if (!dataUrl) return;
    const image = document.createElement("img");
    image.className = "ubc-tab-favicon";
    image.alt = "";
    image.src = dataUrl;
    icon.appendChild(image);
  }
  revealActiveTab(leaf) {
    const header = this.tabHeader(leaf);
    const strip = header?.parentElement;
    if (!header || !(strip instanceof HTMLElement) || !strip.hasClass("ubc-browser-tab-strip-scroll")) return;
    window.requestAnimationFrame(() => {
      if (!header.isConnected || !strip.isConnected || !header.hasClass("is-active")) return;
      const headerRect = header.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      if (headerRect.left < stripRect.left) strip.scrollLeft += headerRect.left - stripRect.left;
      else if (headerRect.right > stripRect.right) strip.scrollLeft += headerRect.right - stripRect.right;
    });
  }
  refreshAllStrips(workspace) {
    const strips = /* @__PURE__ */ new Set();
    workspace.iterateAllLeaves((leaf) => {
      const strip = this.tabHeader(leaf)?.parentElement;
      if (strip instanceof HTMLElement) strips.add(strip);
    });
    for (const strip of strips) this.refreshStripStyle(strip);
  }
  tabHeader(leaf) {
    return leaf.tabHeaderEl;
  }
  refreshStripStyle(strip) {
    strip.removeClass(
      "ubc-browser-tab-strip",
      "ubc-browser-tab-strip-scroll",
      "ubc-browser-tab-strip-compress"
    );
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width"
    ]) strip.style.removeProperty(variable);
    const headers = [...strip.querySelectorAll(".workspace-tab-header")];
    for (const header of headers) header.removeClass("ubc-browser-tab-layout");
    const browserHeaders = headers.filter((header) => header.hasClass("ubc-browser-tab"));
    if (!headers.length || !browserHeaders.length || browserHeaders.length !== headers.length) return;
    const overflowModes = new Set(browserHeaders.map((header) => header.dataset.ubcTabOverflow).filter(Boolean));
    if (overflowModes.size !== 1) return;
    const mode = [...overflowModes][0];
    const source = browserHeaders[0];
    if (!source) return;
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width"
    ]) {
      const value = source.style.getPropertyValue(variable);
      if (value) strip.style.setProperty(variable, value);
    }
    for (const header of browserHeaders) header.addClass("ubc-browser-tab-layout");
    strip.addClass("ubc-browser-tab-strip");
    strip.addClass(mode === "horizontal-scroll" ? "ubc-browser-tab-strip-scroll" : "ubc-browser-tab-strip-compress");
  }
};

// src/adapters/obsidian-settings.ts
var ObsidianSettingsAdapter = class {
  openPluginSettings(app, pluginId) {
    const host = app.setting;
    if (!host?.open) return false;
    host.open();
    host.openTabById?.(pluginId);
    return true;
  }
};

// src/adapters/obsidian-home.ts
var import_obsidian = require("obsidian");
var ObsidianHomeAdapter = class {
  constructor(app) {
    this.app = app;
  }
  searchFiles(query, limit = 8) {
    const needle = query.trim();
    if (!needle) return [];
    const normalizedNeedle = needle.toLocaleLowerCase();
    const fuzzy = (0, import_obsidian.prepareFuzzySearch)(needle);
    const nameMatches = [];
    const pathMatches = [];
    for (const file of this.app.vault.getFiles()) {
      const fileNameMatches = [];
      const basenameMatch = fuzzy(file.basename);
      if (basenameMatch) fileNameMatches.push({ file, match: basenameMatch });
      if (file.extension === "md") {
        const aliases = (0, import_obsidian.parseFrontMatterAliases)(this.app.metadataCache.getFileCache(file)?.frontmatter ?? null) ?? [];
        for (const alias of aliases) {
          const aliasMatch = fuzzy(alias);
          if (aliasMatch) fileNameMatches.push({ file, match: aliasMatch, matchedAlias: alias });
        }
      }
      if (fileNameMatches.length) {
        (0, import_obsidian.sortSearchResults)(fileNameMatches);
        nameMatches.push(fileNameMatches[0]);
        continue;
      }
      if (!file.path.toLocaleLowerCase().includes(normalizedNeedle)) continue;
      const pathMatch = fuzzy(file.path);
      if (pathMatch) pathMatches.push({ file, match: pathMatch });
    }
    (0, import_obsidian.sortSearchResults)(nameMatches);
    (0, import_obsidian.sortSearchResults)(pathMatches);
    return [...nameMatches, ...pathMatches].slice(0, limit).map(({ file, matchedAlias }) => ({
      ...toHomeFile(file),
      matchedAlias
    }));
  }
  recentFiles(limit = 6) {
    return this.app.workspace.getLastOpenFiles().flatMap((path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof import_obsidian.TFile ? [toHomeFile(file)] : [];
    }).slice(0, limit);
  }
  bookmarkedFiles(limit = 8) {
    const internal = this.app.internalPlugins;
    const plugin = internal?.getPluginById?.("bookmarks");
    const items = plugin?.instance?.getBookmarks?.() ?? plugin?.instance?.items ?? [];
    return flattenBookmarkItems(items).flatMap((item) => {
      if (item.type !== "file" || !item.path) return [];
      const file = this.app.vault.getAbstractFileByPath(item.path);
      return file instanceof import_obsidian.TFile ? [toHomeFile(file)] : [];
    }).slice(0, limit);
  }
  async openFile(leaf, path, newTab = false) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian.TFile)) return false;
    const target = newTab ? this.app.workspace.getLeaf("tab") : leaf;
    await target.openFile(file);
    if (newTab) await this.app.workspace.revealLeaf(target);
    return true;
  }
};
function flattenBookmarkItems(items) {
  const result = [];
  const visit = (item) => {
    result.push(item);
    for (const child of item.items ?? item.children ?? []) visit(child);
  };
  for (const item of items) visit(item);
  return result;
}
function toHomeFile(file) {
  return {
    path: file.path,
    name: file.basename || file.name,
    extension: file.extension
  };
}

// src/adapters/obsidian-bookmarks.ts
var ObsidianBookmarksAdapter = class {
  constructor(app) {
    this.app = app;
  }
  async scan() {
    const runtimeItems = this.runtimeItems();
    if (runtimeItems) return normalizeObsidianBookmarkItems(runtimeItems, "runtime");
    const fileItems = await this.fileItems();
    if (fileItems) return normalizeObsidianBookmarkItems(fileItems, "bookmarks-json");
    return { available: false, source: "none", entries: [], skippedNonWeb: 0 };
  }
  runtimeItems() {
    const internal = this.app.internalPlugins;
    const plugin = internal?.getPluginById?.("bookmarks") ?? internal?.plugins?.bookmarks;
    if (!plugin?.instance) return void 0;
    const items = plugin.instance.getBookmarks?.() ?? plugin.instance.items;
    return Array.isArray(items) ? items : void 0;
  }
  async fileItems() {
    const vault = this.app.vault;
    const configDir = vault.configDir || ".obsidian";
    const path = `${configDir}/bookmarks.json`;
    try {
      if (!await vault.adapter.exists(path)) return void 0;
      const raw = JSON.parse(await vault.adapter.read(path));
      const items = Array.isArray(raw) ? raw : raw?.items;
      return Array.isArray(items) ? items : void 0;
    } catch {
      return void 0;
    }
  }
};
function normalizeObsidianBookmarkItems(items, source = "runtime") {
  const entries = [];
  let skippedNonWeb = 0;
  const visit = (item, folderPath) => {
    const type = item.type?.toLowerCase();
    if (type === "group") {
      const nextPath = item.title?.trim() ? [...folderPath, item.title.trim()] : folderPath;
      for (const child of item.items ?? item.children ?? []) visit(child, nextPath);
      return;
    }
    const candidate = type === "url" || type === "link" ? item.url ?? item.path : void 0;
    if (candidate && isWebUrl(candidate)) {
      entries.push({
        title: item.title?.trim() || candidate,
        url: candidate.trim(),
        folderPath
      });
      return;
    }
    skippedNonWeb += 1;
  };
  for (const item of items) visit(item, []);
  return { available: true, source, entries, skippedNonWeb };
}
function isWebUrl(value) {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// src/adapters/webviewer-bookmarks.ts
var WebViewerBookmarksAdapter = class {
  constructor(app) {
    this.app = app;
  }
  async scan() {
    const vault = this.app.vault;
    const path = `${vault.configDir || ".obsidian"}/plugins/webviewer-bookmarks/data.json`;
    try {
      if (!await vault.adapter.exists(path)) return unavailable();
      return normalizeWebViewerBookmarks(JSON.parse(await vault.adapter.read(path)));
    } catch {
      return unavailable();
    }
  }
};
function normalizeWebViewerBookmarks(data) {
  if (!data || typeof data !== "object" || !("bookmarks" in data) || !Array.isArray(data.bookmarks)) {
    return unavailable();
  }
  const entries = [];
  let skippedInvalid = 0;
  for (const item of data.bookmarks) {
    if (!item || typeof item !== "object" || typeof item.url !== "string") {
      skippedInvalid++;
      continue;
    }
    const url = item.url.trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      skippedInvalid++;
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      skippedInvalid++;
      continue;
    }
    entries.push({
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : parsed.hostname,
      url,
      folderPath: [],
      favorite: item.ribbon === true,
      visualKind: "icon",
      visualValue: typeof item.lucide === "string" && item.lucide.trim() ? item.lucide.trim() : "bookmark"
    });
  }
  return { available: true, entries, skippedInvalid };
}
function unavailable() {
  return { available: false, entries: [], skippedInvalid: 0 };
}

// src/adapters/surfing-migration.ts
var SurfingMigrationAdapter = class {
  constructor(app) {
    this.app = app;
  }
  async scan() {
    const vault = this.app.vault;
    const configDir = vault.configDir || ".obsidian";
    const appId = this.app.appId;
    if (!appId) throw new Error("Obsidian did not expose a vault app ID, so the Surfing profile cannot be identified safely.");
    const settingsPath = `${configDir}/plugins/surfing/data.json`;
    const bookmarksPath = `${configDir}/surfing-bookmark.json`;
    const warnings = [];
    const settingsResult = await this.readJson(settingsPath, warnings);
    const bookmarksResult = await this.readJson(bookmarksPath, warnings);
    const settings = isRecord(settingsResult.data) ? settingsResult.data : null;
    if (settingsResult.found && !settings) warnings.push("Surfing settings have an unsupported format.");
    const parsedBookmarks = normalizeSurfingBookmarks(bookmarksResult.data);
    if (bookmarksResult.found && !parsedBookmarks.valid) warnings.push("Surfing bookmarks have an unsupported format.");
    if (parsedBookmarks.invalid) warnings.push(`${parsedBookmarks.invalid} invalid Surfing bookmark(s) cannot be opened; their source records are preserved in the backup.`);
    const liveLeaves = this.app.workspace.getLeavesOfType("surfing-view");
    const liveTabs = liveLeaves.map((leaf) => tabFromLeaf(leaf, this.app.workspace.activeLeaf)).filter((tab) => Boolean(tab));
    const savedTabs = liveTabs.length ? [] : await this.savedWorkspaceTabs(`${configDir}/workspace.json`, warnings);
    const tabs = liveTabs.length ? liveTabs : savedTabs;
    const invalidTabs = liveLeaves.length > 0 ? liveLeaves.length - liveTabs.length : 0;
    if (invalidTabs) warnings.push(`${invalidTabs} Surfing tab(s) have URLs Browser Core cannot open; the source layout is left untouched.`);
    return {
      sourcePartition: `persist:surfing-vault-${appId}`,
      settingsPath,
      bookmarksPath,
      settings,
      bookmarksRaw: bookmarksResult.data,
      bookmarks: parsedBookmarks.entries,
      folderPaths: surfingFolderPaths(bookmarksResult.data),
      tabs,
      invalidBookmarks: parsedBookmarks.invalid,
      invalidTabs,
      warnings,
      settingsFound: settingsResult.found,
      bookmarksFound: bookmarksResult.found,
      bookmarksValid: parsedBookmarks.valid,
      tabsSource: liveTabs.length ? "live" : savedTabs.length ? "workspace" : "none"
    };
  }
  async readJson(path, warnings) {
    if (!await this.app.vault.adapter.exists(path)) return { found: false, data: null };
    try {
      return { found: true, data: JSON.parse(await this.app.vault.adapter.read(path)) };
    } catch {
      warnings.push(`Could not read ${path}.`);
      return { found: true, data: null };
    }
  }
  async savedWorkspaceTabs(path, warnings) {
    if (!await this.app.vault.adapter.exists(path)) return [];
    try {
      const root = JSON.parse(await this.app.vault.adapter.read(path));
      const tabs = [];
      const visit = (value) => {
        if (!isRecord(value)) {
          if (Array.isArray(value)) for (const child of value) visit(child);
          return;
        }
        if (value.type === "leaf" && isRecord(value.state) && value.state.type === "surfing-view" && isRecord(value.state.state) && isWebUrl2(value.state.state.url)) {
          tabs.push({
            sourceKey: `workspace-${tabs.length}`,
            url: value.state.state.url,
            pinned: value.pinned === true || value.state.pinned === true,
            active: false,
            history: [{ kind: "web", url: value.state.state.url }],
            historyIndex: 0
          });
          return;
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(root);
      return tabs;
    } catch {
      warnings.push(`Could not read saved Surfing tabs from ${path}.`);
      return [];
    }
  }
};
function normalizeSurfingBookmarks(data) {
  if (!isRecord(data) || !Array.isArray(data.bookmarks)) return { valid: false, entries: [], invalid: 0 };
  const entries = [];
  let invalid = 0;
  for (const raw of data.bookmarks) {
    if (!isRecord(raw) || !isWebUrl2(raw.url)) {
      invalid++;
      continue;
    }
    const folderPath = Array.isArray(raw.category) ? raw.category.filter((part) => typeof part === "string").map((part) => part.trim()).filter((part) => part.length > 0 && part.toUpperCase() !== "ROOT") : [];
    entries.push({
      title: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.url,
      url: raw.url,
      folderPath,
      favorite: folderPath.length === 0,
      description: typeof raw.description === "string" ? raw.description : void 0,
      tags: typeof raw.tags === "string" ? raw.tags.split(/\s+/).filter(Boolean) : void 0,
      createdAt: typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created : void 0
    });
  }
  return { valid: true, entries, invalid };
}
function surfingFolderPaths(data) {
  if (!isRecord(data) || !Array.isArray(data.categories)) return [];
  const paths = [];
  const visit = (category, parent) => {
    if (!isRecord(category)) return;
    const name = typeof category.text === "string" && category.text.trim() ? category.text.trim() : typeof category.value === "string" ? category.value.trim() : "";
    const path = name && name.toUpperCase() !== "ROOT" ? [...parent, name] : parent;
    if (path.length) paths.push(path);
    if (Array.isArray(category.children)) for (const child of category.children) visit(child, path);
  };
  for (const category of data.categories) visit(category, []);
  return paths;
}
function surfingSearchTemplate(settings) {
  if (!settings || typeof settings.defaultSearchEngine !== "string") return void 0;
  const selected = settings.defaultSearchEngine.toLowerCase();
  const custom = Array.isArray(settings.customSearchEngine) ? settings.customSearchEngine.find((entry) => isRecord(entry) && typeof entry.name === "string" && entry.name.toLowerCase() === selected && typeof entry.url === "string") : void 0;
  const builtIn = {
    google: "https://www.google.com/search?q=",
    bing: "https://www.bing.com/search?q=",
    duckduckgo: "https://duckduckgo.com/?q=",
    yahoo: "https://search.yahoo.com/search?p=",
    baidu: "https://www.baidu.com/s?wd=",
    yandex: "https://yandex.com/search/?text=",
    wikipedia: "https://en.wikipedia.org/w/index.php?search="
  };
  const raw = custom?.url ?? builtIn[selected];
  if (typeof raw !== "string" || !isWebUrl2(raw)) return void 0;
  if (raw.includes("{query}")) return raw;
  if (raw.includes("%s")) return raw.replace("%s", "{query}");
  return raw + "{query}";
}
function tabFromLeaf(leaf, activeLeaf) {
  const viewState = leaf.getViewState();
  const state = isRecord(viewState.state) ? viewState.state : null;
  if (!state || !isWebUrl2(state.url)) return null;
  const history = leaf.history;
  const previous = (history?.backHistory ?? []).map(historyUrl).filter((url) => Boolean(url));
  const forward = (history?.forwardHistory ?? []).map(historyUrl).filter((url) => Boolean(url)).reverse();
  const entries = [...previous, state.url, ...forward].map((url) => ({ kind: "web", url }));
  const guestHistory = historyFromSurfingGuest(leaf, state.url);
  return {
    sourceKey: leaf.id ?? `live-${state.url}`,
    url: state.url,
    title: leaf.view.getDisplayText(),
    pinned: Boolean(leaf.pinned),
    active: leaf === activeLeaf,
    history: guestHistory?.entries ?? entries,
    historyIndex: guestHistory?.index ?? previous.length
  };
}
function historyFromSurfingGuest(leaf, currentUrl) {
  const webview = leaf.view.webviewEl;
  if (!webview) return null;
  const guest = resolveGuestWebContents(webview);
  const navigation = guest?.navigationHistory;
  if (!navigation?.getAllEntries) return null;
  try {
    const raw = navigation.getAllEntries();
    const rawIndex = navigation.getActiveIndex?.() ?? raw.length - 1;
    const entries = [];
    let index = 0;
    for (let position = 0; position < raw.length; position++) {
      const entry = raw[position];
      if (!isWebUrl2(entry?.url)) continue;
      if (position <= rawIndex) index = entries.length;
      entries.push({ kind: "web", url: entry.url, title: entry.title });
    }
    if (!entries.length) return null;
    if (entries[index]?.url !== currentUrl) {
      entries.push({ kind: "web", url: currentUrl });
      index = entries.length - 1;
    }
    return { entries, index };
  } catch {
    return null;
  }
}
function historyUrl(value) {
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.state.state)) return null;
  return isWebUrl2(value.state.state.url) ? value.state.state.url : null;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isWebUrl2(value) {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

// src/adapters/obsidian-commands.ts
var ObsidianCommandAdapter = class {
  has(app, id) {
    const host = app.commands;
    return Boolean(host?.commands && id in host.commands);
  }
  execute(app, id) {
    const host = app.commands;
    if (!host?.executeCommandById) return false;
    const result = host.executeCommandById(id);
    return result !== false;
  }
  openQuickSwitcher(app) {
    return this.execute(app, "switcher:open");
  }
};

// src/api/browser-api.ts
var BrowserPublicApi = class {
  constructor(host, events) {
    this.host = host;
    this.events = events;
  }
  apiVersion = 5;
  open(url, options) {
    return this.host.open(url, options);
  }
  search(query, options) {
    return this.host.search(query, options);
  }
  tabs() {
    return this.host.tabs().map((tab) => ({ ...tab }));
  }
  activateTab(id) {
    return this.host.activateTab(id);
  }
  closeTab(id) {
    return this.host.closeTab(id);
  }
  containers() {
    return this.host.containers().map((container) => ({ ...container }));
  }
  capabilities() {
    return { ...this.host.capabilities() };
  }
  bookmarks(query) {
    return this.host.bookmarks(query).map((entry) => ({ ...entry }));
  }
  addBookmark(input) {
    return { ...this.host.addBookmark(input) };
  }
  history(query) {
    return this.host.history(query).map((entry) => ({ ...entry }));
  }
  restoreHistoryEntry(id, options) {
    return this.host.restoreHistoryEntry(id, options);
  }
  on(event, callback) {
    if (event === "tab-opened") {
      return this.events.on("leaf-opened", (payload) => callback(mapLeaf(payload)));
    }
    if (event === "tab-closed") {
      return this.events.on("leaf-closed", (payload) => callback(mapLeaf(payload)));
    }
    if (event === "navigation-committed") {
      return this.events.on("navigation-committed", (payload) => callback(mapNavigation(payload)));
    }
    return this.events.on("bookmark-changed", (payload) => callback(mapBookmarkChange(payload)));
  }
};
function mapLeaf(record) {
  return {
    id: record.id,
    title: record.lastTitle || "Tab",
    url: record.lastUrl || "browser://home",
    containerId: record.containerId,
    pinned: record.pinned,
    closedAt: record.closedAt,
    closeReason: record.closeReason
  };
}
function mapNavigation(node) {
  return {
    id: node.id,
    tabId: node.leafId,
    containerId: node.containerId,
    timestamp: node.timestamp,
    title: node.title,
    url: node.url
  };
}
function mapBookmarkChange(event) {
  return {
    action: event.action,
    kind: event.kind,
    id: event.id
  };
}

// src/core/id.ts
function createId(prefix) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
function safePartitionPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "container";
}

// src/bookmarks/bookmark-store.ts
var BookmarkStore = class {
  constructor(state, onChanged = () => void 0) {
    this.state = state;
    this.onChanged = onChanged;
  }
  addBookmark(input) {
    const existing = this.findByUrl(input.url);
    if (existing) {
      let changed = false;
      if (!existing.faviconUrl && input.faviconUrl) {
        existing.faviconUrl = input.faviconUrl;
        changed = true;
      }
      if (input.favorite === true && !existing.favorite) {
        existing.favorite = true;
        existing.favoriteOrder = this.nextFavoriteOrder();
        changed = true;
      }
      if (!existing.description && input.description) {
        existing.description = input.description;
        changed = true;
      }
      if ((!existing.tags || existing.tags.length === 0) && input.tags?.length) {
        existing.tags = [...input.tags];
        changed = true;
      }
      if (changed) this.onChanged({ action: "updated", kind: "bookmark", id: existing.id, entry: existing });
      return existing;
    }
    const siblings = this.children(input.parentId ?? null);
    const bookmark = {
      id: createId("bookmark"),
      kind: "bookmark",
      parentId: input.parentId ?? null,
      title: input.title || input.url,
      url: input.url,
      order: siblings.length,
      createdAt: input.createdAt ?? Date.now(),
      description: input.description,
      tags: input.tags ? [...input.tags] : void 0,
      mediaType: input.mediaType,
      favorite: input.favorite ?? false,
      favoriteOrder: input.favorite ? this.nextFavoriteOrder() : void 0,
      visualKind: input.visualKind ?? "favicon",
      visualValue: cleanOptional(input.visualValue),
      faviconUrl: cleanOptional(input.faviconUrl)
    };
    this.state.bookmarks[bookmark.id] = bookmark;
    this.onChanged({ action: "added", kind: "bookmark", id: bookmark.id, entry: bookmark });
    return bookmark;
  }
  addFolder(title, parentId = null) {
    const siblings = this.children(parentId);
    const folder = {
      id: createId("folder"),
      kind: "folder",
      parentId,
      title: title.trim() || "Folder",
      order: siblings.length
    };
    this.state.folders[folder.id] = folder;
    this.onChanged({ action: "added", kind: "folder", id: folder.id, entry: folder });
    return folder;
  }
  importWebBookmarks(entries) {
    let added = 0;
    let reused = 0;
    let foldersCreated = 0;
    for (const entry of entries) {
      const folder = this.ensureFolderPath(entry.folderPath);
      const parentId = folder.parentId;
      foldersCreated += folder.created;
      const existing = this.findByUrl(entry.url);
      if (existing) {
        let changed = false;
        if (!existing.description && entry.description) {
          existing.description = entry.description;
          changed = true;
        }
        if ((!existing.tags || existing.tags.length === 0) && entry.tags?.length) {
          existing.tags = [...entry.tags];
          changed = true;
        }
        if (changed) this.onChanged({ action: "updated", kind: "bookmark", id: existing.id, entry: existing });
        reused += 1;
        continue;
      }
      this.addBookmark({
        title: entry.title,
        url: entry.url,
        parentId,
        favorite: entry.favorite,
        visualKind: entry.visualKind,
        visualValue: entry.visualValue,
        description: entry.description,
        tags: entry.tags,
        createdAt: entry.createdAt
      });
      added += 1;
    }
    return { added, reused, foldersCreated };
  }
  ensureFolderPath(path) {
    let parentId = null;
    let created = 0;
    for (const rawTitle of path) {
      const title = rawTitle.trim();
      if (!title) continue;
      const existing = this.children(parentId).find(
        (child) => child.kind === "folder" && child.title === title
      );
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const folder = this.addFolder(title, parentId);
      parentId = folder.id;
      created += 1;
    }
    return { parentId, created };
  }
  deleteBookmark(id) {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return;
    delete this.state.bookmarks[id];
    this.onChanged({ action: "deleted", kind: "bookmark", id });
  }
  getBookmark(id) {
    return this.state.bookmarks[id];
  }
  findByUrl(url) {
    const normalized = normalizeBookmarkUrl(url);
    return Object.values(this.state.bookmarks).find((bookmark) => normalizeBookmarkUrl(bookmark.url) === normalized);
  }
  isBookmarked(url) {
    return Boolean(this.findByUrl(url));
  }
  toggleBookmark(input) {
    const existing = this.findByUrl(input.url);
    if (existing) {
      this.deleteBookmark(existing.id);
      return { bookmarked: false };
    }
    return { bookmarked: true, bookmark: this.addBookmark(input) };
  }
  setFavorite(id, favorite) {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark || bookmark.favorite === favorite) return Boolean(bookmark);
    bookmark.favorite = favorite;
    if (favorite) bookmark.favoriteOrder = this.nextFavoriteOrder();
    else bookmark.favoriteOrder = void 0;
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }
  favorites() {
    return Object.values(this.state.bookmarks).filter((bookmark) => bookmark.favorite).sort((a, b) => (a.favoriteOrder ?? Number.MAX_SAFE_INTEGER) - (b.favoriteOrder ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
  }
  getFolder(id) {
    return this.state.folders[id];
  }
  renameBookmark(id, title) {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return false;
    bookmark.title = title.trim() || bookmark.url;
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }
  updateBookmark(id, patch) {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark) return false;
    const previousUrl = bookmark.url;
    if (patch.url !== void 0) bookmark.url = patch.url.trim() || bookmark.url;
    if (bookmark.url !== previousUrl && patch.faviconUrl === void 0) bookmark.faviconUrl = void 0;
    if (patch.title !== void 0) bookmark.title = patch.title.trim() || bookmark.url;
    if (patch.description !== void 0) bookmark.description = patch.description.trim() || void 0;
    if (patch.tags !== void 0) bookmark.tags = [...patch.tags];
    if ("mediaType" in patch) bookmark.mediaType = patch.mediaType;
    if (patch.favorite !== void 0) bookmark.favorite = patch.favorite;
    if (patch.visualKind !== void 0) {
      bookmark.visualKind = patch.visualKind;
      bookmark.visualValue = cleanOptional(patch.visualValue);
    } else if (patch.visualValue !== void 0) {
      bookmark.visualValue = cleanOptional(patch.visualValue);
    }
    if (patch.faviconUrl !== void 0) bookmark.faviconUrl = cleanOptional(patch.faviconUrl);
    this.onChanged({ action: "updated", kind: "bookmark", id, entry: bookmark });
    return true;
  }
  renameFolder(id, title) {
    const folder = this.state.folders[id];
    if (!folder) return false;
    folder.title = title.trim() || "Folder";
    this.onChanged({ action: "updated", kind: "folder", id, entry: folder });
    return true;
  }
  moveBookmark(id, parentId) {
    const bookmark = this.state.bookmarks[id];
    if (!bookmark || parentId && !this.state.folders[parentId]) return false;
    bookmark.parentId = parentId;
    bookmark.order = this.children(parentId).filter((entry) => entry.id !== id).length;
    this.normalizeOrders();
    this.onChanged({ action: "moved", kind: "bookmark", id, entry: bookmark });
    return true;
  }
  moveFolder(id, parentId) {
    const folder = this.state.folders[id];
    if (!folder || !this.canMoveFolder(id, parentId)) return false;
    folder.parentId = parentId;
    folder.order = this.children(parentId).filter((entry) => entry.id !== id).length;
    this.normalizeOrders();
    this.onChanged({ action: "moved", kind: "folder", id, entry: folder });
    return true;
  }
  folders() {
    return Object.values(this.state.folders).sort((a, b) => a.title.localeCompare(b.title));
  }
  folderPath(id) {
    const parts = [];
    let current = this.state.folders[id];
    const seen = /* @__PURE__ */ new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.title);
      current = current.parentId ? this.state.folders[current.parentId] : void 0;
    }
    return parts.join(" / ");
  }
  canMoveFolder(id, parentId) {
    if (!this.state.folders[id] || id === parentId || parentId && !this.state.folders[parentId]) return false;
    return !parentId || !this.isDescendantFolder(parentId, id);
  }
  descendantBookmarks(folderId) {
    const result = [];
    const visit = (parentId) => {
      for (const child of this.children(parentId)) {
        if (child.kind === "bookmark") result.push(child);
        else visit(child.id);
      }
    };
    visit(folderId);
    return result;
  }
  sortChildren(parentId) {
    const children = this.children(parentId).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    children.forEach((entry, index) => {
      entry.order = index;
    });
    this.onChanged({ action: "sorted", kind: "folder", id: parentId ?? "root" });
  }
  deleteFolder(id) {
    for (const child of Object.values(this.state.bookmarks)) {
      if (child.parentId === id) this.deleteBookmark(child.id);
    }
    for (const child of Object.values(this.state.folders)) {
      if (child.parentId === id) this.deleteFolder(child.id);
    }
    if (!this.state.folders[id]) return;
    delete this.state.folders[id];
    this.normalizeOrders();
    this.onChanged({ action: "deleted", kind: "folder", id });
  }
  children(parentId) {
    return [
      ...Object.values(this.state.folders).filter((entry) => entry.parentId === parentId),
      ...Object.values(this.state.bookmarks).filter((entry) => entry.parentId === parentId)
    ].sort((a, b) => a.order - b.order);
  }
  search(query) {
    const needle = query.toLowerCase();
    return Object.values(this.state.bookmarks).filter((bookmark) => [bookmark.title, bookmark.url, bookmark.description ?? "", ...bookmark.tags ?? []].some((value) => value.toLowerCase().includes(needle))).sort((a, b) => b.createdAt - a.createdAt);
  }
  allBookmarks() {
    return Object.values(this.state.bookmarks).sort((a, b) => a.order - b.order);
  }
  isDescendantFolder(candidateId, ancestorId) {
    let current = this.state.folders[candidateId];
    while (current) {
      if (current.parentId === ancestorId) return true;
      current = current.parentId ? this.state.folders[current.parentId] : void 0;
    }
    return false;
  }
  normalizeOrders() {
    const parentIds = /* @__PURE__ */ new Set([null]);
    for (const folder of Object.values(this.state.folders)) parentIds.add(folder.parentId);
    for (const bookmark of Object.values(this.state.bookmarks)) parentIds.add(bookmark.parentId);
    for (const parentId of parentIds) {
      this.children(parentId).forEach((entry, index) => {
        entry.order = index;
      });
    }
  }
  nextFavoriteOrder() {
    return Object.values(this.state.bookmarks).reduce(
      (max, bookmark) => bookmark.favorite ? Math.max(max, bookmark.favoriteOrder ?? -1) : max,
      -1
    ) + 1;
  }
};
function cleanOptional(value) {
  const next = value?.trim();
  return next || void 0;
}
function normalizeBookmarkUrl(url) {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return trimmed;
  }
}

// src/containers/container-store.ts
var ContainerStore = class {
  constructor(containers, rules, partitionScope) {
    this.containers = containers;
    this.rules = rules;
    this.partitionScope = partitionScope;
  }
  ensureDefault() {
    if (!this.containers.default) {
      this.containers.default = {
        id: "default",
        name: "Default",
        partition: `persist:ubc-${safePartitionPart(this.partitionScope)}-default`,
        icon: "box",
        createdAt: Date.now()
      };
    }
    return this.containers.default;
  }
  create(name, color, icon) {
    const id = createId("container");
    const container = {
      id,
      name: name.trim() || "Container",
      partition: `persist:ubc-${safePartitionPart(this.partitionScope)}-${safePartitionPart(id)}`,
      color,
      icon: icon || "box",
      createdAt: Date.now()
    };
    this.containers[id] = container;
    return container;
  }
  remove(id) {
    if (id === "default" || !this.containers[id]) return false;
    delete this.containers[id];
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i]?.containerId === id) this.rules.splice(i, 1);
    }
    return true;
  }
  get(id) {
    return id && this.containers[id] || this.ensureDefault();
  }
  find(id) {
    return id ? this.containers[id] : void 0;
  }
  nameFor(id) {
    if (!id) return this.ensureDefault().name;
    return this.containers[id]?.name ?? "Deleted container";
  }
  list() {
    this.ensureDefault();
    return Object.values(this.containers).sort((a, b) => a.createdAt - b.createdAt);
  }
  assignOrigin(originPattern, containerId) {
    const existing = this.rules.find((rule) => rule.originPattern === originPattern);
    if (existing) {
      existing.containerId = containerId;
      return;
    }
    this.rules.push({ originPattern, containerId });
  }
  unassignOrigin(originPattern) {
    const index = this.rules.findIndex((rule) => rule.originPattern === originPattern);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }
  assignments() {
    return [...this.rules].sort((a, b) => a.originPattern.localeCompare(b.originPattern));
  }
  assignmentForHostname(hostname) {
    return this.rules.filter((rule) => hostname === rule.originPattern || hostname.endsWith(`.${rule.originPattern}`)).sort((a, b) => b.originPattern.length - a.originPattern.length)[0];
  }
  assignmentForUrl(url) {
    try {
      return this.assignmentForHostname(new URL(url).hostname);
    } catch {
      return void 0;
    }
  }
  bypassOriginForExplicitContainer(url, containerId) {
    try {
      const parsed = new URL(url);
      const assignment = this.assignmentForHostname(parsed.hostname);
      if (!assignment || assignment.containerId === containerId) return void 0;
      return parsed.origin;
    } catch {
      return void 0;
    }
  }
  openerBypassOriginForCommittedUrl(url, containerId) {
    try {
      const parsed = new URL(url);
      const assignment = this.assignmentForHostname(parsed.hostname);
      return assignment && assignment.containerId !== containerId ? parsed.origin : void 0;
    } catch {
      return void 0;
    }
  }
  resolveForUrl(url, fallbackId) {
    return this.assignmentForUrl(url)?.containerId ?? fallbackId;
  }
  routingStatus(url, currentContainerId, bypassOrigin, bypassReason) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
      const assignment = this.assignmentForHostname(parsed.hostname);
      const bypassingAssignment = Boolean(
        assignment && assignment.containerId !== currentContainerId && bypassOrigin === parsed.origin
      );
      return {
        hostname: parsed.hostname,
        origin: parsed.origin,
        assignedContainerId: assignment?.containerId,
        bypassingAssignment,
        bypassReason: bypassingAssignment ? bypassReason ?? "explicit" : void 0
      };
    } catch {
      return void 0;
    }
  }
};

// src/history/history-graph.ts
var HistoryGraph = class {
  constructor(state, events) {
    this.state = state;
    this.events = events;
  }
  beginLeaf(input) {
    const existing = this.state.leaves[input.leafId];
    if (existing) {
      existing.closedAt = void 0;
      existing.closeReason = void 0;
      existing.lastActiveAt = Date.now();
      this.events?.emit("leaf-opened", existing);
      return existing;
    }
    const record = {
      id: input.leafId,
      openedAt: Date.now(),
      containerId: input.containerId,
      pinned: input.pinned ?? false,
      manualRetention: input.manualRetention ?? "default",
      restoredFromLeafId: input.restoredFromLeafId,
      lastUrl: input.url,
      lastTitle: input.title,
      lastActiveAt: Date.now()
    };
    this.state.leaves[input.leafId] = record;
    this.events?.emit("leaf-opened", record);
    return record;
  }
  closeLeaf(leafId, reason = "user") {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return;
    leaf.closedAt = Date.now();
    leaf.closeReason = reason;
    leaf.lastActiveAt = leaf.closedAt;
    this.events?.emit("leaf-closed", leaf);
  }
  touchLeaf(leafId, patch) {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return;
    Object.assign(leaf, patch, { lastActiveAt: Date.now() });
  }
  updateCurrentNavigation(leafId, patch) {
    const current = this.getCurrent(leafId);
    if (current?.kind !== "navigation") return;
    Object.assign(current, patch);
    this.touchLeaf(leafId, {
      lastTitle: patch.title ?? current.title,
      lastUrl: patch.url ?? current.url
    });
  }
  addNavigation(input) {
    const now = input.timestamp ?? Date.now();
    const currentId = this.state.currentByLeaf[input.leafId];
    const current = currentId ? this.state.nodes[currentId] : void 0;
    if (input.reason === "back" || input.reason === "forward") {
      const existing = this.findAdjacentNavigation(input.leafId, currentId, input.url, input.reason);
      if (existing) {
        if (typeof input.sessionEntryIndex === "number") {
          existing.sessionEntryIndex = input.sessionEntryIndex;
        }
        this.state.currentByLeaf[input.leafId] = existing.id;
        this.touchLeaf(input.leafId, { lastUrl: existing.url, lastTitle: existing.title });
        this.events?.emit("navigation-committed", existing);
        return existing;
      }
    }
    const parentId = current?.kind === "residual" ? current.parentId : current?.id;
    const branchId = this.branchForNewNavigation(parentId);
    const node = {
      id: createId("nav"),
      kind: "navigation",
      leafId: input.leafId,
      containerId: input.containerId,
      timestamp: now,
      url: input.url,
      title: input.title || input.url,
      parentId,
      branchId,
      sessionEntryIndex: input.sessionEntryIndex,
      stale: false,
      manualRetention: "default"
    };
    this.state.nodes[node.id] = node;
    if (parentId) this.state.edges.push({ from: parentId, to: node.id, kind: "navigation" });
    if (!parentId) {
      const sourceLeafId = this.state.leaves[input.leafId]?.restoredFromLeafId;
      const sourceNodeId = sourceLeafId ? this.state.currentByLeaf[sourceLeafId] : void 0;
      if (sourceNodeId && this.state.nodes[sourceNodeId]) {
        this.state.edges.push({ from: sourceNodeId, to: node.id, kind: "restore" });
      }
    }
    this.state.currentByLeaf[input.leafId] = node.id;
    this.touchLeaf(input.leafId, { lastUrl: node.url, lastTitle: node.title });
    this.events?.emit("navigation-committed", node);
    return node;
  }
  addResidual(input) {
    const parentId = this.state.currentByLeaf[input.leafId];
    const node = {
      id: createId("res"),
      kind: "residual",
      leafId: input.leafId,
      timestamp: input.timestamp ?? Date.now(),
      residualKind: input.residualKind,
      parentId,
      fromUrl: input.fromUrl,
      toUrl: input.toUrl,
      detail: input.detail
    };
    this.state.nodes[node.id] = node;
    if (parentId) this.state.edges.push({ from: parentId, to: node.id, kind: "residual" });
    return node;
  }
  deleteNode(nodeId) {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind === "tombstone") return false;
    if (node.kind === "navigation") {
      for (const child of this.childrenOf(nodeId)) {
        if (child.kind === "residual") this.removeResidual(child.id);
      }
    }
    this.state.nodes[nodeId] = {
      id: nodeId,
      kind: "tombstone",
      leafId: node.leafId,
      timestamp: node.timestamp,
      deletedAt: Date.now()
    };
    return true;
  }
  deleteLeafHistory(leafId) {
    let changed = 0;
    for (const node of this.nodesForLeaf(leafId)) {
      if (node.kind !== "tombstone" && this.deleteNode(node.id)) changed++;
    }
    const leaf = this.state.leaves[leafId];
    if (leaf) {
      leaf.lastUrl = void 0;
      leaf.lastTitle = void 0;
    }
    return changed;
  }
  deleteBranch(branchId) {
    const navigationIds = new Set(
      Object.values(this.state.nodes).filter((node) => node.kind === "navigation" && node.branchId === branchId).map((node) => node.id)
    );
    let changed = 0;
    for (const nodeId of navigationIds) {
      if (this.deleteNode(nodeId)) changed++;
    }
    return changed;
  }
  navigationNodesForBranch(branchId) {
    return Object.values(this.state.nodes).filter((node) => node.kind === "navigation" && node.branchId === branchId).sort((a, b) => a.timestamp - b.timestamp);
  }
  latestNavigationForLeaf(leafId) {
    return this.nodesForLeaf(leafId).filter((node) => node.kind === "navigation").at(-1);
  }
  forgetLeafRecord(leafId) {
    delete this.state.leaves[leafId];
    delete this.state.currentByLeaf[leafId];
  }
  removeTombstone(nodeId) {
    const check = this.canRemoveTombstone(nodeId);
    if (!check.ok) return check;
    const incoming = this.state.edges.filter((edge) => edge.to === nodeId);
    const outgoing = this.state.edges.filter((edge) => edge.from === nodeId);
    this.state.edges = this.state.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    if (incoming[0] && outgoing[0]) {
      const kind = incoming[0].kind === "restore" || outgoing[0].kind === "restore" ? "restore" : "navigation";
      this.state.edges.push({ from: incoming[0].from, to: outgoing[0].to, kind });
    }
    delete this.state.nodes[nodeId];
    return { ok: true };
  }
  canRemoveTombstone(nodeId) {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind !== "tombstone") {
      return { ok: false, reason: "This entry is no longer a deleted entry marker." };
    }
    const incoming = this.state.edges.filter((edge) => edge.to === nodeId);
    const outgoing = this.state.edges.filter((edge) => edge.from === nodeId);
    if (incoming.length > 1 || outgoing.length > 1) {
      return {
        ok: false,
        reason: "This deleted entry marker connects multiple history paths, so removing it could change the remaining history."
      };
    }
    return { ok: true };
  }
  setCurrent(leafId, nodeId) {
    const node = this.state.nodes[nodeId];
    if (node?.leafId === leafId) this.state.currentByLeaf[leafId] = nodeId;
  }
  getCurrent(leafId) {
    const id = this.state.currentByLeaf[leafId];
    return id ? this.state.nodes[id] : void 0;
  }
  currentBranchForLeaf(leafId) {
    const current = this.getCurrent(leafId);
    if (current?.kind === "navigation") return current.branchId;
    if (current?.kind === "residual" && current.parentId) {
      const parent = this.state.nodes[current.parentId];
      return parent?.kind === "navigation" ? parent.branchId : void 0;
    }
    return void 0;
  }
  recentlyClosed(limit = 20) {
    return Object.values(this.state.leaves).filter(
      (leaf) => typeof leaf.closedAt === "number" && leaf.closeReason !== "shutdown" && leaf.closeReason !== "replaced"
    ).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, limit);
  }
  clearAll() {
    const nodes = Object.keys(this.state.nodes).length;
    const leaves = Object.keys(this.state.leaves).length;
    this.state.nodes = {};
    this.state.edges = [];
    this.state.currentByLeaf = {};
    this.state.leaves = {};
    return { nodes, leaves };
  }
  sweep(settings, now = Date.now()) {
    const candidates = Object.values(this.state.leaves).filter((leaf) => typeof leaf.closedAt === "number").filter((leaf) => !this.isProtectedLeaf(leaf.id)).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    let removed = 0;
    if (settings.historyRetentionDays > 0) {
      const cutoff = now - settings.historyRetentionDays * 24 * 60 * 60 * 1e3;
      for (const leaf of candidates) {
        if ((leaf.closedAt ?? Infinity) >= cutoff) continue;
        removed += this.removeLeafPermanently(leaf.id);
      }
    }
    const maxNodes = Math.floor(settings.historyMaxNodes);
    if (maxNodes > 0 && Object.keys(this.state.nodes).length > maxNodes) {
      for (const leaf of candidates) {
        if (!this.state.leaves[leaf.id]) continue;
        removed += this.removeLeafPermanently(leaf.id);
        if (Object.keys(this.state.nodes).length <= maxNodes) break;
      }
    }
    return removed;
  }
  nodesForLeaf(leafId) {
    return Object.values(this.state.nodes).filter((node) => node.leafId === leafId).sort((a, b) => a.timestamp - b.timestamp);
  }
  allNodes() {
    return Object.values(this.state.nodes).sort((a, b) => b.timestamp - a.timestamp);
  }
  childrenOf(nodeId) {
    return this.state.edges.filter((edge) => edge.from === nodeId).map((edge) => this.state.nodes[edge.to]).filter((node) => Boolean(node));
  }
  residualsOf(nodeId) {
    return this.childrenOf(nodeId).filter((node) => node.kind === "residual");
  }
  edgeSummary(nodeId) {
    return {
      incoming: this.state.edges.filter((edge) => edge.to === nodeId).length,
      outgoing: this.state.edges.filter((edge) => edge.from === nodeId).length
    };
  }
  branchForNewNavigation(parentId) {
    if (!parentId) return createId("branch");
    const parent = this.state.nodes[parentId];
    const existingChildren = this.state.edges.filter((edge) => edge.from === parentId && edge.kind === "navigation");
    if (parent?.kind === "navigation" && existingChildren.length === 0) return parent.branchId;
    return createId("branch");
  }
  findAdjacentNavigation(leafId, currentId, url, direction) {
    if (!currentId) return void 0;
    if (direction === "back") {
      const incoming = this.state.edges.find((edge) => edge.to === currentId && edge.kind === "navigation");
      const node = incoming ? this.state.nodes[incoming.from] : void 0;
      return node?.kind === "navigation" && node.leafId === leafId && node.url === url ? node : void 0;
    }
    const outgoing = this.state.edges.find((edge) => edge.from === currentId && edge.kind === "navigation");
    if (outgoing) {
      const first = this.state.nodes[outgoing.to];
      if (first?.kind === "navigation" && first.leafId === leafId && first.url === url) return first;
    }
    for (const edge of this.state.edges) {
      if (edge.from !== currentId || edge.kind !== "navigation") continue;
      const node = this.state.nodes[edge.to];
      if (node?.kind === "navigation" && node.leafId === leafId && node.url === url) return node;
    }
    return void 0;
  }
  removeResidual(nodeId) {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind !== "residual") return;
    delete this.state.nodes[nodeId];
    this.state.edges = this.state.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  }
  isProtectedLeaf(leafId) {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return false;
    if (leaf.pinned || leaf.manualRetention === "preserve") return true;
    return this.nodesForLeaf(leafId).some(
      (node) => node.kind === "navigation" && node.manualRetention === "preserve"
    );
  }
  removeLeafPermanently(leafId) {
    const nodeIds = new Set(this.nodesForLeaf(leafId).map((node) => node.id));
    const count = nodeIds.size;
    for (const nodeId of nodeIds) delete this.state.nodes[nodeId];
    this.state.edges = this.state.edges.filter(
      (edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to)
    );
    delete this.state.currentByLeaf[leafId];
    delete this.state.leaves[leafId];
    return count;
  }
};

// src/core/form-recovery-store.ts
var FormRecoveryStore = class {
  constructor(state) {
    this.state = state;
    this.migrateLegacyScope();
  }
  put(containerId, url, fields, settings) {
    const allowed = this.filterAllowed(containerId, url, fields);
    if (!allowed.length) return void 0;
    const key = this.key(containerId, url);
    const snapshot = {
      id: createId("form"),
      containerId,
      url,
      capturedAt: Date.now(),
      fields: allowed
    };
    const list = this.state.formRecovery[key] ?? [];
    const newest = list[0];
    if (newest && sameFields(newest.fields, allowed)) {
      list[0] = snapshot;
      this.state.formRecovery[key] = list;
      return snapshot;
    }
    list.unshift(snapshot);
    this.state.formRecovery[key] = list.slice(0, Math.max(1, settings.formRecoveryMaxSnapshotsPerUrl));
    this.trimUrlCount(Math.max(1, settings.formRecoveryMaxUrls));
    return snapshot;
  }
  latest(containerId, url) {
    return this.state.formRecovery[this.key(containerId, url)]?.[0];
  }
  has(containerId, url) {
    return this.recoveryFields(containerId, url).length > 0;
  }
  hasForDocument(containerId, url) {
    return this.recoveryFieldsForDocument(containerId, url).length > 0;
  }
  recoveryFields(containerId, url) {
    const snapshots = this.state.formRecovery[this.key(containerId, url)] ?? [];
    return this.mergeRecoveryFields(containerId, url, snapshots);
  }
  recoveryFieldsForDocument(containerId, url) {
    const exact = this.state.formRecovery[this.key(containerId, url)] ?? [];
    if (exact.length) return this.mergeRecoveryFields(containerId, url, exact);
    const scope = this.documentScope(url);
    if (!scope) return [];
    const related = Object.values(this.state.formRecovery).flat().filter(
      (snapshot) => snapshot.containerId === containerId && this.documentScope(snapshot.url) === scope
    ).sort((a, b) => b.capturedAt - a.capturedAt);
    return this.mergeRecoveryFields(containerId, url, related);
  }
  mergeRecoveryFields(containerId, url, snapshots) {
    const merged = /* @__PURE__ */ new Map();
    for (const snapshot of snapshots) {
      for (const field of snapshot.fields) {
        const fingerprint = fieldKey(field);
        if (!merged.has(fingerprint)) merged.set(fingerprint, field);
      }
    }
    return this.filterAllowed(containerId, url, [...merged.values()]);
  }
  isEnabledForUrl(containerId, url) {
    return this.policyForUrl(containerId, url)?.disabled === false;
  }
  disableSite(containerId, url, clearStored = true) {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    policy.disabled = true;
    policy.updatedAt = Date.now();
    if (clearStored) this.clearForOrigin(containerId, origin);
    return true;
  }
  enableSite(containerId, url) {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    policy.disabled = false;
    policy.updatedAt = Date.now();
    return true;
  }
  excludeField(containerId, url, field) {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    const key = fieldKey(field);
    if (!policy.excludedFieldKeys.includes(key)) policy.excludedFieldKeys.push(key);
    policy.updatedAt = Date.now();
    this.removeFieldFromStored(containerId, origin, key);
    return true;
  }
  resetPolicy(containerId, origin) {
    const key = this.policyKey(containerId, origin);
    if (!this.state.formRecoveryPolicies[key]) return false;
    delete this.state.formRecoveryPolicies[key];
    this.clearForOrigin(containerId, origin);
    return true;
  }
  policies() {
    return Object.values(this.state.formRecoveryPolicies).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  clearForUrl(containerId, url) {
    delete this.state.formRecovery[this.key(containerId, url)];
  }
  clearForSite(containerId, url) {
    const origin = this.origin(url);
    return origin ? this.clearForOrigin(containerId, origin) : 0;
  }
  clearAll() {
    const count = Object.keys(this.state.formRecovery).length;
    this.state.formRecovery = {};
    return count;
  }
  clearContainer(containerId) {
    let snapshots = 0;
    for (const [key, entries] of Object.entries(this.state.formRecovery)) {
      if (!entries.some((entry) => entry.containerId === containerId)) continue;
      delete this.state.formRecovery[key];
      snapshots++;
    }
    let policies = 0;
    for (const [key, policy] of Object.entries(this.state.formRecoveryPolicies)) {
      if (policy.containerId !== containerId) continue;
      delete this.state.formRecoveryPolicies[key];
      policies++;
    }
    return { snapshots, policies };
  }
  sweep(settings, now = Date.now()) {
    let changed = false;
    const maxAgeMs = settings.formRecoveryRetentionDays > 0 ? settings.formRecoveryRetentionDays * 24 * 60 * 60 * 1e3 : Infinity;
    const perUrl = Math.max(1, settings.formRecoveryMaxSnapshotsPerUrl);
    for (const [key, snapshots] of Object.entries(this.state.formRecovery)) {
      const approved = snapshots.some(
        (snapshot) => this.isEnabledForUrl(snapshot.containerId, snapshot.url)
      );
      if (!approved) {
        delete this.state.formRecovery[key];
        changed = true;
        continue;
      }
      const next = snapshots.filter((snapshot) => now - snapshot.capturedAt <= maxAgeMs).map((snapshot) => {
        const fields = this.filterAllowed(snapshot.containerId, snapshot.url, snapshot.fields);
        if (fields.length !== snapshot.fields.length) changed = true;
        return { ...snapshot, fields };
      }).filter((snapshot) => snapshot.fields.length > 0).slice(0, perUrl);
      if (next.length !== snapshots.length) changed = true;
      if (next.length) this.state.formRecovery[key] = next;
      else delete this.state.formRecovery[key];
    }
    if (this.trimUrlCount(Math.max(1, settings.formRecoveryMaxUrls))) changed = true;
    return changed;
  }
  filterAllowed(containerId, url, fields) {
    const policy = this.policyForUrl(containerId, url);
    if (!policy || policy.disabled) return [];
    const safeFields = fields.filter((field) => !isSensitiveField(field));
    if (!policy.excludedFieldKeys.length) return safeFields;
    const excluded = new Set(policy.excludedFieldKeys);
    return safeFields.filter((field) => !excluded.has(fieldKey(field)));
  }
  policyForUrl(containerId, url) {
    const origin = this.origin(url);
    return origin ? this.state.formRecoveryPolicies[this.policyKey(containerId, origin)] : void 0;
  }
  ensurePolicy(containerId, origin) {
    const key = this.policyKey(containerId, origin);
    return this.state.formRecoveryPolicies[key] ??= {
      containerId,
      origin,
      disabled: false,
      excludedFieldKeys: [],
      updatedAt: Date.now()
    };
  }
  clearForOrigin(containerId, origin) {
    let removed = 0;
    for (const [key, snapshots] of Object.entries(this.state.formRecovery)) {
      if (!snapshots.some(
        (snapshot) => snapshot.containerId === containerId && this.origin(snapshot.url) === origin
      )) continue;
      delete this.state.formRecovery[key];
      removed++;
    }
    return removed;
  }
  removeFieldFromStored(containerId, origin, excludedKey) {
    for (const snapshots of Object.values(this.state.formRecovery)) {
      for (const snapshot of snapshots) {
        if (snapshot.containerId !== containerId || this.origin(snapshot.url) !== origin) continue;
        snapshot.fields = snapshot.fields.filter((field) => fieldKey(field) !== excludedKey);
      }
    }
  }
  origin(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : void 0;
    } catch {
      return void 0;
    }
  }
  documentScope(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
      return parsed.origin + parsed.pathname;
    } catch {
      return void 0;
    }
  }
  key(containerId, url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return containerId + "" + parsed.toString();
    } catch {
      return containerId + "" + url;
    }
  }
  policyKey(containerId, origin) {
    return containerId + "" + origin;
  }
  migrateLegacyScope() {
    const migratedRecovery = {};
    for (const snapshots of Object.values(this.state.formRecovery)) {
      for (const legacySnapshot of snapshots) {
        const snapshot = legacySnapshot;
        const containerId = snapshot.containerId ?? "default";
        const normalized = { ...snapshot, containerId };
        const key = this.key(containerId, normalized.url);
        (migratedRecovery[key] ??= []).push(normalized);
      }
    }
    for (const snapshots of Object.values(migratedRecovery)) {
      snapshots.sort((a, b) => b.capturedAt - a.capturedAt);
    }
    this.state.formRecovery = migratedRecovery;
    const migratedPolicies = {};
    for (const legacyPolicy of Object.values(this.state.formRecoveryPolicies)) {
      const policy = legacyPolicy;
      const containerId = policy.containerId ?? "default";
      const normalized = { ...policy, containerId };
      migratedPolicies[this.policyKey(containerId, normalized.origin)] = normalized;
    }
    this.state.formRecoveryPolicies = migratedPolicies;
  }
  trimUrlCount(maxUrls) {
    const entries = Object.entries(this.state.formRecovery);
    if (entries.length <= maxUrls) return false;
    entries.sort((a, b) => newestTimestamp(b[1]) - newestTimestamp(a[1]));
    for (const [key] of entries.slice(maxUrls)) delete this.state.formRecovery[key];
    return true;
  }
};
function sameFields(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
function fieldKey(field) {
  const choiceValue = field.type === "radio" || field.type === "checkbox" ? field.value ?? "" : "";
  return [
    field.id ?? "",
    field.name ?? "",
    field.type,
    field.label ?? "",
    field.autocomplete ?? "",
    field.ariaLabel ?? "",
    field.placeholder ?? "",
    field.nearbyText ?? "",
    choiceValue
  ].join("");
}
function newestTimestamp(snapshots) {
  return snapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.capturedAt), 0);
}
function isSensitiveField(field) {
  const type = field.type.toLowerCase();
  if (type === "password" || type === "file" || type === "hidden") return true;
  const haystack = [
    field.name,
    field.id,
    field.label,
    field.autocomplete,
    field.ariaLabel,
    field.placeholder,
    field.nearbyText
  ].filter(Boolean).join(" ").toLowerCase();
  return /(?:password|passcode|one[- ]?time|otp|webauthn|cc-|credit[- ]?card|card[- ]?(?:number|no)|cvc|cvv|security[- ]?code)/i.test(haystack);
}

// src/core/events.ts
var BrowserEventBus = class {
  listeners = /* @__PURE__ */ new Map();
  on(event, callback) {
    const bucket = this.listeners.get(event) ?? /* @__PURE__ */ new Set();
    bucket.add(callback);
    this.listeners.set(event, bucket);
    return () => {
      bucket.delete(callback);
      if (bucket.size === 0) this.listeners.delete(event);
    };
  }
  emit(event, payload) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload);
  }
  clear() {
    this.listeners.clear();
  }
};

// src/core/permission-store.ts
var PermissionStore = class {
  constructor(records) {
    this.records = records;
  }
  decision(containerId, origin, permission) {
    return this.records.find(
      (record) => record.containerId === containerId && record.origin === origin && record.permission === permission
    )?.decision ?? "ask";
  }
  set(containerId, origin, permission, decision) {
    const existing = this.records.find(
      (record) => record.containerId === containerId && record.origin === origin && record.permission === permission
    );
    if (existing) {
      existing.decision = decision;
      existing.updatedAt = Date.now();
      return;
    }
    this.records.push({
      containerId,
      origin,
      permission,
      decision,
      updatedAt: Date.now()
    });
  }
  resetOrigin(containerId, origin) {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record?.containerId === containerId && record.origin === origin) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }
  resetContainer(containerId) {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]?.containerId === containerId) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }
  clearAll() {
    const count = this.records.length;
    this.records.splice(0, this.records.length);
    return count;
  }
  remove(containerId, origin, permission) {
    const index = this.records.findIndex(
      (record) => record.containerId === containerId && record.origin === origin && record.permission === permission
    );
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
  list(containerId) {
    return this.records.filter((record) => !containerId || record.containerId === containerId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  listForOrigin(containerId, origin) {
    return this.records.filter((record) => record.containerId === containerId && record.origin === origin).sort((a, b) => a.permission.localeCompare(b.permission));
  }
};

// src/core/restore-store.ts
var RestoreStore = class {
  constructor(state) {
    this.state = state;
  }
  get(leafId) {
    return this.state.restoreCapsules[leafId];
  }
  put(capsule) {
    this.state.restoreCapsules[capsule.leafId] = capsule;
  }
  remove(leafId) {
    delete this.state.restoreCapsules[leafId];
    this.markLeafStale(leafId);
  }
  clearAll() {
    const leafIds = Object.keys(this.state.restoreCapsules);
    for (const leafId of leafIds) this.remove(leafId);
    return leafIds.length;
  }
  sweep(settings, now = Date.now()) {
    let changed = false;
    const maxAgeMs = Math.max(0, settings.restoreRetentionDays) * 864e5;
    for (const capsule of Object.values(this.state.restoreCapsules)) {
      if (this.isProtected(capsule.leafId)) continue;
      if (maxAgeMs === 0 || now - capsule.capturedAt > maxAgeMs) {
        this.remove(capsule.leafId);
        changed = true;
      }
    }
    const limitBytes = Math.max(16, settings.restoreStorageLimitMb) * 1024 * 1024;
    let capsules = Object.values(this.state.restoreCapsules).sort((a, b) => a.capturedAt - b.capturedAt);
    let total = capsules.reduce((sum, capsule) => sum + this.sizeOf(capsule), 0);
    for (const capsule of capsules) {
      if (total <= limitBytes) break;
      if (this.isProtected(capsule.leafId)) continue;
      total -= this.sizeOf(capsule);
      this.remove(capsule.leafId);
      changed = true;
    }
    return changed;
  }
  isProtected(leafId) {
    const leaf = this.state.history.leaves[leafId];
    if (leaf?.pinned || leaf?.manualRetention === "preserve") return true;
    return Object.values(this.state.history.nodes).some(
      (node) => node.kind === "navigation" && node.leafId === leafId && node.manualRetention === "preserve"
    );
  }
  markLeafStale(leafId) {
    for (const node of Object.values(this.state.history.nodes)) {
      if (node.kind === "navigation" && node.leafId === leafId) node.stale = true;
    }
  }
  sizeOf(capsule) {
    try {
      return new TextEncoder().encode(JSON.stringify(capsule)).byteLength;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
};

// src/core/site-zoom-store.ts
var SiteZoomStore = class {
  constructor(factors, defaultFactor = () => 1) {
    this.factors = factors;
    this.defaultFactor = defaultFactor;
  }
  factorForUrl(url) {
    const origin = this.origin(url);
    const fallback = clampZoom(this.defaultFactor());
    return origin ? this.factors[origin] ?? fallback : fallback;
  }
  setForUrl(url, factor) {
    const origin = this.origin(url);
    const next = clampZoom(factor);
    if (!origin) return next;
    if (Math.abs(next - clampZoom(this.defaultFactor())) < 1e-3) delete this.factors[origin];
    else this.factors[origin] = next;
    return next;
  }
  adjust(url, delta) {
    return this.setForUrl(url, this.factorForUrl(url) + delta);
  }
  reset(url) {
    const origin = this.origin(url);
    if (origin) delete this.factors[origin];
  }
  entries() {
    return Object.entries(this.factors).map(([origin, factor]) => ({ origin, factor })).sort((a, b) => a.origin.localeCompare(b.origin));
  }
  origin(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : void 0;
    } catch {
      return void 0;
    }
  }
};
function clampZoom(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(5, Math.max(0.25, value)) * 100) / 100;
}

// src/core/model.ts
var DEFAULT_SETTINGS = {
  tabStyle: "firefox",
  tabStripIntegrationEnabled: true,
  replaceEmptyTabsWithHome: true,
  homeSearchMode: "vault",
  showRecentVaultFilesOnHome: true,
  showVaultBookmarksOnHome: true,
  searchUrlTemplate: "https://www.google.com/search?q={query}",
  historyDayStartMinutes: 240,
  historyRetentionDays: 0,
  historyMaxNodes: 0,
  restoreRetentionDays: 14,
  restoreStorageLimitMb: 128,
  startupBehavior: "restore",
  formRecoveryEnabled: false,
  formRecoveryRetentionDays: 7,
  formRecoveryMaxSnapshotsPerUrl: 5,
  formRecoveryMaxUrls: 200,
  reducedMotion: false,
  fullPageLoadingShield: false,
  showRecoveryNotifications: true,
  defaultZoomFactor: 1,
  defaultContainerId: "default",
  containerMode: "automatic",
  showFavoritesBar: true,
  bookmarkBarMode: "selected",
  initialBackgroundOverride: true,
  initialBackgroundSource: "theme",
  initialBackgroundColor: "#ffffff",
  autoplayPolicy: "block-audible",
  blockPasskeyRequests: false,
  language: "auto"
};
var EMPTY_HISTORY = {
  nodes: {},
  edges: [],
  currentByLeaf: {},
  leaves: {}
};
var EMPTY_BOOKMARKS = {
  folders: {},
  bookmarks: {}
};

// src/core/browser-core.ts
var BrowserCore = class {
  constructor(app, state, persistence, partitionScope) {
    this.app = app;
    this.state = state;
    this.persistence = persistence;
    this.events = new BrowserEventBus();
    this.history = new HistoryGraph(state.history, this.events);
    this.bookmarks = new BookmarkStore(state.bookmarks, (event) => this.events.emit("bookmark-changed", event));
    this.containers = new ContainerStore(state.containers, state.siteContainerRules, partitionScope);
    this.restore = new RestoreStore(state);
    this.formRecovery = new FormRecoveryStore(state);
    this.permissions = new PermissionStore(state.permissions);
    this.zoom = new SiteZoomStore(state.siteZoom, () => state.settings.defaultZoomFactor);
    this.containers.ensureDefault();
  }
  events;
  history;
  bookmarks;
  containers;
  restore;
  formRecovery;
  permissions;
  zoom;
  saveTimer;
  static normalize(raw) {
    const rawSettings = raw?.settings ?? {};
    const {
      restorePreviousSession: legacyRestorePreviousSession,
      historyDayStartHour: legacyHistoryDayStartHour,
      showBookmarkBar: legacyShowBookmarkBar,
      ...settingsPatch
    } = rawSettings;
    const startupBehavior = settingsPatch.startupBehavior ?? (legacyRestorePreviousSession === false ? "none" : DEFAULT_SETTINGS.startupBehavior);
    const historyDayStartMinutes = settingsPatch.historyDayStartMinutes ?? (typeof legacyHistoryDayStartHour === "number" ? Math.round(legacyHistoryDayStartHour * 60) : DEFAULT_SETTINGS.historyDayStartMinutes);
    const showFavoritesBar = settingsPatch.showFavoritesBar ?? legacyShowBookmarkBar ?? DEFAULT_SETTINGS.showFavoritesBar;
    const rawBookmarks = raw?.bookmarks?.bookmarks ?? { ...EMPTY_BOOKMARKS.bookmarks };
    const normalizedBookmarks = Object.fromEntries(
      Object.entries(rawBookmarks).map(([id, bookmark]) => [id, {
        ...bookmark,
        favorite: bookmark.favorite ?? bookmark.parentId === null,
        favoriteOrder: bookmark.favoriteOrder ?? (bookmark.favorite ?? bookmark.parentId === null ? bookmark.order : void 0),
        visualKind: bookmark.visualKind ?? "favicon"
      }])
    );
    const bookmarks = mergeDuplicateBookmarks(normalizedBookmarks);
    return {
      version: 6,
      settings: { ...DEFAULT_SETTINGS, ...settingsPatch, startupBehavior, historyDayStartMinutes, showFavoritesBar },
      siteZoom: raw?.siteZoom ?? {},
      containers: raw?.containers ?? {},
      siteContainerRules: raw?.siteContainerRules ?? [],
      history: {
        nodes: raw?.history?.nodes ?? { ...EMPTY_HISTORY.nodes },
        edges: raw?.history?.edges ?? [],
        currentByLeaf: raw?.history?.currentByLeaf ?? {},
        leaves: raw?.history?.leaves ?? {}
      },
      bookmarks: {
        folders: raw?.bookmarks?.folders ?? { ...EMPTY_BOOKMARKS.folders },
        bookmarks
      },
      permissions: raw?.permissions ?? [],
      restoreCapsules: raw?.restoreCapsules ?? {},
      formRecovery: raw?.formRecovery ?? {},
      formRecoveryPolicies: raw?.formRecoveryPolicies ?? {},
      sessionCheckpoint: raw?.sessionCheckpoint ?? { capturedAt: 0, leaves: [] },
      surfingMigration: raw?.surfingMigration
    };
  }
  settings() {
    return this.state.settings;
  }
  updateSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.scheduleSave();
  }
  searchUrl(query) {
    const encoded = encodeURIComponent(query);
    const template = this.state.settings.searchUrlTemplate || DEFAULT_SETTINGS.searchUrlTemplate;
    return template.includes("{query}") ? template.replaceAll("{query}", encoded) : DEFAULT_SETTINGS.searchUrlTemplate.replace("{query}", encoded);
  }
  setSessionCheckpoint(checkpoint) {
    this.state.sessionCheckpoint = checkpoint;
    this.scheduleSave();
  }
  sweepRestoreCapsules() {
    const changed = this.restore.sweep(this.state.settings);
    if (changed) this.scheduleSave();
    return changed;
  }
  sweepRetention() {
    const restoreChanged = this.restore.sweep(this.state.settings);
    const formRecoveryChanged = this.formRecovery.sweep(this.state.settings);
    const historyRemoved = this.history.sweep(this.state.settings);
    if (restoreChanged || formRecoveryChanged || historyRemoved > 0) this.scheduleSave();
    return { restoreChanged, formRecoveryChanged, historyRemoved };
  }
  sweepHistory() {
    const removed = this.history.sweep(this.state.settings);
    if (removed) this.scheduleSave();
    return removed;
  }
  sweepFormRecovery() {
    const changed = this.formRecovery.sweep(this.state.settings);
    if (changed) this.scheduleSave();
    return changed;
  }
  redactHistoryNode(nodeId) {
    return this.redactHistoryNodes([nodeId]) > 0;
  }
  redactHistoryNodes(nodeIds) {
    const affectedLeaves = /* @__PURE__ */ new Set();
    let changed = 0;
    for (const nodeId of nodeIds) {
      const node = this.state.history.nodes[nodeId];
      if (!node || node.kind === "tombstone") continue;
      affectedLeaves.add(node.leafId);
      if (this.history.deleteNode(nodeId)) changed++;
    }
    if (!changed) return 0;
    for (const leafId of affectedLeaves) this.suppressRichRestoreForLeaf(leafId);
    this.scheduleSave();
    return changed;
  }
  redactHistoryBranch(branchId) {
    const nodes = this.history.navigationNodesForBranch(branchId);
    return this.redactHistoryNodes(nodes.map((node) => node.id));
  }
  redactLeafHistory(leafId) {
    const changed = this.history.deleteLeafHistory(leafId);
    if (!changed) return 0;
    this.suppressRichRestoreForLeaf(leafId);
    this.scheduleSave();
    return changed;
  }
  suppressRichRestoreForLeaf(leafId) {
    const leaf = this.state.history.leaves[leafId];
    if (leaf) leaf.richRestoreSuppressed = true;
    this.restore.remove(leafId);
  }
  normalizeContainer(requested) {
    return this.containers.get(requested || this.state.settings.defaultContainerId).id;
  }
  resolveContainerForNavigation(url, fallback) {
    const normalizedFallback = this.normalizeContainer(fallback);
    if (!url || url.startsWith("browser://")) return normalizedFallback;
    if (this.state.settings.containerMode !== "automatic") return normalizedFallback;
    return this.containers.resolveForUrl(url, normalizedFallback);
  }
  defaultContainerForNewTab() {
    return this.normalizeContainer(this.state.settings.defaultContainerId);
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = void 0;
      void this.persistence.save(this.state);
    }, 150);
  }
  async flush() {
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.persistence.save(this.state);
  }
};
function mergeDuplicateBookmarks(bookmarks) {
  const merged = {};
  const byUrl = /* @__PURE__ */ new Map();
  const ordered = Object.values(bookmarks).sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  for (const bookmark of ordered) {
    const key = normalizeBookmarkUrl(bookmark.url);
    const existingId = byUrl.get(key);
    if (!existingId) {
      merged[bookmark.id] = { ...bookmark };
      byUrl.set(key, bookmark.id);
      continue;
    }
    const existing = merged[existingId];
    if (!existing) continue;
    if (existing.parentId === null && bookmark.parentId !== null) {
      existing.parentId = bookmark.parentId;
      existing.order = bookmark.order;
    }
    existing.favorite = existing.favorite || bookmark.favorite;
    const favoriteOrders = [existing.favoriteOrder, bookmark.favoriteOrder].filter((value) => typeof value === "number");
    existing.favoriteOrder = favoriteOrders.length ? Math.min(...favoriteOrders) : void 0;
    if (existing.visualKind === "favicon" && bookmark.visualKind !== "favicon") {
      existing.visualKind = bookmark.visualKind;
      existing.visualValue = bookmark.visualValue;
    }
    if (!existing.faviconUrl && bookmark.faviconUrl) existing.faviconUrl = bookmark.faviconUrl;
  }
  return merged;
}

// src/i18n.ts
var language = "auto";
var resolveLocale = () => typeof navigator === "undefined" ? "en" : navigator.language;
function setLocaleResolver(resolver) {
  resolveLocale = resolver;
}
function setLanguage(value) {
  language = value;
}
function t(source, values = {}) {
  let locale = language;
  if (locale === "auto") {
    try {
      locale = resolveLocale();
    } catch {
      locale = "en";
    }
  }
  const result = locale.toLowerCase().startsWith("ja") ? ja[source] ?? source : source;
  return result.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
}
var ja = {
  "Search files in your vault": "Vault\u5185\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22",
  "Search the web or enter an address": "\u30A6\u30A7\u30D6\u3092\u691C\u7D22\u3001\u307E\u305F\u306F\u30A2\u30C9\u30EC\u30B9\u3092\u5165\u529B",
  "Never show again": "\u4ECA\u5F8C\u8868\u793A\u3057\u306A\u3044",
  "Show recovery notifications": "\u5FA9\u5143\u901A\u77E5\u3092\u8868\u793A",
  "Recovery notifications disappear when you interact with the page. Turn this on to show them again after choosing Never show again.": "\u30DA\u30FC\u30B8\u3092\u64CD\u4F5C\u3059\u308B\u3068\u5FA9\u5143\u901A\u77E5\u304C\u6D88\u3048\u307E\u3059\u3002\u300C\u4ECA\u5F8C\u8868\u793A\u3057\u306A\u3044\u300D\u3092\u9078\u629E\u3057\u305F\u5F8C\u306F\u3001\u3053\u3053\u3067\u518D\u8868\u793A\u3092\u6709\u52B9\u306B\u3067\u304D\u307E\u3059\u3002",
  "Detailed tab recovery is no longer available. Browser Core is reopening the saved URL from browsing history.": "\u8A73\u7D30\u306A\u30BF\u30D6\u5FA9\u5143\u30C7\u30FC\u30BF\u304C\u306A\u3044\u305F\u3081\u3001\u5C65\u6B74\u306B\u4FDD\u5B58\u3057\u305FURL\u3092\u958B\u304D\u76F4\u3057\u307E\u3057\u305F\u3002",
  "Detailed tab recovery could not be applied. Browser Core is reopening the saved URL and can still use form recovery or the website's own saved state.": "\u8A73\u7D30\u306A\u30BF\u30D6\u5FA9\u5143\u3092\u9069\u7528\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u4FDD\u5B58\u3057\u305FURL\u3092\u958B\u304D\u76F4\u3057\u307E\u3057\u305F\u3002\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3084\u30B5\u30A4\u30C8\u81EA\u8EAB\u306E\u4FDD\u5B58\u72B6\u614B\u3092\u5229\u7528\u3067\u304D\u307E\u3059\u3002",
  "Navigation state restored from the closed tab. Some live page state may still need to reload.": "\u9589\u3058\u305F\u30BF\u30D6\u306E\u79FB\u52D5\u5C65\u6B74\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002\u30DA\u30FC\u30B8\u306E\u4E00\u90E8\u306F\u518D\u8AAD\u307F\u8FBC\u307F\u304C\u5FC5\u8981\u306A\u5834\u5408\u304C\u3042\u308A\u307E\u3059\u3002",
  "Detailed tab state restored. Some page state may still depend on the website.": "\u8A73\u7D30\u306A\u30BF\u30D6\u72B6\u614B\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002\u4E00\u90E8\u306E\u72B6\u614B\u306F\u30B5\u30A4\u30C8\u81EA\u8EAB\u306E\u51E6\u7406\u306B\u4F9D\u5B58\u3057\u307E\u3059\u3002",
  "Relative to this Obsidian window. Used by sites without a site-specific zoom override.": "\u3053\u306EObsidian\u30A6\u30A3\u30F3\u30C9\u30A6\u306E\u500D\u7387\u3092\u57FA\u6E96\u306B\u3057\u307E\u3059\u3002\u30B5\u30A4\u30C8\u56FA\u6709\u306E\u500D\u7387\u304C\u306A\u3044\u5834\u5408\u306B\u9069\u7528\u3055\u308C\u307E\u3059\u3002",
  "No override": "\u4E0A\u66F8\u304D\u306A\u3057",
  "Follow theme": "\u30C6\u30FC\u30DE\u306B\u5408\u308F\u305B\u308B",
  "Custom color": "\u4EFB\u610F\u306E\u8272",
  "Initial background color": "\u521D\u671F\u80CC\u666F\u8272",
  "Choose the background before the site paints. The site's own colors remain in control once painted.": "\u30B5\u30A4\u30C8\u304C\u63CF\u753B\u3055\u308C\u308B\u524D\u306E\u80CC\u666F\u8272\u3092\u9078\u629E\u3057\u307E\u3059\u3002\u63CF\u753B\u5F8C\u306F\u30B5\u30A4\u30C8\u81EA\u8EAB\u306E\u8272\u304C\u512A\u5148\u3055\u308C\u307E\u3059\u3002",
  "Playback and authentication": "\u518D\u751F\u3068\u8A8D\u8A3C",
  "Autoplay": "\u81EA\u52D5\u518D\u751F",
  "Block audible autoplay": "\u97F3\u58F0\u4ED8\u304D\u306E\u81EA\u52D5\u518D\u751F\u3092\u6291\u5236",
  "Allow autoplay": "\u81EA\u52D5\u518D\u751F\u3092\u8A31\u53EF",
  "Block audible autoplay until you interact with the page. Muted videos may still play. Reopen tabs after changing this setting.": "\u30DA\u30FC\u30B8\u3092\u64CD\u4F5C\u3059\u308B\u307E\u3067\u97F3\u58F0\u4ED8\u304D\u306E\u81EA\u52D5\u518D\u751F\u3092\u6291\u5236\u3057\u307E\u3059\u3002\u7121\u97F3\u306E\u52D5\u753B\u306F\u518D\u751F\u3055\u308C\u308B\u5834\u5408\u304C\u3042\u308A\u307E\u3059\u3002\u5909\u66F4\u5F8C\u306F\u30BF\u30D6\u3092\u958B\u304D\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "Block passkey requests": "\u30D1\u30B9\u30AD\u30FC\u8981\u6C42\u3092\u6291\u5236",
  "Prevent sites from requesting or creating passkeys, including requests you start yourself. Turn off to sign in with a passkey. Reload pages after changing this setting.": "\u30B5\u30A4\u30C8\u306E\u30D1\u30B9\u30AD\u30FC\u8981\u6C42\u30FB\u767B\u9332\u3092\u6291\u5236\u3057\u307E\u3059\u3002\u624B\u52D5\u3067\u958B\u59CB\u3057\u305F\u8981\u6C42\u3082\u5BFE\u8C61\u3067\u3059\u3002\u30D1\u30B9\u30AD\u30FC\u3067\u30ED\u30B0\u30A4\u30F3\u3059\u308B\u969B\u306F\u30AA\u30D5\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u5909\u66F4\u5F8C\u306F\u30DA\u30FC\u30B8\u3092\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "Clear browser history": "\u30D6\u30E9\u30A6\u30B6\u5C65\u6B74\u3092\u6D88\u53BB",
  "Copy link": "\u30EA\u30F3\u30AF\u3092\u30B3\u30D4\u30FC",
  "Show link in history": "\u30EA\u30F3\u30AF\u306E\u5C65\u6B74\u3092\u898B\u308B",
  "Copy image URL": "\u753B\u50CF\u306EURL\u3092\u30B3\u30D4\u30FC",
  "Download image": "\u753B\u50CF\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9",
  "Undo": "\u5143\u306B\u623B\u3059",
  "Redo": "\u3084\u308A\u76F4\u3059",
  "Copy selected text": "\u9078\u629E\u3057\u305F\u6587\u5B57\u3092\u30B3\u30D4\u30FC",
  "Restore previous value": "\u524D\u56DE\u306E\u5165\u529B\u5185\u5BB9\u3092\u5FA9\u5143",
  "Restore all saved form values": "\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u3092\u3059\u3079\u3066\u5FA9\u5143",
  "Show saved form values": "\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u3092\u8868\u793A",
  "Disable recovery for this field": "\u3053\u306E\u5165\u529B\u6B04\u3092\u5FA9\u5143\u5BFE\u8C61\u304B\u3089\u5916\u3059",
  "Disable form recovery for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u7121\u52B9\u306B\u3059\u308B",
  "Enable form recovery for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u6709\u52B9\u306B\u3059\u308B",
  "Reopen in container\u2026": "\u5225\u306EContainer\u3067\u958B\u304D\u76F4\u3059\u2026",
  "Open link in {name}": "{name}\u3067\u30EA\u30F3\u30AF\u3092\u958B\u304F",
  "Search \u201C{query}\u201D": "\u300C{query}\u300D\u3092\u691C\u7D22",
  "Adopt Surfing's persistent login session, import bookmarks and compatible settings, and copy open tabs. Existing Browser Core data and Surfing source files are kept.": "Surfing\u306E\u30ED\u30B0\u30A4\u30F3\u72B6\u614B\u3001\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3001\u5BFE\u5FDC\u3059\u308B\u8A2D\u5B9A\u3001\u958B\u3044\u3066\u3044\u308B\u30BF\u30D6\u3092\u79FB\u884C\u3057\u307E\u3059\u3002\u65E2\u5B58\u306EUBC\u30C7\u30FC\u30BF\u3068Surfing\u306E\u5143\u30C7\u30FC\u30BF\u306F\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "Completed. Original Surfing data was kept. Backup: {v0}": "\u79FB\u884C\u6E08\u307F\u3067\u3059\u3002\u5143\u30C7\u30FC\u30BF\u306F\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\uFF1A{v0}",
  "Surfing migration already completed. Backup: {v0}": "Surfing\u306E\u79FB\u884C\u306F\u5B8C\u4E86\u3057\u3066\u3044\u307E\u3059\u3002\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\uFF1A{v0}",
  "Applied automatically when an independent navigation opens a matching site.": "\u4E00\u81F4\u3059\u308B\u30B5\u30A4\u30C8\u3092\u958B\u3044\u305F\u3068\u304D\u306B\u81EA\u52D5\u3067\u9069\u7528\u3057\u307E\u3059\u3002",
  "Saved for later, but currently paused because automatic container routing is off.": "\u6307\u5B9A\u306F\u4FDD\u5B58\u3055\u308C\u3066\u3044\u307E\u3059\u304C\u3001Container\u306E\u81EA\u52D5\u5207\u308A\u66FF\u3048\u304C\u7121\u52B9\u306E\u305F\u3081\u505C\u6B62\u3057\u3066\u3044\u307E\u3059\u3002",
  "Open in {v0}": "{v0}\u3067\u958B\u304F",
  "Reopen in {v0}": "{v0}\u3067\u958B\u304D\u76F4\u3059",
  "Always open {v0} in {v1}": "{v0}\u3092\u5E38\u306B{v1}\u3067\u958B\u304F",
  "Always open {v0} in {v1}.": "{v0}\u3092\u5E38\u306B{v1}\u3067\u958B\u304D\u307E\u3059\u3002",
  "Site default \xB7 {v0}": "\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\uFF1A{v0}",
  "Return to site default \xB7 {v0}": "\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\u306B\u623B\u3059\uFF1A{v0}",
  "Opened here explicitly \xB7 site default is {v0}": "\u624B\u52D5\u3067\u958B\u3044\u305FContainer\u3067\u3059\uFF08\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\uFF1A{v0}\uFF09",
  "Sign-in flow stays in this container \xB7 site default is {v0}": "\u30ED\u30B0\u30A4\u30F3\u51E6\u7406\u4E2D\u306F\u3053\u306EContainer\u3092\u4F7F\u7528\u3057\u307E\u3059\uFF08\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\uFF1A{v0}\uFF09",
  "Clear this container's cookies, site storage, cache, sign-in cache, and saved site permissions? Open pages may need to be reloaded.": "\u3053\u306EContainer\u306ECookie\u3001\u30B5\u30A4\u30C8\u30C7\u30FC\u30BF\u3001\u30AD\u30E3\u30C3\u30B7\u30E5\u3001\u8A8D\u8A3C\u30AD\u30E3\u30C3\u30B7\u30E5\u3001\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u3092\u6D88\u53BB\u3057\u307E\u3059\u304B\uFF1F\u958B\u3044\u3066\u3044\u308B\u30DA\u30FC\u30B8\u306F\u518D\u8AAD\u307F\u8FBC\u307F\u304C\u5FC5\u8981\u306B\u306A\u308B\u5834\u5408\u304C\u3042\u308A\u307E\u3059\u3002",
  "Cleared browsing data and saved permissions for \u201C{v0}\u201D.": "\u300C{v0}\u300D\u306E\u95B2\u89A7\u30C7\u30FC\u30BF\u3068\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u3092\u6D88\u53BB\u3057\u307E\u3057\u305F\u3002",
  "Could not clear browsing data for \u201C{v0}\u201D.": "\u300C{v0}\u300D\u306E\u95B2\u89A7\u30C7\u30FC\u30BF\u3092\u6D88\u53BB\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "Delete \u201C{v0}\u201D? Its cookies, site storage, cache, saved permissions, form recovery data, and site default rules will be cleared. Browsing history will remain.": "\u300C{v0}\u300D\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1FCookie\u3001\u30B5\u30A4\u30C8\u30C7\u30FC\u30BF\u3001\u30AD\u30E3\u30C3\u30B7\u30E5\u3001\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u3001\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u30C7\u30FC\u30BF\u3001\u30B5\u30A4\u30C8\u6307\u5B9A\u3092\u6D88\u53BB\u3057\u307E\u3059\u3002\u95B2\u89A7\u5C65\u6B74\u306F\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "Deleted container \u201C{v0}\u201D and cleared its browsing data.": "Container\u300C{v0}\u300D\u3092\u524A\u9664\u3057\u3001\u95B2\u89A7\u30C7\u30FC\u30BF\u3092\u6D88\u53BB\u3057\u307E\u3057\u305F\u3002",
  "Delete \u201C{v0}\u201D from your bookmarks?": "\u300C{v0}\u300D\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u304B\u3089\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete the empty folder \u201C{v0}\u201D?": "\u7A7A\u306E\u30D5\u30A9\u30EB\u30C0\u300C{v0}\u300D\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete \u201C{v0}\u201D and its {v1} bookmark{v2}?": "\u300C{v0}\u300D\u3068\u4E2D\u306E{v1}\u4EF6\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "{v0} bookmark{v1} in {v2}": "{v2}\u306B{v0}\u4EF6\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Pin": "\u56FA\u5B9A",
  "Unpin": "\u56FA\u5B9A\u3092\u89E3\u9664",
  "Pin browser tab": "\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u56FA\u5B9A",
  "Unpin browser tab": "\u30BF\u30D6\u306E\u56FA\u5B9A\u3092\u89E3\u9664",
  "Remove": "\u53D6\u308A\u9664\u304F",
  "No back history": "\u623B\u308B\u5C65\u6B74\u306F\u3042\u308A\u307E\u305B\u3093",
  "No forward history": "\u9032\u3080\u5C65\u6B74\u306F\u3042\u308A\u307E\u305B\u3093",
  "Navigation status": "\u8AAD\u307F\u8FBC\u307F\u72B6\u6CC1",
  "Browser Core page": "Browser Core\u306E\u30DA\u30FC\u30B8",
  "Migrate": "\u79FB\u884C",
  "Delete history": "\u5C65\u6B74\u3092\u524A\u9664",
  "Delete path": "\u7D4C\u8DEF\u3092\u524A\u9664",
  "Delete history day": "\u3053\u306E\u65E5\u306E\u5C65\u6B74\u3092\u524A\u9664",
  "Delete alternate history path": "\u5206\u5C90\u3057\u305F\u7D4C\u8DEF\u306E\u5C65\u6B74\u3092\u524A\u9664",
  "Remove closed tab from history": "\u9589\u3058\u305F\u30BF\u30D6\u3092\u5C65\u6B74\u304B\u3089\u524A\u9664",
  "Delete browsing history and detailed closed-tab recovery data? Open tabs, bookmarks, containers, cookies and form recovery remain.": "\u95B2\u89A7\u5C65\u6B74\u3068\u9589\u3058\u305F\u30BF\u30D6\u306E\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F\u30BF\u30D6\u3001\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3001Container\u3001Cookie\u3001\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u306F\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "Delete all saved Browser Core form recovery data?": "\u4FDD\u5B58\u3057\u305F\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u3059\u3079\u3066\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete all saved Browser Core form recovery data? Sites that opted in will stay enabled.": "\u4FDD\u5B58\u3057\u305F\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u3059\u3079\u3066\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F\u30B5\u30A4\u30C8\u3054\u3068\u306E\u8A31\u53EF\u8A2D\u5B9A\u306F\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "Reset all saved site permissions to Ask next time?": "\u4FDD\u5B58\u6E08\u307F\u306E\u6A29\u9650\u3092\u3059\u3079\u3066\u300C\u6B21\u56DE\u78BA\u8A8D\u300D\u306B\u623B\u3057\u307E\u3059\u304B\uFF1F",
  "Delete this tab's browsing history and detailed recovery data?": "\u3053\u306E\u30BF\u30D6\u306E\u95B2\u89A7\u5C65\u6B74\u3068\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Remove this closed tab's browsing history and detailed recovery data?": "\u3053\u306E\u9589\u3058\u305F\u30BF\u30D6\u306E\u95B2\u89A7\u5C65\u6B74\u3068\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete web history recorded in {v0}?": "{v0}\u306E\u95B2\u89A7\u5C65\u6B74\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete {v0} visit(s) from this path?": "\u3053\u306E\u7D4C\u8DEF\u306E{v0}\u4EF6\u306E\u8A2A\u554F\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Delete \u201C{v0}\u201D from browser history?": "\u300C{v0}\u300D\u3092\u30D6\u30E9\u30A6\u30B6\u5C65\u6B74\u304B\u3089\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "No browser history yet.": "\u95B2\u89A7\u5C65\u6B74\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093\u3002",
  "No history yet": "\u5C65\u6B74\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093",
  "No history matches these filters.": "\u3053\u306E\u6761\u4EF6\u306B\u4E00\u81F4\u3059\u308B\u5C65\u6B74\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "No matching visits": "\u4E00\u81F4\u3059\u308B\u8A2A\u554F\u304C\u3042\u308A\u307E\u305B\u3093",
  "Try clearing one or more filters.": "\u7D5E\u308A\u8FBC\u307F\u6761\u4EF6\u3092\u6E1B\u3089\u3057\u3066\u307F\u3066\u304F\u3060\u3055\u3044\u3002",
  "No vault files found": "Vault\u306E\u30D5\u30A1\u30A4\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093",
  "Visited web pages will appear here without creating artificial gaps for idle time.": "\u8A2A\u554F\u3057\u305F\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u304C\u3053\u3053\u306B\u8868\u793A\u3055\u308C\u307E\u3059\u3002\u64CD\u4F5C\u3057\u3066\u3044\u306A\u3044\u6642\u9593\u306B\u3088\u308B\u4F59\u5206\u306A\u7A7A\u767D\u306F\u5165\u308A\u307E\u305B\u3093\u3002",
  "Alternate path \xB7 {v0} visit{v1}": "\u5206\u5C90\u3057\u305F\u7D4C\u8DEF\u30FB{v0}\u4EF6\u306E\u8A2A\u554F",
  "Show redirects and reloads": "\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3068\u518D\u8AAD\u307F\u8FBC\u307F\u3092\u8868\u793A",
  "Show {v0} reload, redirect, or navigation event{v1}": "{v0}\u4EF6\u306E\u518D\u8AAD\u307F\u8FBC\u307F\u30FB\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u30FB\u79FB\u52D5\u3092\u8868\u793A",
  "{v0} visit{v1} across {v2} day{v3}{v4}{v5}": "{v2}\u65E5\u9593\u30FB{v0}\u4EF6\u306E\u8A2A\u554F{v4}{v5}",
  "{v0} deleted histor{v1} retained to preserve navigation paths{v2}": "\u79FB\u52D5\u7D4C\u8DEF\u3092\u4FDD\u3064\u305F\u3081\u3001\u524A\u9664\u6E08\u307F\u5C65\u6B74{v0}\u4EF6\u3092\u4FDD\u6301{v2}",
  "Keep recovery data": "\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u4FDD\u6301",
  "Use normal recovery retention": "\u901A\u5E38\u306E\u4FDD\u5B58\u671F\u9593\u306B\u623B\u3059",
  "Restore in original container": "\u5143\u306EContainer\u3067\u5FA9\u5143",
  "Original container deleted": "\u5143\u306EContainer\u306F\u524A\u9664\u3055\u308C\u3066\u3044\u307E\u3059",
  "Detailed recovery data for this tab will be kept until you remove it.": "\u3053\u306E\u30BF\u30D6\u306E\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u624B\u52D5\u3067\u524A\u9664\u3059\u308B\u307E\u3067\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "Detailed recovery data for this tab will use normal retention again.": "\u3053\u306E\u30BF\u30D6\u306E\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u901A\u5E38\u306E\u4FDD\u5B58\u671F\u9593\u306B\u623B\u3057\u307E\u3057\u305F\u3002",
  "Old tabs will still reopen from durable URLs, but high-fidelity closed-tab restoration will be lost.": "\u53E4\u3044\u30BF\u30D6\u306FURL\u304B\u3089\u958B\u304D\u76F4\u305B\u307E\u3059\u304C\u3001\u8A73\u7D30\u306A\u72B6\u614B\u306E\u5FA9\u5143\u306F\u3067\u304D\u306A\u304F\u306A\u308A\u307E\u3059\u3002",
  "Disabled for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u3067\u306F\u7121\u52B9",
  "Reset site": "\u30B5\u30A4\u30C8\u306E\u8A2D\u5B9A\u3092\u30EA\u30BB\u30C3\u30C8",
  "Reset form recovery for site": "\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u30EA\u30BB\u30C3\u30C8",
  "Reset form recovery for {v0}? This also deletes saved form recovery data for this site.": "{v0}\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u8A2D\u5B9A\u3092\u30EA\u30BB\u30C3\u30C8\u3057\u307E\u3059\u304B\uFF1F\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u3082\u524A\u9664\u3057\u307E\u3059\u3002",
  "No matching fields were found for the saved form values.": "\u4FDD\u5B58\u5185\u5BB9\u306B\u5BFE\u5FDC\u3059\u308B\u5165\u529B\u6B04\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "No matching saved value was found for this field.": "\u3053\u306E\u5165\u529B\u6B04\u306B\u5BFE\u5FDC\u3059\u308B\u4FDD\u5B58\u5185\u5BB9\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "Restored the previous value for this field.": "\u3053\u306E\u5165\u529B\u6B04\u306E\u524D\u56DE\u306E\u5185\u5BB9\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002",
  "Restored {v0} browser tab(s).": "{v0}\u500B\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002",
  "Restored {v0} form field(s).{v1}": "{v0}\u500B\u306E\u5165\u529B\u6B04\u3092\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002{v1}",
  "{v0} excluded field(s)": "{v0}\u500B\u306E\u5165\u529B\u6B04\u3092\u9664\u5916",
  "{v0} is requesting \u201C{v1}\u201D.": "{v0}\u304C\u300C{v1}\u300D\u306E\u8A31\u53EF\u3092\u6C42\u3081\u3066\u3044\u307E\u3059\u3002",
  "Waiting\u2026": "\u5F85\u6A5F\u4E2D\u2026",
  "Loaded": "\u8AAD\u307F\u8FBC\u307F\u5B8C\u4E86",
  "Load failed": "\u8AAD\u307F\u8FBC\u307F\u5931\u6557",
  "Stopped": "\u505C\u6B62",
  "Restored": "\u5FA9\u5143\u6E08\u307F",
  "Open link": "\u30EA\u30F3\u30AF\u3092\u958B\u304F",
  "Open link in new tab": "\u30EA\u30F3\u30AF\u3092\u65B0\u3057\u3044\u30BF\u30D6\u3067\u958B\u304F",
  "Open link in background tab": "\u30EA\u30F3\u30AF\u3092\u80CC\u9762\u306E\u30BF\u30D6\u3067\u958B\u304F",
  "Open link in new window": "\u30EA\u30F3\u30AF\u3092\u65B0\u3057\u3044\u30A6\u30A3\u30F3\u30C9\u30A6\u3067\u958B\u304F",
  "Copy link address": "\u30EA\u30F3\u30AF\u306E\u30A2\u30C9\u30EC\u30B9\u3092\u30B3\u30D4\u30FC",
  "Bookmark link": "\u30EA\u30F3\u30AF\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Open image in new tab": "\u753B\u50CF\u3092\u65B0\u3057\u3044\u30BF\u30D6\u3067\u958B\u304F",
  "Copy image": "\u753B\u50CF\u3092\u30B3\u30D4\u30FC",
  "Copy image address": "\u753B\u50CF\u306E\u30A2\u30C9\u30EC\u30B9\u3092\u30B3\u30D4\u30FC",
  "Save image": "\u753B\u50CF\u3092\u4FDD\u5B58",
  "Save image as\u2026": "\u540D\u524D\u3092\u4ED8\u3051\u3066\u753B\u50CF\u3092\u4FDD\u5B58\u2026",
  "Camera": "\u30AB\u30E1\u30E9",
  "Microphone": "\u30DE\u30A4\u30AF",
  "Camera and microphone": "\u30AB\u30E1\u30E9\u3068\u30DE\u30A4\u30AF",
  "Location": "\u4F4D\u7F6E\u60C5\u5831",
  "Notifications": "\u901A\u77E5",
  "Screen capture": "\u753B\u9762\u5171\u6709",
  "Read clipboard": "\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u306E\u8AAD\u307F\u53D6\u308A",
  "Write clipboard": "\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u3078\u306E\u66F8\u304D\u8FBC\u307F",
  "Pointer lock": "\u30DE\u30A6\u30B9\u30DD\u30A4\u30F3\u30BF\u30FC\u306E\u56FA\u5B9A",
  "Full screen": "\u5168\u753B\u9762\u8868\u793A",
  "Open external links": "\u5916\u90E8\u30EA\u30F3\u30AF\u3092\u958B\u304F",
  "Site storage access": "\u30B5\u30A4\u30C8\u306E\u30B9\u30C8\u30EC\u30FC\u30B8\u3078\u306E\u30A2\u30AF\u30BB\u30B9",
  "Top-level storage access": "\u6700\u4E0A\u4F4D\u30B5\u30A4\u30C8\u306E\u30B9\u30C8\u30EC\u30FC\u30B8\u3078\u306E\u30A2\u30AF\u30BB\u30B9",
  "Audio output devices": "\u97F3\u58F0\u51FA\u529B\u30C7\u30D0\u30A4\u30B9",
  "Keyboard lock": "\u30AD\u30FC\u30DC\u30FC\u30C9\u306E\u56FA\u5B9A",
  "Add": "\u8FFD\u52A0",
  "Clear": "\u6D88\u53BB",
  "Search": "\u691C\u7D22",
  "Settings": "\u8A2D\u5B9A",
  "Restore": "\u5FA9\u5143",
  "Reveal": "\u8868\u793A",
  "Copy": "\u30B3\u30D4\u30FC",
  "Cut": "\u5207\u308A\u53D6\u308A",
  "Paste": "\u8CBC\u308A\u4ED8\u3051",
  "Select all": "\u3059\u3079\u3066\u9078\u629E",
  "Paste and go": "\u8CBC\u308A\u4ED8\u3051\u3066\u958B\u304F",
  "Allow": "\u8A31\u53EF",
  "Block": "\u62D2\u5426",
  "Ask next time": "\u6B21\u56DE\u78BA\u8A8D",
  "Not now": "\u4ECA\u56DE\u306F\u62D2\u5426",
  "Dismiss": "\u9589\u3058\u308B",
  "Address and search": "\u30A2\u30C9\u30EC\u30B9\u30FB\u691C\u7D22",
  "Ready": "\u6E96\u5099\u5B8C\u4E86",
  "Web": "\u30A6\u30A7\u30D6",
  "Vault": "Vault",
  "Vault files": "Vault\u306E\u30D5\u30A1\u30A4\u30EB",
  "Browser startup": "\u30D6\u30E9\u30A6\u30B6\u306E\u8D77\u52D5",
  "Browser back": "\u30D6\u30E9\u30A6\u30B6\u3067\u623B\u308B",
  "Browser forward": "\u30D6\u30E9\u30A6\u30B6\u3067\u9032\u3080",
  "Browser zoom in": "\u30D6\u30E9\u30A6\u30B6\u3092\u62E1\u5927",
  "Browser zoom out": "\u30D6\u30E9\u30A6\u30B6\u3092\u7E2E\u5C0F",
  "Reset browser zoom for site": "\u30B5\u30A4\u30C8\u306E\u30BA\u30FC\u30E0\u3092\u30EA\u30BB\u30C3\u30C8",
  "Default Home search": "\u30DB\u30FC\u30E0\u306E\u65E2\u5B9A\u306E\u691C\u7D22",
  "Home search mode": "\u30DB\u30FC\u30E0\u306E\u691C\u7D22\u65B9\u6CD5",
  "Web search engine": "\u691C\u7D22\u30A8\u30F3\u30B8\u30F3",
  "Custom": "\u30AB\u30B9\u30BF\u30E0",
  "Use Browser Core tab layout": "Browser Core\u306E\u30BF\u30D6\u914D\u7F6E\u3092\u4F7F\u3046",
  "Replace new empty tabs with Home": "\u7A7A\u306E\u65B0\u898F\u30BF\u30D6\u3092\u30DB\u30FC\u30E0\u306B\u7F6E\u304D\u63DB\u3048\u308B",
  "Apply the selected browser tab style only to panes that contain Browser Core tabs.": "\u30D6\u30E9\u30A6\u30B6\u306E\u30BF\u30D6\u304C\u3042\u308B\u30DA\u30A4\u30F3\u306B\u3001\u9078\u3093\u3060\u30BF\u30D6\u30B9\u30BF\u30A4\u30EB\u3092\u9069\u7528\u3057\u307E\u3059\u3002",
  "Firefox keeps a readable minimum tab width and overflows horizontally. Chrome compresses tabs more aggressively.": "Firefox\u306F\u8AAD\u307F\u3084\u3059\u3044\u5E45\u3092\u4FDD\u3061\u3001\u6A2A\u306B\u30B9\u30AF\u30ED\u30FC\u30EB\u3057\u307E\u3059\u3002Chrome\u306F\u30BF\u30D6\u5E45\u3092\u3088\u308A\u5C0F\u3055\u304F\u3057\u307E\u3059\u3002",
  "A newly created empty Obsidian tab becomes the Browser Core Home surface.": "\u65B0\u3057\u304F\u4F5C\u6210\u3057\u305F\u7A7A\u306E\u30BF\u30D6\u306B\u3001Browser Core\u306E\u30DB\u30FC\u30E0\u3092\u8868\u793A\u3057\u307E\u3059\u3002",
  "Vault searches files in this vault. Web searches the web or opens an address.": "Vault\u3067\u306FVault\u5185\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22\u3057\u307E\u3059\u3002\u30A6\u30A7\u30D6\u3067\u306F\u30A6\u30A7\u30D6\u691C\u7D22\u3084URL\u3092\u958B\u304D\u307E\u3059\u3002",
  "Used when Browser Core treats text as a web search rather than an address.": "\u5165\u529B\u5185\u5BB9\u3092\u30A6\u30A7\u30D6\u691C\u7D22\u3059\u308B\u3068\u304D\u306B\u4F7F\u7528\u3057\u307E\u3059\u3002",
  "Use {query} where the encoded search text should be inserted.": "\u691C\u7D22\u8A9E\u3092\u633F\u5165\u3059\u308B\u4F4D\u7F6E\u306B {query} \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "Uses Obsidian's recent-file list; Browser Core does not maintain a duplicate recent-file database.": "Obsidian\u306E\u6700\u8FD1\u4F7F\u3063\u305F\u30D5\u30A1\u30A4\u30EB\u306E\u4E00\u89A7\u3092\u5229\u7528\u3057\u307E\u3059\u3002",
  "Reads file bookmarks from Obsidian's built-in Bookmarks plugin without mixing them with web bookmarks.": "Obsidian\u6A19\u6E96\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u304B\u3089\u3001\u30D5\u30A1\u30A4\u30EB\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u8AAD\u307F\u53D6\u308A\u307E\u3059\u3002",
  "Choose what happens when Obsidian starts and no browser tabs are already open.": "Obsidian\u8D77\u52D5\u6642\u306B\u30D6\u30E9\u30A6\u30B6\u306E\u30BF\u30D6\u304C\u306A\u3044\u5834\u5408\u306E\u52D5\u4F5C\u3092\u9078\u3073\u307E\u3059\u3002",
  "History & recovery": "\u5C65\u6B74\u3068\u5FA9\u5143",
  "History retention (days)": "\u5C65\u6B74\u306E\u4FDD\u5B58\u65E5\u6570",
  "Automatic history size limit": "\u5C65\u6B74\u306E\u81EA\u52D5\u6574\u7406\u4EF6\u6570",
  "Advanced history and recovery storage": "\u5C65\u6B74\u30FB\u5FA9\u5143\u30C7\u30FC\u30BF\u306E\u8A73\u7D30\u8A2D\u5B9A",
  "Detailed tab recovery retention (days)": "\u8A73\u7D30\u306A\u30BF\u30D6\u5FA9\u5143\u30C7\u30FC\u30BF\u306E\u4FDD\u5B58\u65E5\u6570",
  "Detailed recovery storage limit (MB)": "\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u306E\u4FDD\u5B58\u5BB9\u91CF\uFF08MB\uFF09",
  "Form recovery retention (days)": "\u30D5\u30A9\u30FC\u30E0\u306E\u4FDD\u5B58\u65E5\u6570",
  "Saved form versions per page": "\u30DA\u30FC\u30B8\u3054\u3068\u306E\u30D5\u30A9\u30FC\u30E0\u4FDD\u5B58\u6570",
  "Pages with saved form recovery": "\u30D5\u30A9\u30FC\u30E0\u3092\u4FDD\u5B58\u3059\u308B\u30DA\u30FC\u30B8\u6570",
  "History day boundaries default to 04:00 so late-night work stays together.": "\u65E5\u4ED8\u306F\u65E2\u5B9A\u3067\u5348\u524D4\u6642\u306B\u5207\u308A\u66FF\u308F\u308A\u3001\u6DF1\u591C\u306E\u4F5C\u696D\u3092\u540C\u3058\u65E5\u306B\u307E\u3068\u3081\u307E\u3059\u3002",
  "0 keeps browsing history until you delete it. Protected tab histories are not removed automatically.": "0\u306F\u7121\u671F\u9650\u4FDD\u5B58\u3067\u3059\u3002\u4FDD\u8B77\u3057\u305F\u30BF\u30D6\u306E\u5C65\u6B74\u306F\u81EA\u52D5\u524A\u9664\u3055\u308C\u307E\u305B\u3093\u3002",
  "0 disables size-based cleanup. A positive value allows the oldest closed, unprotected tab histories to be removed when stored history grows past this limit.": "0\u306F\u4EF6\u6570\u306B\u3088\u308B\u6574\u7406\u3092\u7121\u52B9\u306B\u3057\u307E\u3059\u3002\u4E0A\u9650\u3092\u8D85\u3048\u308B\u3068\u3001\u9589\u3058\u305F\u672A\u4FDD\u8B77\u30BF\u30D6\u306E\u53E4\u3044\u5C65\u6B74\u304B\u3089\u6574\u7406\u3057\u307E\u3059\u3002",
  "How long Browser Core should keep extra state that can restore recently closed tabs more accurately.": "\u9589\u3058\u305F\u30BF\u30D6\u3092\u8A73\u3057\u304F\u5FA9\u5143\u3059\u308B\u305F\u3081\u306E\u30C7\u30FC\u30BF\u3092\u4FDD\u5B58\u3059\u308B\u671F\u9593\u3067\u3059\u3002",
  "When this budget is exceeded, older unprotected recovery data may fall back to URL-only reopening.": "\u5BB9\u91CF\u3092\u8D85\u3048\u308B\u3068\u3001\u53E4\u3044\u672A\u4FDD\u8B77\u306E\u5FA9\u5143\u30C7\u30FC\u30BF\u306FURL\u3060\u3051\u306E\u5FA9\u5143\u306B\u306A\u308B\u5834\u5408\u304C\u3042\u308A\u307E\u3059\u3002",
  "Allow form recovery as a feature. Capture remains opt-in per site, and password/payment credentials are excluded.": "\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u6A5F\u80FD\u3092\u6709\u52B9\u306B\u3057\u307E\u3059\u3002\u4FDD\u5B58\u306F\u30B5\u30A4\u30C8\u3054\u3068\u306B\u8A31\u53EF\u3057\u3001\u30D1\u30B9\u30EF\u30FC\u30C9\u3084\u6C7A\u6E08\u60C5\u5831\u306F\u9664\u5916\u3057\u307E\u3059\u3002",
  "How long saved non-credential form values are retained.": "\u8A8D\u8A3C\u60C5\u5831\u3092\u542B\u307E\u306A\u3044\u30D5\u30A9\u30FC\u30E0\u306E\u5165\u529B\u5185\u5BB9\u3092\u4FDD\u5B58\u3059\u308B\u671F\u9593\u3067\u3059\u3002",
  "How many recent recovery versions to keep for one page. Multi-step forms can use values from several versions.": "1\u30DA\u30FC\u30B8\u306B\u4FDD\u5B58\u3059\u308B\u5165\u529B\u5185\u5BB9\u306E\u5C65\u6B74\u6570\u3067\u3059\u3002\u8907\u6570\u6BB5\u968E\u306E\u30D5\u30A9\u30FC\u30E0\u3067\u306F\u3001\u8907\u6570\u306E\u5C65\u6B74\u3092\u5229\u7528\u3067\u304D\u307E\u3059\u3002",
  "Maximum number of distinct pages that may keep form recovery data.": "\u30D5\u30A9\u30FC\u30E0\u306E\u5165\u529B\u5185\u5BB9\u3092\u4FDD\u5B58\u3059\u308B\u30DA\u30FC\u30B8\u6570\u306E\u4E0A\u9650\u3067\u3059\u3002",
  "Deletes all saved non-credential form values without changing which sites have form recovery enabled.": "\u30B5\u30A4\u30C8\u3054\u3068\u306E\u8A31\u53EF\u8A2D\u5B9A\u3092\u4FDD\u3063\u305F\u307E\u307E\u3001\u4FDD\u5B58\u3057\u305F\u30D5\u30A9\u30FC\u30E0\u306E\u5165\u529B\u5185\u5BB9\u3092\u3059\u3079\u3066\u6D88\u53BB\u3057\u307E\u3059\u3002",
  "Deletes browsing history and detailed recovery data for closed tabs. Open tabs stay open.": "\u95B2\u89A7\u5C65\u6B74\u3068\u9589\u3058\u305F\u30BF\u30D6\u306E\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u6D88\u53BB\u3057\u307E\u3059\u3002\u958B\u3044\u3066\u3044\u308B\u30BF\u30D6\u306F\u9589\u3058\u307E\u305B\u3093\u3002",
  "Keeps browsing history, but removes extra state used to restore recently closed tabs more accurately. Open tabs start collecting detailed recovery again after they are reopened.": "\u95B2\u89A7\u5C65\u6B74\u3092\u6B8B\u3057\u3066\u3001\u30BF\u30D6\u306E\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u6D88\u53BB\u3057\u307E\u3059\u3002\u30BF\u30D6\u3092\u958B\u304D\u76F4\u3059\u3068\u518D\u3073\u4FDD\u5B58\u3092\u59CB\u3081\u307E\u3059\u3002",
  "Returns saved site permissions to Ask next time. Container cookies and site storage are not changed.": "\u30B5\u30A4\u30C8\u306E\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u3092\u300C\u6B21\u56DE\u78BA\u8A8D\u300D\u306B\u623B\u3057\u307E\u3059\u3002Cookie\u3068\u30B5\u30A4\u30C8\u30C7\u30FC\u30BF\u306F\u7DAD\u6301\u3057\u307E\u3059\u3002",
  "Cover the web page while a new page starts loading. Off by default to avoid a full-page flash.": "\u65B0\u3057\u3044\u30DA\u30FC\u30B8\u306E\u8AAD\u307F\u8FBC\u307F\u958B\u59CB\u6642\u306B\u3001\u753B\u9762\u5168\u4F53\u3092\u8986\u3044\u307E\u3059\u3002\u753B\u9762\u306E\u3061\u3089\u3064\u304D\u3092\u6291\u3048\u308B\u305F\u3081\u65E2\u5B9A\u3067\u306F\u7121\u52B9\u3067\u3059\u3002",
  "Avoid large transitions, slides and parallax in Browser Core UI.": "\u5927\u304D\u306A\u30A2\u30CB\u30E1\u30FC\u30B7\u30E7\u30F3\u3084\u30B9\u30E9\u30A4\u30C9\u52B9\u679C\u3092\u6E1B\u3089\u3057\u307E\u3059\u3002",
  "Used by sites without a site-specific zoom override.": "\u30BA\u30FC\u30E0\u3092\u500B\u5225\u306B\u8A2D\u5B9A\u3057\u3066\u3044\u306A\u3044\u30B5\u30A4\u30C8\u306B\u4F7F\u7528\u3057\u307E\u3059\u3002",
  "Off uses only the selected default container. Manual keeps other containers available without automatic site routing. Automatic also applies site default rules.": "\u7121\u52B9\u3067\u306F\u65E2\u5B9A\u306EContainer\u3060\u3051\u3092\u4F7F\u7528\u3057\u307E\u3059\u3002\u624B\u52D5\u3067\u306F\u81EA\u5206\u3067\u5207\u308A\u66FF\u3048\u3001\u81EA\u52D5\u3067\u306F\u30B5\u30A4\u30C8\u3054\u3068\u306E\u6307\u5B9A\u3082\u9069\u7528\u3057\u307E\u3059\u3002",
  "Used for new browser tabs, including when container controls are off. Automatic mode may replace it with a site's default container.": "\u65B0\u3057\u3044\u30BF\u30D6\u306B\u4F7F\u7528\u3057\u307E\u3059\u3002Container\u64CD\u4F5C\u304C\u7121\u52B9\u3067\u3082\u9069\u7528\u3055\u308C\u3001\u81EA\u52D5\u30E2\u30FC\u30C9\u3067\u306F\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\u304C\u512A\u5148\u3055\u308C\u307E\u3059\u3002",
  "Separate persistent login and site data": "\u30ED\u30B0\u30A4\u30F3\u72B6\u614B\u3068\u30B5\u30A4\u30C8\u30C7\u30FC\u30BF\u3092\u5206\u3051\u3066\u4FDD\u5B58",
  "Creates a separate persistent login and site data.": "\u30ED\u30B0\u30A4\u30F3\u72B6\u614B\u3068\u30B5\u30A4\u30C8\u30C7\u30FC\u30BF\u3092\u5206\u3051\u305FContainer\u3092\u4F5C\u6210\u3057\u307E\u3059\u3002",
  "Box": "\u7BB1",
  "Personal": "\u500B\u4EBA\u7528",
  "Work": "\u4ED5\u4E8B",
  "Study": "\u5B66\u7FD2",
  "Organization": "\u7D44\u7E54",
  "Protected": "\u4FDD\u8B77",
  "Favorite": "\u304A\u6C17\u306B\u5165\u308A",
  "Browsing data": "\u95B2\u89A7\u30C7\u30FC\u30BF",
  "Site default containers": "\u30B5\u30A4\u30C8\u3054\u3068\u306EContainer",
  "Site default container": "\u3053\u306E\u30B5\u30A4\u30C8\u306EContainer",
  "All containers": "\u3059\u3079\u3066\u306EContainer",
  "Container": "Container",
  "Container\u2026": "Container\u2026",
  "Reopen current page in": "\u3053\u306E\u30DA\u30FC\u30B8\u3092\u5225\u306EContainer\u3067\u958B\u304F",
  "No default container for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\u306F\u3042\u308A\u307E\u305B\u3093",
  "Automatic site defaults are off": "\u30B5\u30A4\u30C8\u3054\u3068\u306E\u81EA\u52D5\u5207\u308A\u66FF\u3048\u306F\u7121\u52B9\u3067\u3059",
  "Forget site default container": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\u3092\u89E3\u9664",
  "Site defaults are only available for web pages": "\u30B5\u30A4\u30C8\u306E\u6307\u5B9A\u306F\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u3067\u5229\u7528\u3067\u304D\u307E\u3059",
  "Clear browsing history": "\u95B2\u89A7\u5C65\u6B74\u3092\u6D88\u53BB",
  "Clear detailed tab recovery": "\u8A73\u7D30\u306A\u30BF\u30D6\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u6D88\u53BB",
  "Clear recovery data": "\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u6D88\u53BB",
  "Clear form data": "\u30D5\u30A9\u30FC\u30E0\u30C7\u30FC\u30BF\u3092\u6D88\u53BB",
  "Clear form recovery data": "\u30D5\u30A9\u30FC\u30E0\u306E\u5FA9\u5143\u30C7\u30FC\u30BF\u3092\u6D88\u53BB",
  "Clear all saved form recovery data": "\u4FDD\u5B58\u6E08\u307F\u30D5\u30A9\u30FC\u30E0\u30C7\u30FC\u30BF\u3092\u3059\u3079\u3066\u6D88\u53BB",
  "Reset permissions": "\u6A29\u9650\u3092\u30EA\u30BB\u30C3\u30C8",
  "Reset site permissions": "\u30B5\u30A4\u30C8\u306E\u6A29\u9650\u3092\u30EA\u30BB\u30C3\u30C8",
  "Site permissions": "\u30B5\u30A4\u30C8\u306E\u6A29\u9650",
  "Site permission": "\u30B5\u30A4\u30C8\u306E\u6A29\u9650",
  "Site permissions are only available for web pages": "\u6A29\u9650\u306E\u8A2D\u5B9A\u306F\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u3067\u5229\u7528\u3067\u304D\u307E\u3059",
  "No saved permissions for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u306F\u3042\u308A\u307E\u305B\u3093",
  "Form recovery by site": "\u30B5\u30A4\u30C8\u3054\u3068\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143",
  "Form recovery is only available for web pages.": "\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u306F\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u3067\u5229\u7528\u3067\u304D\u307E\u3059\u3002",
  "Saved form values": "\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9",
  "Restore form values": "\u5165\u529B\u5185\u5BB9\u3092\u5FA9\u5143",
  "Restore saved form values": "\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u3092\u5FA9\u5143",
  "Restore matching fields": "\u4E00\u81F4\u3059\u308B\u9805\u76EE\u3092\u5FA9\u5143",
  "Reset form recovery for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u30EA\u30BB\u30C3\u30C8",
  "Saved form values are available for this page.": "\u3053\u306E\u30DA\u30FC\u30B8\u306B\u306F\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u304C\u3042\u308A\u307E\u3059\u3002",
  "Dismiss recovery message": "\u5FA9\u5143\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u9589\u3058\u308B",
  "No saved form value is available for this page.": "\u3053\u306E\u30DA\u30FC\u30B8\u306B\u306F\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "No saved form values are available for this page.": "\u3053\u306E\u30DA\u30FC\u30B8\u306B\u306F\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "No saved form values for this page.": "\u3053\u306E\u30DA\u30FC\u30B8\u306E\u4FDD\u5B58\u6E08\u307F\u5165\u529B\u5185\u5BB9\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "Text field": "\u5165\u529B\u6B04",
  "Form recovery disabled and stored form values cleared for this site.": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u7121\u52B9\u306B\u3057\u3001\u4FDD\u5B58\u5185\u5BB9\u3092\u6D88\u53BB\u3057\u307E\u3057\u305F\u3002",
  "Form recovery enabled for this site.": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30D5\u30A9\u30FC\u30E0\u5FA9\u5143\u3092\u6709\u52B9\u306B\u3057\u307E\u3057\u305F\u3002",
  "Could not identify the focused form field.": "\u9078\u629E\u4E2D\u306E\u5165\u529B\u6B04\u3092\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "This form field is excluded from recovery on this site.": "\u3053\u306E\u5165\u529B\u6B04\u3092\u3001\u3053\u306E\u30B5\u30A4\u30C8\u306E\u5FA9\u5143\u5BFE\u8C61\u304B\u3089\u9664\u5916\u3057\u307E\u3057\u305F\u3002",
  "These values were saved for this page. Browser Core restores only fields it can match confidently; ambiguous fields remain unchanged.": "\u3053\u306E\u30DA\u30FC\u30B8\u3067\u4FDD\u5B58\u3057\u305F\u5165\u529B\u5185\u5BB9\u3067\u3059\u3002\u78BA\u5B9F\u306B\u5BFE\u5FDC\u3059\u308B\u5165\u529B\u6B04\u3060\u3051\u3092\u5FA9\u5143\u3057\u307E\u3059\u3002",
  "Allow and Block are remembered for this site in the current container. Not now denies this request without saving a decision.": "\u8A31\u53EF\u30FB\u62D2\u5426\u306F\u3001\u3053\u306EContainer\u5185\u306E\u30B5\u30A4\u30C8\u306B\u4FDD\u5B58\u3057\u307E\u3059\u3002\u300C\u4ECA\u56DE\u306F\u62D2\u5426\u300D\u3067\u306F\u5224\u65AD\u3092\u4FDD\u5B58\u3057\u307E\u305B\u3093\u3002",
  "Browser Core does not save a full live copy of the page. Some page state can only be restored by the browser engine, while saved form values and the website's own drafts are recovered separately.": "\u30DA\u30FC\u30B8\u5168\u4F53\u306E\u52D5\u4F5C\u72B6\u614B\u306F\u4FDD\u5B58\u3055\u308C\u307E\u305B\u3093\u3002\u30D6\u30E9\u30A6\u30B6\u306E\u5FA9\u5143\u3001\u4FDD\u5B58\u6E08\u307F\u30D5\u30A9\u30FC\u30E0\u3001\u30B5\u30A4\u30C8\u5074\u306E\u4E0B\u66F8\u304D\u3092\u5229\u7528\u3057\u307E\u3059\u3002",
  "Detailed tab recovery is not currently available; the page can still be reopened normally.": "\u8A73\u7D30\u306A\u5FA9\u5143\u30C7\u30FC\u30BF\u306F\u3042\u308A\u307E\u305B\u3093\u304C\u3001\u901A\u5E38\u306E\u30DA\u30FC\u30B8\u3068\u3057\u3066\u958B\u304D\u76F4\u305B\u307E\u3059\u3002",
  "Close tab": "\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close browser tab": "\u30D6\u30E9\u30A6\u30B6\u306E\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close current browser tab": "\u73FE\u5728\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close other browser tabs": "\u307B\u304B\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close browser tabs to the left": "\u5DE6\u5074\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close browser tabs to the right": "\u53F3\u5074\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Close unpinned browser tabs": "\u56FA\u5B9A\u3057\u3066\u3044\u306A\u3044\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u9589\u3058\u308B",
  "Duplicate browser tab": "\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u8907\u88FD",
  "Move to new window": "\u65B0\u3057\u3044\u30A6\u30A3\u30F3\u30C9\u30A6\u3078\u79FB\u52D5",
  "Move browser tab to new window": "\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u65B0\u3057\u3044\u30A6\u30A3\u30F3\u30C9\u30A6\u3078\u79FB\u52D5",
  "Next browser tab": "\u6B21\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6",
  "Previous browser tab": "\u524D\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6",
  "Focus browser address bar": "\u30A2\u30C9\u30EC\u30B9\u30D0\u30FC\u3078\u79FB\u52D5",
  "Open browser container picker": "Container\u3092\u9078\u3076",
  "Switch to tab": "\u3053\u306E\u30BF\u30D6\u306B\u5207\u308A\u66FF\u3048",
  "Reopen closed tab": "\u9589\u3058\u305F\u30BF\u30D6\u3092\u958B\u304F",
  "Recently closed browser tabs": "\u6700\u8FD1\u9589\u3058\u305F\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6",
  "Restore previous browser session": "\u524D\u56DE\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u5FA9\u5143",
  "Restore tab": "\u30BF\u30D6\u3092\u5FA9\u5143",
  "Pin restored tab": "\u5FA9\u5143\u3057\u305F\u30BF\u30D6\u3092\u56FA\u5B9A",
  "Restore from here": "\u3053\u3053\u304B\u3089\u5FA9\u5143",
  "Retry restore": "\u5FA9\u5143\u3092\u518D\u8A66\u884C",
  "Recovery details": "\u5FA9\u5143\u306E\u8A73\u7D30",
  "Restore latest page from this path": "\u3053\u306E\u7D4C\u8DEF\u306E\u6700\u5F8C\u306E\u30DA\u30FC\u30B8\u3092\u5FA9\u5143",
  "No recently closed browser tab.": "\u6700\u8FD1\u9589\u3058\u305F\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "No previous browser session is available.": "\u524D\u56DE\u306E\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u306E\u8A18\u9332\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "The previous browser session is already restored.": "\u524D\u56DE\u306E\u30BF\u30D6\u306F\u3059\u3067\u306B\u5FA9\u5143\u3055\u308C\u3066\u3044\u307E\u3059\u3002",
  "This tab has no restorable URL.": "\u3053\u306E\u30BF\u30D6\u306B\u306F\u5FA9\u5143\u3067\u304D\u308BURL\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "This Obsidian build cannot move the tab to a new window.": "\u3053\u306EObsidian\u3067\u306F\u5225\u30A6\u30A3\u30F3\u30C9\u30A6\u3078\u79FB\u52D5\u3067\u304D\u307E\u305B\u3093\u3002",
  "Hard reload": "\u30AD\u30E3\u30C3\u30B7\u30E5\u3092\u4F7F\u308F\u305A\u518D\u8AAD\u307F\u8FBC\u307F",
  "Reload normally": "\u901A\u5E38\u306E\u518D\u8AAD\u307F\u8FBC\u307F",
  "Reload browser page": "\u30D6\u30E9\u30A6\u30B6\u306E\u30DA\u30FC\u30B8\u3092\u518D\u8AAD\u307F\u8FBC\u307F",
  "Bookmark current browser page": "\u73FE\u5728\u306E\u30DA\u30FC\u30B8\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Bookmark all open browser tabs": "\u958B\u3044\u3066\u3044\u308B\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6\u3092\u3059\u3079\u3066\u4FDD\u5B58",
  "There are no web pages to bookmark.": "\u4FDD\u5B58\u3067\u304D\u308B\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "All open web pages are already bookmarked.": "\u958B\u3044\u3066\u3044\u308B\u30DA\u30FC\u30B8\u306F\u3059\u3079\u3066\u4FDD\u5B58\u6E08\u307F\u3067\u3059\u3002",
  "Added to favorites.": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u306B\u8FFD\u52A0\u3057\u307E\u3057\u305F\u3002",
  "That move would create an invalid bookmark-folder cycle.": "\u30D5\u30A9\u30EB\u30C0\u3092\u81EA\u8EAB\u3084\u5B50\u30D5\u30A9\u30EB\u30C0\u306E\u4E2D\u3078\u79FB\u52D5\u3059\u308B\u3053\u3068\u306F\u3067\u304D\u307E\u305B\u3093\u3002",
  "Copy title": "\u540D\u524D\u3092\u30B3\u30D4\u30FC",
  "Copy page title and URL": "\u540D\u524D\u3068URL\u3092\u30B3\u30D4\u30FC",
  "Copy file path": "\u30D5\u30A1\u30A4\u30EB\u306E\u30D1\u30B9\u3092\u30B3\u30D4\u30FC",
  "Copy event details": "\u30A4\u30D9\u30F3\u30C8\u306E\u8A73\u7D30\u3092\u30B3\u30D4\u30FC",
  "Copy tab history": "\u30BF\u30D6\u306E\u5C65\u6B74\u3092\u30B3\u30D4\u30FC",
  "Open history": "\u5C65\u6B74\u3092\u958B\u304F",
  "Show history": "\u5C65\u6B74\u3092\u8868\u793A",
  "Search history": "\u5C65\u6B74\u3092\u691C\u7D22",
  "Search browser history": "\u30D6\u30E9\u30A6\u30B6\u5C65\u6B74\u3092\u691C\u7D22",
  "History for this site": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u5C65\u6B74",
  "Search title, URL, domain, or tab": "\u540D\u524D\u30FBURL\u30FB\u30C9\u30E1\u30A4\u30F3\u30FB\u30BF\u30D6\u3067\u691C\u7D22",
  "Filter history by day": "\u65E5\u4ED8\u3067\u7D5E\u308A\u8FBC\u3080",
  "Filter history by container": "Container\u3067\u7D5E\u308A\u8FBC\u3080",
  "Clear filters": "\u7D5E\u308A\u8FBC\u307F\u3092\u89E3\u9664",
  "Search within this day": "\u3053\u306E\u65E5\u306E\u5C65\u6B74\u3092\u691C\u7D22",
  "Browse visits by day, tab, and alternate path. Filtering only changes what is shown.": "\u65E5\u4ED8\u3001\u30BF\u30D6\u3001\u5206\u5C90\u3057\u305F\u7D4C\u8DEF\u304B\u3089\u95B2\u89A7\u5C65\u6B74\u3092\u898B\u3089\u308C\u307E\u3059\u3002\u7D5E\u308A\u8FBC\u307F\u3067\u306F\u5C65\u6B74\u306F\u524A\u9664\u3055\u308C\u307E\u305B\u3093\u3002",
  "Show alternate paths": "\u5206\u5C90\u3057\u305F\u7D4C\u8DEF\u3092\u8868\u793A",
  "Show alternate path": "\u5206\u5C90\u3057\u305F\u7D4C\u8DEF\u3092\u8868\u793A",
  "Show full tab history": "\u30BF\u30D6\u306E\u5168\u5C65\u6B74\u3092\u8868\u793A",
  "Show in full history": "\u5168\u5C65\u6B74\u3067\u898B\u308B",
  "Hide redirects and reloads": "\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3068\u518D\u8AAD\u307F\u8FBC\u307F\u3092\u96A0\u3059",
  "Expand all alternate paths": "\u3059\u3079\u3066\u306E\u5206\u5C90\u3092\u5C55\u958B",
  "Collapse all alternate paths": "\u3059\u3079\u3066\u306E\u5206\u5C90\u3092\u6298\u308A\u305F\u305F\u3080",
  "Collapse alternate path": "\u5206\u5C90\u3092\u6298\u308A\u305F\u305F\u3080",
  "Open current path in new tabs": "\u73FE\u5728\u306E\u7D4C\u8DEF\u3092\u65B0\u3057\u3044\u30BF\u30D6\u3067\u958B\u304F",
  "Open this path in new tabs": "\u3053\u306E\u7D4C\u8DEF\u3092\u65B0\u3057\u3044\u30BF\u30D6\u3067\u958B\u304F",
  "Open all tabs from this day": "\u3053\u306E\u65E5\u306E\u30BF\u30D6\u3092\u3059\u3079\u3066\u958B\u304F",
  "Reveal this visit in its alternate path": "\u3053\u306E\u8A2A\u554F\u3092\u5206\u5C90\u7D4C\u8DEF\u3067\u8868\u793A",
  "Open redirect source": "\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u5143\u3092\u958B\u304F",
  "Open redirect destination": "\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u5148\u3092\u958B\u304F",
  "Delete alternate path": "\u3053\u306E\u5206\u5C90\u3092\u524A\u9664",
  "Delete history entry": "\u3053\u306E\u5C65\u6B74\u3092\u524A\u9664",
  "Delete tab history": "\u30BF\u30D6\u306E\u5C65\u6B74\u3092\u524A\u9664",
  "Delete this day's history": "\u3053\u306E\u65E5\u306E\u5C65\u6B74\u3092\u524A\u9664",
  "Remove from history": "\u5C65\u6B74\u304B\u3089\u524A\u9664",
  "Deleted history entry": "\u524A\u9664\u3055\u308C\u305F\u5C65\u6B74",
  "Remove deleted entry marker": "\u524A\u9664\u6E08\u307F\u306E\u5370\u3092\u53D6\u308A\u9664\u304F",
  "Recent files": "\u6700\u8FD1\u306E\u30D5\u30A1\u30A4\u30EB",
  "Looking for a Vault file?": "Vault\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u63A2\u3057\u307E\u3059\u304B\uFF1F",
  "Quick Switcher": "\u30AF\u30A4\u30C3\u30AF\u30B9\u30A4\u30C3\u30C1\u30E3\u30FC",
  "Try another name or switch to Web.": "\u5225\u306E\u540D\u524D\u3067\u63A2\u3059\u304B\u3001\u30A6\u30A7\u30D6\u691C\u7D22\u3078\u5207\u308A\u66FF\u3048\u3066\u304F\u3060\u3055\u3044\u3002",
  "Use Obsidian's Quick Switcher for notes and files.": "\u30CE\u30FC\u30C8\u3084\u30D5\u30A1\u30A4\u30EB\u306FObsidian\u306E\u30AF\u30A4\u30C3\u30AF\u30B9\u30A4\u30C3\u30C1\u30E3\u30FC\u3067\u63A2\u305B\u307E\u3059\u3002",
  "Search your vault, browse the web, or continue where you left off.": "Vault\u3092\u691C\u7D22\u3057\u305F\u308A\u3001\u30A6\u30A7\u30D6\u3092\u958B\u3044\u305F\u308A\u3001\u524D\u56DE\u306E\u7D9A\u304D\u3092\u59CB\u3081\u3089\u308C\u307E\u3059\u3002",
  "Open Obsidian Quick Switcher": "Obsidian\u306E\u30AF\u30A4\u30C3\u30AF\u30B9\u30A4\u30C3\u30C1\u30E3\u30FC\u3092\u958B\u304F",
  "Open Browser Core settings": "Browser Core\u306E\u8A2D\u5B9A\u3092\u958B\u304F",
  "Open Obsidian Settings \u2192 Community plugins \u2192 Unified Browser Core.": "Obsidian\u306E\u8A2D\u5B9A \u2192 \u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u30D7\u30E9\u30B0\u30A4\u30F3 \u2192 Unified Browser Core\u3092\u958B\u3044\u3066\u304F\u3060\u3055\u3044\u3002",
  "Obsidian Quick Switcher is not available.": "Obsidian\u306E\u30AF\u30A4\u30C3\u30AF\u30B9\u30A4\u30C3\u30C1\u30E3\u30FC\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002",
  "That file is no longer available.": "\u305D\u306E\u30D5\u30A1\u30A4\u30EB\u306F\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002",
  "Could not open that file.": "\u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3051\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "Import web bookmarks from Obsidian Bookmarks": "Obsidian\u306E\u30A6\u30A7\u30D6\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u53D6\u308A\u8FBC\u3080",
  "Obsidian Bookmarks is unavailable or has no readable bookmark data.": "Obsidian\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u5229\u7528\u3067\u304D\u306A\u3044\u304B\u3001\u8AAD\u307F\u53D6\u308C\u308B\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "Web viewer Bookmarks has no readable data in this vault.": "\u3053\u306EVault\u306BWeb viewer Bookmarks\u306E\u8AAD\u307F\u53D6\u308C\u308B\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  "No Surfing data was found in this vault. Run migration before uninstalling Surfing.": "Surfing\u306E\u30C7\u30FC\u30BF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002Surfing\u3092\u30A2\u30F3\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3059\u308B\u524D\u306B\u79FB\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "Surfing data could not be read safely. No changes were made.": "Surfing\u306E\u30C7\u30FC\u30BF\u3092\u5B89\u5168\u306B\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5909\u66F4\u306F\u884C\u3063\u3066\u3044\u307E\u305B\u3093\u3002",
  "Surfing migration stopped. Source data was not deleted; run the command again to resume.": "\u79FB\u884C\u3092\u4E2D\u65AD\u3057\u307E\u3057\u305F\u3002\u5143\u30C7\u30FC\u30BF\u306F\u524A\u9664\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002\u3082\u3046\u4E00\u5EA6\u5B9F\u884C\u3059\u308B\u3068\u518D\u958B\u3067\u304D\u307E\u3059\u3002",
  "Close or reopen tabs using this container before deleting it.": "\u524A\u9664\u3059\u308B\u524D\u306B\u3001\u3053\u306EContainer\u306E\u30BF\u30D6\u3092\u9589\u3058\u308B\u304B\u5225\u306EContainer\u3067\u958B\u3044\u3066\u304F\u3060\u3055\u3044\u3002",
  "Could not clear this container's browsing data, so the container was not deleted.": "\u95B2\u89A7\u30C7\u30FC\u30BF\u3092\u6D88\u53BB\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001Container\u3092\u524A\u9664\u3057\u3066\u3044\u307E\u305B\u3093\u3002",
  "Open new tab in this container": "\u3053\u306EContainer\u3067\u65B0\u3057\u3044\u30BF\u30D6\u3092\u958B\u304F",
  "Language": "\u8868\u793A\u8A00\u8A9E",
  "Follow Obsidian": "Obsidian\u306B\u5408\u308F\u305B\u308B",
  "English": "\u82F1\u8A9E",
  "Japanese": "\u65E5\u672C\u8A9E",
  "Choose the language used by Browser Core.": "Browser Core\u306E\u8868\u793A\u8A00\u8A9E\u3092\u9078\u3073\u307E\u3059\u3002",
  "Bookmarks": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Bookmark": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Bookmark page": "\u3053\u306E\u30DA\u30FC\u30B8\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Bookmark this page": "\u3053\u306E\u30DA\u30FC\u30B8\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Edit bookmark": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u7DE8\u96C6",
  "Bookmark saved": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F",
  "New bookmark": "\u65B0\u3057\u3044\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "New folder": "\u65B0\u3057\u3044\u30D5\u30A9\u30EB\u30C0",
  "Bookmark bar": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D0\u30FC",
  "Selected members": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC",
  "Favorites bar": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D0\u30FC",
  "Show bookmark bar": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D0\u30FC\u3092\u8868\u793A",
  "Bookmark bar display": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D0\u30FC\u306E\u8868\u793A\u5185\u5BB9",
  "Choose every bookmark and folder, or just the members you select.": "\u5168\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3068\u30D5\u30A9\u30EB\u30C0\u3001\u307E\u305F\u306F\u9078\u629C\u3057\u305F\u30E1\u30F3\u30D0\u30FC\u3092\u8868\u793A\u3057\u307E\u3059\u3002",
  "All bookmarks": "\u3059\u3079\u3066\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Choose members": "\u30E1\u30F3\u30D0\u30FC\u3092\u9078\u3076",
  "Show in selected members": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u306B\u8868\u793A",
  "Pick the pages you use every day from your bookmarks.": "\u6BCE\u65E5\u4F7F\u3046\u30DA\u30FC\u30B8\u3092\u3001\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u4E2D\u304B\u3089\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002",
  "Your everyday pages, one click away.": "\u3044\u3064\u3082\u306E\u30DA\u30FC\u30B8\u3078\u3001\u30EF\u30F3\u30AF\u30EA\u30C3\u30AF\u3002",
  "Save freely. Find what you need by type or folder.": "\u6C17\u8EFD\u306B\u4FDD\u5B58\u3057\u3066\u3001\u7A2E\u985E\u3084\u30D5\u30A9\u30EB\u30C0\u304B\u3089\u898B\u3064\u3051\u307E\u3057\u3087\u3046\u3002",
  "Organize by": "\u8868\u793A\u65B9\u6CD5",
  "By type": "\u7A2E\u985E\u5225",
  "By folder": "\u30D5\u30A9\u30EB\u30C0\u5225",
  "Folders": "\u30D5\u30A9\u30EB\u30C0",
  "References": "\u8CC7\u6599",
  "Video": "\u52D5\u753B",
  "Audio": "\u97F3\u58F0",
  "Images": "\u753B\u50CF",
  "Documents": "\u6587\u66F8\u30FB\u30D5\u30A1\u30A4\u30EB",
  "Mail": "\u30E1\u30FC\u30EB",
  "Blogs": "\u30D6\u30ED\u30B0",
  "Forums": "\u63B2\u793A\u677F",
  "Websites": "\u30A6\u30A7\u30D6\u30B5\u30A4\u30C8",
  "Media type": "\u7A2E\u985E",
  "Automatic": "\u81EA\u52D5",
  "Automatic classification": "\u81EA\u52D5\u5206\u985E",
  "Detected: {type}": "\u81EA\u52D5\u5224\u5B9A\uFF1A{type}",
  "Change the type if automatic classification is incorrect.": "\u81EA\u52D5\u5206\u985E\u304C\u5408\u308F\u306A\u3044\u3068\u304D\u306F\u3001\u7A2E\u985E\u3092\u5909\u66F4\u3067\u304D\u307E\u3059\u3002",
  "{count} bookmarks": "{count}\u4EF6\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "{count} selected": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC {count}\u4EF6",
  "{count} folders": "{count}\u500B\u306E\u30D5\u30A9\u30EB\u30C0",
  "{count} results": "{count}\u4EF6\u306E\u691C\u7D22\u7D50\u679C",
  "No bookmarks yet": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u96C6\u3081\u307E\u3057\u3087\u3046",
  "No matching bookmarks": "\u4E00\u81F4\u3059\u308B\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u304C\u3042\u308A\u307E\u305B\u3093",
  "Save a page with the star in the toolbar, or add your first bookmark here.": "\u30C4\u30FC\u30EB\u30D0\u30FC\u306E\u661F\u304B\u3089\u30DA\u30FC\u30B8\u3092\u4FDD\u5B58\u3059\u308B\u304B\u3001\u3053\u3053\u304B\u3089\u6700\u521D\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u8FFD\u52A0\u3067\u304D\u307E\u3059\u3002",
  "Try another title, URL, or folder name.": "\u5225\u306E\u540D\u524D\u3001URL\u3001\u30D5\u30A9\u30EB\u30C0\u540D\u3067\u691C\u7D22\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "Search bookmarks": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u691C\u7D22",
  "Name, URL, folder or tag": "\u540D\u524D\u30FBURL\u30FB\u30D5\u30A9\u30EB\u30C0\u30FB\u30BF\u30B0\u3067\u691C\u7D22",
  "Import": "\u53D6\u308A\u8FBC\u3080",
  "Import Obsidian Bookmarks": "Obsidian\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u53D6\u308A\u8FBC\u3080",
  "Import Web viewer Bookmarks": "Web viewer Bookmarks\u304B\u3089\u53D6\u308A\u8FBC\u3080",
  "Details": "\u8A73\u7D30",
  "Title": "\u540D\u524D",
  "Bookmark title": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u540D\u524D",
  "Bookmark URL": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306EURL",
  "Description": "\u8AAC\u660E",
  "Bookmark description": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u8AAC\u660E",
  "Tags": "\u30BF\u30B0",
  "Bookmark tags": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u30BF\u30B0",
  "Separate tags with spaces": "\u30BF\u30B0\u3092\u7A7A\u767D\u3067\u533A\u5207\u308B",
  "Save in": "\u4FDD\u5B58\u5148",
  "Bookmarks root": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u4E00\u89A7",
  "Choose bookmark folder": "\u4FDD\u5B58\u5148\u306E\u30D5\u30A9\u30EB\u30C0\u3092\u9078\u3076",
  "New bookmark folder": "\u65B0\u3057\u3044\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D5\u30A9\u30EB\u30C0",
  "Folder name": "\u30D5\u30A9\u30EB\u30C0\u540D",
  "Bookmark image": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u30A2\u30A4\u30B3\u30F3",
  "Bookmark image type": "\u30A2\u30A4\u30B3\u30F3\u306E\u7A2E\u985E",
  "Website favicon": "\u30B5\u30A4\u30C8\u306E\u30A2\u30A4\u30B3\u30F3",
  "Custom image": "\u753B\u50CF\u3092\u6307\u5B9A",
  "Custom text": "\u6587\u5B57\u3092\u6307\u5B9A",
  "Lucide icon": "Lucide\u30A2\u30A4\u30B3\u30F3",
  "Custom value": "\u753B\u50CF\u30FB\u6587\u5B57\u30FB\u30A2\u30A4\u30B3\u30F3\u540D",
  "Custom bookmark image or text": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u306E\u753B\u50CF\u3084\u6587\u5B57",
  "Preview": "\u30D7\u30EC\u30D3\u30E5\u30FC",
  "Save": "\u4FDD\u5B58",
  "Cancel": "\u30AD\u30E3\u30F3\u30BB\u30EB",
  "Done": "\u5B8C\u4E86",
  "Close": "\u9589\u3058\u308B",
  "Delete": "\u524A\u9664",
  "Delete bookmark": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u524A\u9664",
  "Remove bookmark": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u524A\u9664",
  "Edit": "\u7DE8\u96C6",
  "Move": "\u79FB\u52D5",
  "Move to folder": "\u30D5\u30A9\u30EB\u30C0\u3078\u79FB\u52D5",
  "Rename": "\u540D\u524D\u3092\u5909\u66F4",
  "Rename bookmark folder": "\u30D5\u30A9\u30EB\u30C0\u306E\u540D\u524D\u3092\u5909\u66F4",
  "Delete folder": "\u30D5\u30A9\u30EB\u30C0\u3092\u524A\u9664",
  "Delete bookmark folder": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D5\u30A9\u30EB\u30C0\u3092\u524A\u9664",
  "Delete \u201C{title}\u201D from your bookmarks?": "\u300C{title}\u300D\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u304B\u3089\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F",
  "Open": "\u958B\u304F",
  "Open in new tab": "\u65B0\u3057\u3044\u30BF\u30D6\u3067\u958B\u304F",
  "Open all": "\u3059\u3079\u3066\u958B\u304F",
  "Open all in new tabs": "\u65B0\u3057\u3044\u30BF\u30D6\u3067\u3059\u3079\u3066\u958B\u304F",
  "Copy URL": "URL\u3092\u30B3\u30D4\u30FC",
  "Copy page URL": "\u30DA\u30FC\u30B8\u306EURL\u3092\u30B3\u30D4\u30FC",
  "URL copied.": "URL\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\u3002",
  "Show in history": "\u5C65\u6B74\u3067\u898B\u308B",
  "View page in history": "\u3053\u306E\u30DA\u30FC\u30B8\u306E\u5C65\u6B74\u3092\u898B\u308B",
  "Sort contents": "\u540D\u524D\u9806\u306B\u4E26\u3079\u308B",
  "Add to favorites": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u306B\u8FFD\u52A0",
  "Remove from favorites": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u304B\u3089\u5916\u3059",
  "Show in favorites bar": "\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u306B\u8868\u793A",
  "Add current page to favorites": "\u3053\u306E\u30DA\u30FC\u30B8\u3092\u9078\u629C\u30E1\u30F3\u30D0\u30FC\u306B\u8FFD\u52A0",
  "Hide favorites bar": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u30D0\u30FC\u3092\u975E\u8868\u793A",
  "Open bookmarks": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u958B\u304F",
  "Show bookmarks": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u8868\u793A",
  "Initial background color override": "\u521D\u671F\u80CC\u666F\u8272\u306E\u4E0A\u66F8\u304D",
  "Use the Obsidian theme background before a page is painted. Turn off to use the browser's own background.": "\u30DA\u30FC\u30B8\u63CF\u753B\u524D\u306E\u80CC\u666F\u306BObsidian\u306E\u30C6\u30FC\u30DE\u8272\u3092\u4F7F\u3044\u307E\u3059\u3002\u7121\u52B9\u306B\u3059\u308B\u3068\u30D6\u30E9\u30A6\u30B6\u672C\u6765\u306E\u80CC\u666F\u306B\u306A\u308A\u307E\u3059\u3002",
  "Tab style": "\u30BF\u30D6\u306E\u30B9\u30BF\u30A4\u30EB",
  "Integrate with Obsidian tab strips": "Obsidian\u306E\u30BF\u30D6\u30D0\u30FC\u3068\u7D71\u5408",
  "Replace empty tabs with Home": "\u7A7A\u306E\u30BF\u30D6\u3092\u30DB\u30FC\u30E0\u306B\u7F6E\u304D\u63DB\u3048\u308B",
  "Default search engine": "\u65E2\u5B9A\u306E\u691C\u7D22\u30A8\u30F3\u30B8\u30F3",
  "Custom search URL": "\u691C\u7D22URL\u3092\u6307\u5B9A",
  "Home": "\u30DB\u30FC\u30E0",
  "History": "\u5C65\u6B74",
  "Home search": "\u30DB\u30FC\u30E0\u306E\u691C\u7D22",
  "Show recent Vault files on Home": "\u6700\u8FD1\u306EVault\u30D5\u30A1\u30A4\u30EB\u3092\u30DB\u30FC\u30E0\u306B\u8868\u793A",
  "Show bookmarked Vault files on Home": "Vault\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u30DB\u30FC\u30E0\u306B\u8868\u793A",
  "Migration": "\u79FB\u884C",
  "Migrate from Surfing": "Surfing\u304B\u3089\u79FB\u884C",
  "Preview and migrate": "\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u79FB\u884C",
  "Resume migration": "\u79FB\u884C\u3092\u518D\u958B",
  "Migrated": "\u79FB\u884C\u6E08\u307F",
  "Startup": "\u8D77\u52D5\u6642",
  "Startup behavior": "\u8D77\u52D5\u6642\u306E\u52D5\u4F5C",
  "Restore previous session": "\u524D\u56DE\u306E\u30BF\u30D6\u3092\u5FA9\u5143",
  "Open Home": "\u30DB\u30FC\u30E0\u3092\u958B\u304F",
  "Do nothing": "\u4F55\u3082\u3057\u306A\u3044",
  "None": "\u306A\u3057",
  "Off": "\u7121\u52B9",
  "Manual": "\u624B\u52D5",
  "Containers": "Container",
  "Container use": "Container\u306E\u5229\u7528",
  "Default container": "\u65E2\u5B9A\u306EContainer",
  "Add container": "Container\u3092\u8FFD\u52A0",
  "Container name": "Container\u540D",
  "Clear browsing data and saved permissions": "\u95B2\u89A7\u30C7\u30FC\u30BF\u3068\u4FDD\u5B58\u6E08\u307F\u6A29\u9650\u3092\u6D88\u53BB",
  "Delete container": "Container\u3092\u524A\u9664",
  "Clear browsing data": "\u95B2\u89A7\u30C7\u30FC\u30BF\u3092\u6D88\u53BB",
  "Manage containers": "Container\u3092\u7BA1\u7406",
  "Appearance": "\u8868\u793A",
  "Reduced motion": "\u30A2\u30CB\u30E1\u30FC\u30B7\u30E7\u30F3\u3092\u6E1B\u3089\u3059",
  "Default web content zoom": "\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u306E\u65E2\u5B9A\u306E\u30BA\u30FC\u30E0",
  "Full-page loading shield": "\u8AAD\u307F\u8FBC\u307F\u4E2D\u306E\u5168\u9762\u30B7\u30FC\u30EB\u30C9",
  "Permissions": "\u6A29\u9650",
  "Site permissions\u2026": "\u30B5\u30A4\u30C8\u306E\u6A29\u9650\u2026",
  "Form recovery": "\u30D5\u30A9\u30FC\u30E0\u306E\u5FA9\u5143",
  "Enable form recovery": "\u30D5\u30A9\u30FC\u30E0\u306E\u5FA9\u5143\u3092\u6709\u52B9\u306B\u3059\u308B",
  "History retention": "\u5C65\u6B74\u306E\u4FDD\u5B58",
  "History day starts at": "\u5C65\u6B74\u306E\u65E5\u4ED8\u306E\u5207\u308A\u66FF\u3048\u6642\u523B",
  "History retention days": "\u5C65\u6B74\u306E\u4FDD\u5B58\u65E5\u6570",
  "History node limit": "\u5C65\u6B74\u306E\u4FDD\u5B58\u4EF6\u6570",
  "Closed-tab recovery": "\u9589\u3058\u305F\u30BF\u30D6\u306E\u5FA9\u5143",
  "Recovery retention days": "\u5FA9\u5143\u30C7\u30FC\u30BF\u306E\u4FDD\u5B58\u65E5\u6570",
  "Recovery storage limit": "\u5FA9\u5143\u30C7\u30FC\u30BF\u306E\u4FDD\u5B58\u5BB9\u91CF",
  "Clear history": "\u5C65\u6B74\u3092\u6D88\u53BB",
  "Back": "\u623B\u308B",
  "Forward": "\u9032\u3080",
  "Reload": "\u518D\u8AAD\u307F\u8FBC\u307F",
  "Stop loading": "\u8AAD\u307F\u8FBC\u307F\u3092\u505C\u6B62",
  "Open home": "\u30DB\u30FC\u30E0\u3092\u958B\u304F",
  "Search browser tabs": "\u30D6\u30E9\u30A6\u30B6\u306E\u30BF\u30D6\u3092\u691C\u7D22",
  "Open Quick Switcher": "\u30AF\u30A4\u30C3\u30AF\u30B9\u30A4\u30C3\u30C1\u30E3\u30FC\u3092\u958B\u304F",
  "Zoom in": "\u62E1\u5927",
  "Zoom out": "\u7E2E\u5C0F",
  "Reset site zoom": "\u3053\u306E\u30B5\u30A4\u30C8\u306E\u30BA\u30FC\u30E0\u3092\u30EA\u30BB\u30C3\u30C8",
  "Inspect page": "\u958B\u767A\u8005\u30C4\u30FC\u30EB\u3092\u958B\u304F",
  "Browser menu": "\u30D6\u30E9\u30A6\u30B6\u30E1\u30CB\u30E5\u30FC",
  "New browser tab": "\u65B0\u3057\u3044\u30D6\u30E9\u30A6\u30B6\u30BF\u30D6",
  "Search the web": "\u30A6\u30A7\u30D6\u3092\u691C\u7D22",
  "Search Vault": "Vault\u3092\u691C\u7D22",
  "Web bookmarks": "\u30A6\u30A7\u30D6\u306E\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF",
  "Recently opened files": "\u6700\u8FD1\u958B\u3044\u305F\u30D5\u30A1\u30A4\u30EB",
  "Bookmarked files": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3057\u305F\u30D5\u30A1\u30A4\u30EB",
  "Loading\u2026": "\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026",
  "Offline": "\u30AA\u30D5\u30E9\u30A4\u30F3",
  "Page could not be loaded": "\u30DA\u30FC\u30B8\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093\u3067\u3057\u305F",
  "Open browser": "\u30D6\u30E9\u30A6\u30B6\u3092\u958B\u304F",
  "Open browser history": "\u30D6\u30E9\u30A6\u30B6\u306E\u5C65\u6B74\u3092\u958B\u304F",
  "Open browser bookmarks": "\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u958B\u304F",
  "Migrate browsing data from Surfing": "Surfing\u306E\u95B2\u89A7\u30C7\u30FC\u30BF\u3092\u79FB\u884C",
  "Import bookmarks from Web viewer Bookmarks": "Web viewer Bookmarks\u304B\u3089\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF\u3092\u53D6\u308A\u8FBC\u3080",
  "Reopen last closed browser tab": "\u6700\u5F8C\u306B\u9589\u3058\u305F\u30BF\u30D6\u3092\u958B\u304F",
  "Bookmark current page": "\u73FE\u5728\u306E\u30DA\u30FC\u30B8\u3092\u30D6\u30C3\u30AF\u30DE\u30FC\u30AF"
};

// src/core/session-restore.ts
function cloneSessionCheckpoint(checkpoint) {
  return {
    capturedAt: checkpoint.capturedAt,
    leaves: checkpoint.leaves.map((leaf) => ({
      ...leaf,
      transientHistory: leaf.transientHistory?.map((entry) => ({ ...entry }))
    }))
  };
}
function pendingSessionLeaves(checkpoint, live) {
  const represented = /* @__PURE__ */ new Set();
  for (const item of live) {
    represented.add(item.lifecycleId);
    if (item.restoredFromLeafId) represented.add(item.restoredFromLeafId);
  }
  const seen = /* @__PURE__ */ new Set();
  const pending = [];
  for (const leaf of checkpoint.leaves) {
    if (represented.has(leaf.sourceLifecycleId) || seen.has(leaf.sourceLifecycleId)) continue;
    seen.add(leaf.sourceLifecycleId);
    pending.push(leaf);
  }
  return pending;
}

// src/tabs/tab-layout-policy.ts
var PRESETS = {
  firefox: {
    preferredWidth: 180,
    minimumWidth: 110,
    maximumWidth: 240,
    flexGrow: 0,
    flexShrink: 1,
    overflow: "horizontal-scroll",
    pinnedWidth: 44,
    titleVisibility: "full",
    faviconPriority: true
  },
  chrome: {
    preferredWidth: 180,
    minimumWidth: 44,
    maximumWidth: 240,
    flexGrow: 1,
    flexShrink: 1,
    overflow: "compress",
    pinnedWidth: 44,
    titleVisibility: "adaptive",
    faviconPriority: true
  }
};
function resolveTabLayoutPolicy(style) {
  return { ...PRESETS[style] };
}

// src/settings/settings-tab.ts
var import_obsidian3 = require("obsidian");

// src/ui/confirm-modal.ts
var import_obsidian2 = require("obsidian");
function confirmAction(app, title, message, confirmLabel = "Delete") {
  return new Promise((resolve) => new ConfirmActionModal(app, title, message, confirmLabel, resolve).open());
}
var ConfirmActionModal = class extends import_obsidian2.Modal {
  constructor(app, titleText, message, confirmLabel, resolveResult) {
    super(app);
    this.titleText = titleText;
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.resolveResult = resolveResult;
  }
  settled = false;
  onOpen() {
    this.contentEl.createEl("h2", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "ubc-confirm-actions" });
    const cancel = actions.createEl("button", { text: t("Cancel") });
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = actions.createEl("button", { cls: "mod-warning", text: this.confirmLabel });
    confirm.addEventListener("click", () => this.finish(true));
    cancel.focus();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolveResult(false);
  }
  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(value);
    this.close();
  }
};

// src/ui/permission-label.ts
var PERMISSION_LABELS = {
  camera: "Camera",
  microphone: "Microphone",
  media: "Camera and microphone",
  geolocation: "Location",
  notifications: "Notifications",
  midi: "MIDI devices",
  midiSysex: "MIDI system exclusive",
  pointerLock: "Pointer lock",
  fullscreen: "Full screen",
  openExternal: "Open external links",
  "clipboard-read": "Read clipboard",
  "clipboard-sanitized-write": "Write clipboard",
  "display-capture": "Screen capture",
  mediaKeySystem: "Protected media",
  "idle-detection": "Idle detection",
  serial: "Serial devices",
  hid: "HID devices",
  usb: "USB devices",
  bluetooth: "Bluetooth devices",
  keyboardLock: "Keyboard lock",
  "storage-access": "Site storage access",
  "top-level-storage-access": "Top-level storage access",
  "speaker-selection": "Audio output devices",
  "captured-surface-control": "Captured surface control"
};
function permissionLabel(permission) {
  const known = PERMISSION_LABELS[permission];
  if (known) return t(known);
  const words = permission.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim();
  if (!words) return "Site permission";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function permissionDecisionLabel(decision) {
  if (decision === "allow") return t("Allow");
  if (decision === "block") return t("Block");
  return t("Ask next time");
}

// src/settings/settings-tab.ts
var BrowserSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian3.Setting(containerEl).setName(t("Unified Browser Core")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Language")).setDesc(t("Choose the language used by Browser Core.")).addDropdown((dropdown) => dropdown.addOption("auto", t("Follow Obsidian")).addOption("en", t("English")).addOption("ja", "\u65E5\u672C\u8A9E").setValue(this.plugin.core.settings().language).onChange((value) => {
      const language2 = value;
      this.plugin.core.updateSettings({ language: language2 });
      setLanguage(language2);
      this.plugin.refreshLanguage();
      this.display();
    }));
    new import_obsidian3.Setting(containerEl).setName(t("Playback and authentication")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Autoplay")).setDesc(t("Block audible autoplay until you interact with the page. Muted videos may still play. Reopen tabs after changing this setting.")).addDropdown((dropdown) => dropdown.addOption("block-audible", t("Block audible autoplay")).addOption("allow", t("Allow autoplay")).setValue(this.plugin.core.settings().autoplayPolicy).onChange((value) => {
      if (value === "allow" || value === "block-audible") this.plugin.core.updateSettings({ autoplayPolicy: value });
    }));
    new import_obsidian3.Setting(containerEl).setName(t("Block passkey requests")).setDesc(t("Prevent sites from requesting or creating passkeys, including requests you start yourself. Turn off to sign in with a passkey. Reload pages after changing this setting.")).addToggle((toggle) => toggle.setValue(this.plugin.core.settings().blockPasskeyRequests).onChange((value) => this.plugin.core.updateSettings({ blockPasskeyRequests: value })));
    new import_obsidian3.Setting(containerEl).setName(t("Tab style")).setDesc(t("Firefox keeps a readable minimum tab width and overflows horizontally. Chrome compresses tabs more aggressively.")).addDropdown(
      (dropdown) => dropdown.addOption("firefox", t("Firefox")).addOption("chrome", t("Chrome")).setValue(this.plugin.core.settings().tabStyle).onChange((value) => {
        this.plugin.core.updateSettings({ tabStyle: value });
        this.plugin.applyTabStyle();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Use Browser Core tab layout")).setDesc(t("Apply the selected browser tab style only to panes that contain Browser Core tabs.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().tabStripIntegrationEnabled).onChange((value) => {
        this.plugin.core.updateSettings({ tabStripIntegrationEnabled: value });
        this.plugin.applyTabStyle();
      })
    );
    const currentSearchTemplate = this.plugin.core.settings().searchUrlTemplate;
    const currentSearchPreset = searchPresetForTemplate(currentSearchTemplate);
    let customSearchSetting;
    const searchEngineSetting = new import_obsidian3.Setting(containerEl).setName(t("Web search engine")).setDesc(t("Used when Browser Core treats text as a web search rather than an address."));
    searchEngineSetting.addDropdown((dropdown) => {
      for (const preset of SEARCH_PRESETS) dropdown.addOption(preset.id, preset.name);
      dropdown.addOption("custom", t("Custom"));
      dropdown.setValue(currentSearchPreset?.id ?? "custom").onChange((value) => {
        const preset = SEARCH_PRESETS.find((candidate) => candidate.id === value);
        if (preset) this.plugin.core.updateSettings({ searchUrlTemplate: preset.template });
        if (customSearchSetting) {
          customSearchSetting.settingEl.style.display = value === "custom" ? "" : "none";
        }
      });
    });
    customSearchSetting = new import_obsidian3.Setting(containerEl).setName(t("Custom search URL")).setDesc(t("Use {query} where the encoded search text should be inserted.")).addText(
      (text) => text.setPlaceholder("https://search.example/?q={query}").setValue(currentSearchTemplate).onChange((value) => {
        const template = value.trim();
        if (template.includes("{query}")) this.plugin.core.updateSettings({ searchUrlTemplate: template });
      })
    );
    customSearchSetting.settingEl.style.display = currentSearchPreset ? "none" : "";
    new import_obsidian3.Setting(containerEl).setName(t("Migration")).setHeading();
    const surfingMigration = this.plugin.core.state.surfingMigration;
    new import_obsidian3.Setting(containerEl).setName(t("Migrate from Surfing")).setDesc(surfingMigration?.completedAt ? t("Completed. Original Surfing data was kept. Backup: {v0}", { v0: surfingMigration.backupPath }) : t("Adopt Surfing's persistent login session, import bookmarks and compatible settings, and copy open tabs. Existing Browser Core data and Surfing source files are kept.")).addButton((button) => button.setButtonText(t(surfingMigration?.completedAt ? "Migrated" : surfingMigration ? "Resume migration" : "Preview and migrate")).setDisabled(Boolean(surfingMigration?.completedAt)).onClick(async () => {
      await this.plugin.migrateFromSurfing();
      this.display();
    }));
    new import_obsidian3.Setting(containerEl).setName(t("Home")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Replace new empty tabs with Home")).setDesc(t("A newly created empty Obsidian tab becomes the Browser Core Home surface.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().replaceEmptyTabsWithHome).onChange((value) => {
        this.plugin.core.updateSettings({ replaceEmptyTabsWithHome: value });
        if (value) void this.plugin.replaceMostRecentEmptyLeafWithHome();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Default Home search")).setDesc(t("Vault searches files in this vault. Web searches the web or opens an address.")).addDropdown(
      (dropdown) => dropdown.addOption("vault", t("Vault files")).addOption("web", t("Web")).setValue(this.plugin.core.settings().homeSearchMode).onChange((value) => {
        if (value === "vault" || value === "web") {
          this.plugin.core.updateSettings({ homeSearchMode: value });
          this.plugin.refreshBrowserViews();
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Show bookmarked Vault files on Home")).setDesc(t("Reads file bookmarks from Obsidian's built-in Bookmarks plugin without mixing them with web bookmarks.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showVaultBookmarksOnHome).onChange((value) => {
        this.plugin.core.updateSettings({ showVaultBookmarksOnHome: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Show recent Vault files on Home")).setDesc(t("Uses Obsidian's recent-file list; Browser Core does not maintain a duplicate recent-file database.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showRecentVaultFilesOnHome).onChange((value) => {
        this.plugin.core.updateSettings({ showRecentVaultFilesOnHome: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Browser startup")).setDesc(t("Choose what happens when Obsidian starts and no browser tabs are already open.")).addDropdown(
      (dropdown) => dropdown.addOption("restore", t("Restore previous browser session")).addOption("home", t("Open Home")).addOption("none", t("Do nothing")).setValue(this.plugin.core.settings().startupBehavior).onChange((value) => {
        if (value === "restore" || value === "home" || value === "none") {
          this.plugin.core.updateSettings({ startupBehavior: value });
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("History & recovery")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("History day starts at")).setDesc(t("History day boundaries default to 04:00 so late-night work stays together.")).addText((text) => {
      text.inputEl.type = "time";
      text.setValue(formatDayStart(this.plugin.core.settings().historyDayStartMinutes));
      text.onChange((value) => {
        const minutes = parseDayStart(value);
        if (minutes !== void 0) this.plugin.core.updateSettings({ historyDayStartMinutes: minutes });
      });
    });
    new import_obsidian3.Setting(containerEl).setName(t("History retention (days)")).setDesc(t("0 keeps browsing history until you delete it. Protected tab histories are not removed automatically.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().historyRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ historyRetentionDays: days });
      })
    );
    const advancedStorage = containerEl.createEl("details", { cls: "ubc-settings-advanced" });
    advancedStorage.createEl("summary", { text: t("Advanced history and recovery storage") });
    const advancedStorageEl = advancedStorage.createDiv({ cls: "ubc-settings-advanced-content" });
    new import_obsidian3.Setting(advancedStorageEl).setName(t("Automatic history size limit")).setDesc(t("0 disables size-based cleanup. A positive value allows the oldest closed, unprotected tab histories to be removed when stored history grows past this limit.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().historyMaxNodes)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && (count === 0 || count >= 1e3)) {
          this.plugin.core.updateSettings({ historyMaxNodes: Math.floor(count) });
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Show recovery notifications")).setDesc(t("Recovery notifications disappear when you interact with the page. Turn this on to show them again after choosing Never show again.")).addToggle((toggle) => toggle.setValue(this.plugin.core.settings().showRecoveryNotifications).onChange((value) => {
      this.plugin.core.updateSettings({ showRecoveryNotifications: value });
      this.plugin.refreshBrowserViews();
    }));
    new import_obsidian3.Setting(containerEl).setName(t("Detailed tab recovery retention (days)")).setDesc(t("How long Browser Core should keep extra state that can restore recently closed tabs more accurately.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().restoreRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ restoreRetentionDays: days });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName(t("Detailed recovery storage limit (MB)")).setDesc(t("When this budget is exceeded, older unprotected recovery data may fall back to URL-only reopening.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().restoreStorageLimitMb)).onChange((value) => {
        const mb = Number(value);
        if (Number.isFinite(mb) && mb >= 16) this.plugin.core.updateSettings({ restoreStorageLimitMb: mb });
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Form recovery")).setDesc(t("Allow form recovery as a feature. Capture remains opt-in per site, and password/payment credentials are excluded.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().formRecoveryEnabled).onChange((value) => {
        this.plugin.core.updateSettings({ formRecoveryEnabled: value });
        this.plugin.refreshFormRecoveryInstrumentation();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Form recovery retention (days)")).setDesc(t("How long saved non-credential form values are retained.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ formRecoveryRetentionDays: days });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName(t("Saved form versions per page")).setDesc(t("How many recent recovery versions to keep for one page. Multi-step forms can use values from several versions.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryMaxSnapshotsPerUrl)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxSnapshotsPerUrl: Math.floor(count) });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName(t("Pages with saved form recovery")).setDesc(t("Maximum number of distinct pages that may keep form recovery data.")).addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryMaxUrls)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxUrls: Math.floor(count) });
      })
    ).addExtraButton(
      (button) => button.setIcon("trash").setTooltip(t("Clear all saved form recovery data")).onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          t("Clear form recovery data"),
          t("Delete all saved Browser Core form recovery data? Sites that opted in will stay enabled."),
          t("Clear form data")
        );
        if (!confirmed) return;
        this.plugin.clearFormRecoveryData();
      })
    );
    const recoveryPolicies = this.plugin.core.formRecovery.policies();
    if (recoveryPolicies.length) {
      new import_obsidian3.Setting(containerEl).setName(t("Form recovery by site")).setHeading();
      for (const policy of recoveryPolicies) {
        new import_obsidian3.Setting(containerEl).setName(`${this.plugin.core.containers.nameFor(policy.containerId)} \xB7 ${policy.origin}`).setDesc(
          policy.disabled ? t("Disabled for this site") : t("{v0} excluded field(s)", { v0: policy.excludedFieldKeys.length })
        ).addExtraButton(
          (button) => button.setIcon("rotate-ccw").setTooltip(t("Reset form recovery for this site")).onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Reset form recovery for site"),
              t("Reset form recovery for {v0}? This also deletes saved form recovery data for this site.", { v0: policy.origin }),
              t("Reset site")
            );
            if (!confirmed) return;
            this.plugin.core.formRecovery.resetPolicy(policy.containerId, policy.origin);
            this.plugin.core.scheduleSave();
            this.display();
          })
        );
      }
    }
    new import_obsidian3.Setting(containerEl).setName(t("Browsing data")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Clear browsing history")).setDesc(t("Deletes browsing history and detailed recovery data for closed tabs. Open tabs stay open.")).addButton(
      (button) => button.setButtonText(t("Clear history")).setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          t("Clear browser history"),
          t("Delete browsing history and detailed closed-tab recovery data? Open tabs, bookmarks, containers, cookies and form recovery remain."),
          t("Clear history")
        );
        if (!confirmed) return;
        this.plugin.clearBrowserHistory();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Clear detailed tab recovery")).setDesc(t("Keeps browsing history, but removes extra state used to restore recently closed tabs more accurately. Open tabs start collecting detailed recovery again after they are reopened.")).addButton(
      (button) => button.setButtonText(t("Clear recovery data")).setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          t("Clear detailed tab recovery"),
          t("Old tabs will still reopen from durable URLs, but high-fidelity closed-tab restoration will be lost."),
          t("Clear recovery data")
        );
        if (!confirmed) return;
        this.plugin.clearRichRestoreData();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Clear form recovery data")).setDesc(t("Deletes all saved non-credential form values without changing which sites have form recovery enabled.")).addButton(
      (button) => button.setButtonText(t("Clear form data")).setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          t("Clear form recovery data"),
          t("Delete all saved Browser Core form recovery data?"),
          t("Clear form data")
        );
        if (!confirmed) return;
        this.plugin.clearFormRecoveryData();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Reset site permissions")).setDesc(t("Returns saved site permissions to Ask next time. Container cookies and site storage are not changed.")).addButton(
      (button) => button.setButtonText(t("Reset permissions")).setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          t("Reset site permissions"),
          t("Reset all saved site permissions to Ask next time?"),
          t("Reset permissions")
        );
        if (!confirmed) return;
        this.plugin.clearPermissionDecisions();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Appearance")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Initial background color override")).setDesc(t("Choose the background before the site paints. The site's own colors remain in control once painted.")).addDropdown((dropdown) => dropdown.addOption("none", t("No override")).addOption("theme", t("Follow theme")).addOption("custom", t("Custom color")).setValue(this.plugin.core.settings().initialBackgroundOverride ? this.plugin.core.settings().initialBackgroundSource : "none").onChange((value) => {
      this.plugin.core.updateSettings({ initialBackgroundOverride: value !== "none", initialBackgroundSource: value === "custom" ? "custom" : "theme" });
      this.plugin.refreshBrowserViews();
      this.display();
    }));
    if (this.plugin.core.settings().initialBackgroundOverride && this.plugin.core.settings().initialBackgroundSource === "custom") {
      new import_obsidian3.Setting(containerEl).setName(t("Initial background color")).addColorPicker((picker) => picker.setValue(this.plugin.core.settings().initialBackgroundColor).onChange((value) => {
        this.plugin.core.updateSettings({ initialBackgroundColor: value });
        this.plugin.refreshBrowserViews();
      }));
    }
    new import_obsidian3.Setting(containerEl).setName(t("Full-page loading shield")).setDesc(t("Cover the web page while a new page starts loading. Off by default to avoid a full-page flash.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().fullPageLoadingShield).onChange((value) => {
        this.plugin.core.updateSettings({ fullPageLoadingShield: value });
        this.plugin.refreshLoadingShields();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Reduced motion")).setDesc(t("Avoid large transitions, slides and parallax in Browser Core UI.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().reducedMotion).onChange((value) => {
        this.plugin.core.updateSettings({ reducedMotion: value });
        this.plugin.applyAccessibilityClasses();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Default web content zoom")).setDesc(t("Relative to this Obsidian window. Used by sites without a site-specific zoom override.")).addSlider(
      (slider) => slider.setLimits(50, 200, 10).setDynamicTooltip().setValue(Math.round(this.plugin.core.settings().defaultZoomFactor * 100)).onChange((value) => {
        this.plugin.core.updateSettings({ defaultZoomFactor: value / 100 });
        this.plugin.refreshBrowserZoom();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Show bookmark bar")).setDesc(t("Your everyday pages, one click away.")).addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showFavoritesBar).onChange((value) => {
        this.plugin.core.updateSettings({ showFavoritesBar: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Bookmark bar display")).setDesc(t("Choose every bookmark and folder, or just the members you select.")).addDropdown((dropdown) => dropdown.addOption("all", t("Bookmark bar")).addOption("selected", t("Selected members")).setValue(this.plugin.core.settings().bookmarkBarMode).onChange((value) => {
      this.plugin.core.updateSettings({ bookmarkBarMode: value });
      this.plugin.refreshBrowserViews();
    })).addButton((button) => button.setButtonText(t("Choose members")).onClick(() => void this.plugin.openBrowser({ url: "browser://bookmarks", state: { bookmarkLayout: "selected" } })));
    new import_obsidian3.Setting(containerEl).setName(t("Containers")).setHeading();
    new import_obsidian3.Setting(containerEl).setName(t("Container use")).setDesc(t("Off uses only the selected default container. Manual keeps other containers available without automatic site routing. Automatic also applies site default rules.")).addDropdown(
      (dropdown) => dropdown.addOption("off", t("Off")).addOption("manual", t("Manual")).addOption("automatic", t("Automatic")).setValue(this.plugin.core.settings().containerMode).onChange((value) => {
        this.plugin.core.updateSettings({ containerMode: value });
        this.plugin.refreshContainerPresentation();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName(t("Default container")).setDesc(t("Used for new browser tabs, including when container controls are off. Automatic mode may replace it with a site's default container.")).addDropdown((dropdown) => {
      for (const container of this.plugin.core.containers.list()) {
        dropdown.addOption(container.id, container.name);
      }
      dropdown.setValue(this.plugin.core.settings().defaultContainerId).onChange((value) => this.plugin.core.updateSettings({ defaultContainerId: value }));
    });
    for (const container of this.plugin.core.containers.list()) {
      const row = new import_obsidian3.Setting(containerEl).setName(container.name).setDesc(t("Separate persistent login and site data")).addText(
        (text) => text.setPlaceholder(t("Container name")).setValue(container.name).onChange((value) => {
          const next = value.trim();
          if (!next) return;
          container.name = next;
          this.plugin.core.scheduleSave();
          this.plugin.refreshContainerPresentation();
        })
      ).addDropdown(
        (dropdown) => dropdown.addOption("box", t("Box")).addOption("user-round", t("Personal")).addOption("briefcase", t("Work")).addOption("search", t("Search")).addOption("graduation-cap", t("Study")).addOption("building-2", t("Organization")).addOption("shield", t("Protected")).addOption("heart", t("Favorite")).setValue(container.icon || "box").onChange((value) => {
          container.icon = value;
          this.plugin.core.scheduleSave();
          this.plugin.refreshContainerPresentation();
        })
      ).addColorPicker(
        (picker) => picker.setValue(container.color || "#7f7f7f").onChange((value) => {
          container.color = value;
          this.plugin.core.scheduleSave();
          this.plugin.refreshContainerPresentation();
        })
      ).addExtraButton((button) => {
        button.setIcon("eraser").setTooltip(t("Clear browsing data and saved permissions"));
        button.onClick(async () => {
          const confirmed = await confirmAction(
            this.app,
            "Clear " + container.name + " browsing data",
            t("Clear this container's cookies, site storage, cache, sign-in cache, and saved site permissions? Open pages may need to be reloaded."),
            t("Clear browsing data")
          );
          if (!confirmed) return;
          const cleared = await this.plugin.clearContainerSession(container.id);
          if (!cleared) return;
          this.display();
        });
      }).addExtraButton((button) => {
        button.setIcon("trash").setTooltip(t("Delete container"));
        button.setDisabled(container.id === "default");
        button.onClick(async () => {
          const confirmed = await confirmAction(
            this.app,
            t("Delete container"),
            t("Delete \u201C{v0}\u201D? Its cookies, site storage, cache, saved permissions, form recovery data, and site default rules will be cleared. Browsing history will remain.", { v0: container.name }),
            t("Delete container")
          );
          if (!confirmed) return;
          if (await this.plugin.deleteContainer(container.id)) this.display();
        });
      });
      row.settingEl.dataset.containerId = container.id;
    }
    new import_obsidian3.Setting(containerEl).setName(t("Add container")).setDesc(t("Creates a separate persistent login and site data.")).addButton(
      (button) => button.setButtonText(t("Add")).onClick(() => {
        this.plugin.core.containers.create("Container");
        this.plugin.core.scheduleSave();
        this.display();
      })
    );
    const assignments = this.plugin.core.containers.assignments();
    if (assignments.length) {
      new import_obsidian3.Setting(containerEl).setName(t("Site default containers")).setDesc(this.plugin.core.settings().containerMode === "automatic" ? t("Applied automatically when an independent navigation opens a matching site.") : t("Saved for later, but currently paused because automatic container routing is off.")).setHeading();
      for (const rule of assignments) {
        new import_obsidian3.Setting(containerEl).setName(rule.originPattern).setDesc(this.plugin.core.containers.nameFor(rule.containerId)).addExtraButton(
          (button) => button.setIcon("x").setTooltip(t("Forget site default container")).onClick(() => {
            this.plugin.core.containers.unassignOrigin(rule.originPattern);
            this.plugin.core.scheduleSave();
            this.display();
          })
        );
      }
    }
    const permissions = this.plugin.core.permissions.list();
    if (permissions.length) {
      new import_obsidian3.Setting(containerEl).setName(t("Site permissions")).setHeading();
      for (const record of permissions) {
        new import_obsidian3.Setting(containerEl).setName(permissionLabel(record.permission)).setDesc(`${record.origin} \xB7 ${this.plugin.core.containers.nameFor(record.containerId)} \xB7 ${permissionDecisionLabel(record.decision)}`).addDropdown(
          (dropdown) => dropdown.addOption("ask", t("Ask next time")).addOption("allow", t("Allow")).addOption("block", t("Block")).setValue(record.decision).onChange((value) => {
            if (value === "ask") {
              this.plugin.core.permissions.remove(record.containerId, record.origin, record.permission);
            } else {
              this.plugin.core.permissions.set(
                record.containerId,
                record.origin,
                record.permission,
                value
              );
            }
            this.plugin.core.scheduleSave();
          })
        );
      }
    }
  }
};
function formatDayStart(totalMinutes) {
  const normalized = Math.max(0, Math.min(1439, Math.floor(totalMinutes)));
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
function parseDayStart(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return void 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return void 0;
  return hours * 60 + minutes;
}
var SEARCH_PRESETS = [
  { id: "google", name: "Google", template: "https://www.google.com/search?q={query}" },
  { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q={query}" },
  { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={query}" }
];
function searchPresetForTemplate(template) {
  return SEARCH_PRESETS.find((preset) => preset.template === template);
}

// src/ui/address-suggestions.ts
function bindAddressSuggestions(input, core, navigate) {
  const doc = input.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "ubc-address-wrapper";
  input.replaceWith(wrapper);
  wrapper.appendChild(input);
  const list = wrapper.createDiv({ cls: "ubc-address-suggestions is-hidden", attr: { role: "listbox" } });
  list.id = `ubc-suggestions-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");
  let choices = [];
  let selected = -1;
  const close = () => {
    list.addClass("is-hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selected = -1;
  };
  const highlight = () => {
    [...list.children].forEach((row, index) => {
      row.classList.toggle("is-selected", index === selected);
      row.setAttribute("aria-selected", String(index === selected));
    });
    if (selected >= 0) {
      const row = list.children[selected];
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const update = () => {
    const query = input.value.trim().toLocaleLowerCase();
    list.empty();
    selected = -1;
    if (!query) {
      close();
      return;
    }
    const candidates = /* @__PURE__ */ new Map();
    const add = (url, title, source) => {
      if (!/^https?:\/\//i.test(url) || candidates.has(url)) return;
      if ((title + " " + url).toLocaleLowerCase().includes(query)) candidates.set(url, { url, title, source });
    };
    for (const bookmark of core.bookmarks.allBookmarks()) add(bookmark.url, bookmark.title, t("Bookmarks"));
    for (const node of core.history.allNodes().sort((a, b) => b.timestamp - a.timestamp)) {
      if (node.kind === "navigation") add(node.url, node.title, t("History"));
    }
    choices = [...candidates.values()].slice(0, 8);
    for (const [index, choice] of choices.entries()) {
      const row = list.createDiv({ cls: "ubc-address-suggestion", attr: { role: "option", id: `${list.id}-${index}`, "aria-selected": "false" } });
      row.createDiv({ cls: "ubc-suggestion-title", text: choice.title || choice.url });
      row.createDiv({ cls: "ubc-suggestion-url", text: choice.url });
      row.createSpan({ cls: "ubc-suggestion-source", text: choice.source });
      row.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        input.value = choice.url;
        close();
        navigate(choice.url);
      });
    }
    list.toggleClass("is-hidden", !choices.length);
    input.setAttribute("aria-expanded", String(Boolean(choices.length)));
  };
  const keydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      close();
      event.preventDefault();
      return;
    }
    if (list.hasClass("is-hidden")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      highlight();
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const choice = choices[selected];
      if (!choice) return;
      input.value = choice.url;
      close();
      navigate(choice.url);
    } else if (event.key === "Enter" || event.key === "Tab") close();
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", keydown, true);
  input.addEventListener("blur", close);
  close();
  return () => {
    input.removeEventListener("input", update);
    input.removeEventListener("keydown", keydown, true);
    input.removeEventListener("blur", close);
    list.remove();
  };
}

// src/adapters/guest-interaction.ts
function observeGuestInteraction(webview, dismiss) {
  const contents = resolveGuestWebContents(webview);
  if (!contents?.on || !contents.removeListener) return void 0;
  const interact = (_event, input) => {
    if (["mouseDown", "mouseWheel", "touchStart", "gestureScrollBegin", "keyDown", "rawKeyDown"].includes(input.type ?? "")) dismiss();
  };
  for (const event of ["before-mouse-event", "before-input-event", "input-event"]) contents.on(event, interact);
  return () => {
    for (const event of ["before-mouse-event", "before-input-event", "input-event"]) {
      try {
        contents.removeListener(event, interact);
      } catch {
      }
    }
  };
}

// src/ui/browser-view.ts
var import_obsidian13 = require("obsidian");

// src/adapters/electron-zoom.ts
function hostZoomFactor(doc) {
  try {
    const win = doc.defaultView;
    const value = win?.require?.("electron")?.webFrame?.getZoomFactor?.();
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

// src/adapters/electron-navigation-history.ts
var ElectronNavigationHistoryAdapter = class {
  capture(webview, leafId) {
    const history = this.resolve(webview)?.navigationHistory;
    if (!history?.getAllEntries || !history.getActiveIndex) return void 0;
    try {
      const entries = JSON.parse(JSON.stringify(history.getAllEntries()));
      return {
        leafId,
        capturedAt: Date.now(),
        entries,
        index: history.getActiveIndex()
      };
    } catch {
      return void 0;
    }
  }
  async restore(webview, capsule, index = capsule.index) {
    const history = this.resolve(webview)?.navigationHistory;
    if (!history?.restore) return false;
    try {
      await history.restore({ entries: capsule.entries, index });
      const entries = history.getAllEntries?.();
      const activeIndex = history.getActiveIndex?.();
      if (!entries || !entries.length || typeof activeIndex !== "number") return true;
      const activeUrl = entries[activeIndex]?.url;
      return typeof activeUrl === "string" && activeUrl.length > 0 && activeUrl !== "about:blank";
    } catch {
      return false;
    }
  }
  entryMatches(capsule, index, url) {
    if (!Number.isInteger(index) || index < 0 || index >= capsule.entries.length) return false;
    const entryUrl = capsule.entries[index]?.url;
    return typeof entryUrl === "string" && entryUrl === url;
  }
  activeIndex(webview) {
    try {
      return this.resolve(webview)?.navigationHistory?.getActiveIndex?.();
    } catch {
      return void 0;
    }
  }
  entries(webview) {
    try {
      return this.resolve(webview)?.navigationHistory?.getAllEntries?.() ?? [];
    } catch {
      return [];
    }
  }
  clear(webview) {
    try {
      const history = this.resolve(webview)?.navigationHistory;
      if (!history?.clear) return false;
      history.clear();
      return true;
    } catch {
      return false;
    }
  }
  goToIndex(webview, index) {
    try {
      const history = this.resolve(webview)?.navigationHistory;
      if (!history?.goToIndex) return false;
      history.goToIndex(index);
      return true;
    } catch {
      return false;
    }
  }
  resolve(webview) {
    return resolveGuestWebContents(webview);
  }
};

// src/history/day-key.ts
function historyDayKey(timestamp, startMinutes) {
  const local = new Date(timestamp);
  const boundary = Math.max(0, Math.min(1439, Math.floor(startMinutes)));
  const minutesSinceMidnight = local.getHours() * 60 + local.getMinutes();
  const dayDate = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  if (minutesSinceMidnight < boundary) dayDate.setDate(dayDate.getDate() - 1);
  const year = dayDate.getFullYear();
  const month = String(dayDate.getMonth() + 1).padStart(2, "0");
  const day = String(dayDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// src/history/navigation-classifier.ts
function classifyInPageNavigation(previousIndex, nextIndex, intent) {
  if (intent === "back" || intent === "forward") return "navigation";
  if (typeof previousIndex !== "number" || typeof nextIndex !== "number") return "navigation";
  return previousIndex === nextIndex ? "residual" : "navigation";
}

// src/ui/context-menus.ts
var import_obsidian9 = require("obsidian");

// src/ui/bookmark-editor.ts
var import_obsidian5 = require("obsidian");

// src/bookmarks/bookmark-media.ts
var BOOKMARK_MEDIA = [
  { type: "reference", label: "References", icon: "library-big" },
  { type: "video", label: "Video", icon: "clapperboard" },
  { type: "audio", label: "Audio", icon: "headphones" },
  { type: "image", label: "Images", icon: "image" },
  { type: "pdf", label: "PDF", icon: "file-text" },
  { type: "document", label: "Documents", icon: "files" },
  { type: "mail", label: "Mail", icon: "mail" },
  { type: "blog", label: "Blogs", icon: "notebook-pen" },
  { type: "forum", label: "Forums", icon: "messages-square" },
  { type: "website", label: "Websites", icon: "globe" }
];
function classifyBookmark(bookmark) {
  if (bookmark.mediaType && BOOKMARK_MEDIA.some((entry) => entry.type === bookmark.mediaType)) return bookmark.mediaType;
  return inferBookmarkMedia(bookmark.url);
}
function inferBookmarkMedia(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "website";
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const domain = (name) => host === name || host.endsWith("." + name);
  const filenames = [path, ...Array.from(url.searchParams.values())];
  const extension = (pattern) => filenames.some((value) => pattern.test(value));
  if (domain("youtube.com") || domain("youtu.be") || domain("vimeo.com") || domain("nicovideo.jp") || extension(/\.(mp4|webm|mov|mkv|avi|m4v)(?:$|[?#])/i)) return "video";
  if (url.protocol === "mailto:" || domain("gmail.com") || /^mail\.google\.[a-z.]+$/.test(host) || domain("outlook.com") || host === "outlook.live.com" || host === "outlook.office.com" || host === "outlook.office365.com" || /^mail\.yahoo\.[a-z.]+$/.test(host) || domain("proton.me") && host.startsWith("mail.")) return "mail";
  if (extension(/\.(mp3|wav|ogg|flac|m4a|aac)(?:$|[?#])/i) || domain("spotify.com") || domain("soundcloud.com")) return "audio";
  if (extension(/\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:$|[?#])/i)) return "image";
  if (extension(/\.pdf(?:$|[?#])/i)) return "pdf";
  if (extension(/\.(docx?|xlsx?|pptx?|odt|ods|odp|epub|txt|md|csv)(?:$|[?#])/i)) return "document";
  if (domain("reddit.com") || domain("5ch.net") || domain("2ch.sc") || domain("stackoverflow.com") || domain("stackexchange.com") || host === "news.ycombinator.com" || /^(forum|bbs)\./.test(host) || /\/(forums?|boards?|threads?)\//.test(path)) return "forum";
  if (domain("medium.com") || domain("note.com") || domain("hatena.ne.jp") || domain("hatenablog.com") || domain("hatenablog.jp") || domain("blogspot.com") || domain("wordpress.com") || domain("substack.com") || domain("qiita.com") || domain("zenn.dev") || domain("ameblo.jp") || domain("livedoor.blog") || domain("blog.fc2.com") || host.startsWith("blog.") || /\/blog(?:\/|$)/.test(path)) return "blog";
  if (/(^|\.)google\.[a-z.]+$/.test(host) || domain("googleusercontent.com") || domain("wikipedia.org") || domain("manaba.jp") || host.includes("manaba")) return "reference";
  return "website";
}

// src/ui/bookmark-visual.ts
var import_obsidian4 = require("obsidian");
function renderBookmarkVisual(parent, bookmark, className = "ubc-bookmark-visual", app) {
  const host = parent.createSpan({ cls: className, attr: { "aria-hidden": "true" } });
  const fallback = () => {
    host.empty();
    (0, import_obsidian4.setIcon)(host, "bookmark");
  };
  if (bookmark.visualKind === "text") {
    const value = bookmark.visualValue?.trim();
    if (!value) {
      fallback();
      return host;
    }
    host.addClass("is-text");
    host.setText(value.slice(0, 4));
    return host;
  }
  if (bookmark.visualKind === "icon") {
    (0, import_obsidian4.setIcon)(host, bookmark.visualValue?.trim() || "bookmark");
    if (!host.firstElementChild) fallback();
    return host;
  }
  const source = bookmark.visualKind === "image" ? resolveCustomImage(bookmark.visualValue, app) : bookmark.faviconUrl?.trim() || fallbackFaviconUrl(bookmark.url);
  if (!source) {
    fallback();
    return host;
  }
  const image = host.createEl("img", {
    cls: "ubc-bookmark-visual-image",
    attr: { src: source, alt: "" }
  });
  image.addEventListener("error", fallback, { once: true });
  return host;
}
function resolveCustomImage(value, app) {
  const source = value?.trim();
  if (!source) return void 0;
  if (/^(?:https?:|data:image\/|app:|file:)/i.test(source)) return source;
  const file = app?.vault.getAbstractFileByPath(source);
  return file instanceof import_obsidian4.TFile ? app.vault.getResourcePath(file) : source;
}
function fallbackFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
    return new URL("/favicon.ico", parsed.origin).href;
  } catch {
    return void 0;
  }
}

// src/ui/bookmark-editor.ts
function editBookmark(app, title, url, heading = "Edit bookmark", options = {}) {
  return new Promise((resolve) => {
    new BookmarkEditorModal(app, title, url, heading, options, resolve).open();
  });
}
var BookmarkEditorModal = class extends import_obsidian5.Modal {
  constructor(app, initialTitle, initialUrl, heading, options, resolveDraft) {
    super(app);
    this.initialTitle = initialTitle;
    this.initialUrl = initialUrl;
    this.heading = heading;
    this.options = options;
    this.resolveDraft = resolveDraft;
  }
  settled = false;
  onOpen() {
    this.modalEl.addClass("ubc-bookmark-editor-modal");
    this.contentEl.createEl("h2", { text: this.heading });
    const titleField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    titleField.createSpan({ cls: "ubc-prompt-label", text: t("Title") });
    const title = titleField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: t("Title"), "aria-label": t("Bookmark title") }
    });
    title.value = this.initialTitle;
    const urlField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    urlField.createSpan({ cls: "ubc-prompt-label", text: t("URL") });
    const url = urlField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "url", placeholder: "https://\u2026", "aria-label": t("Bookmark URL") }
    });
    url.value = this.initialUrl;
    let folder;
    if (this.options.store) {
      const field = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
      field.createSpan({ cls: "ubc-prompt-label", text: t("Save in") });
      folder = field.createEl("select");
      folder.createEl("option", { value: "", text: t("Bookmarks root") });
      for (const item of this.options.store.folders()) folder.createEl("option", { value: item.id, text: this.options.store.folderPath(item.id) });
      folder.value = this.options.parentId ?? "";
    }
    const typeField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    typeField.createSpan({ cls: "ubc-prompt-label", text: t("Media type") });
    const mediaType = typeField.createEl("select");
    mediaType.createEl("option", { value: "", text: t("Automatic classification") });
    for (const entry of BOOKMARK_MEDIA) mediaType.createEl("option", { value: entry.type, text: t(entry.label) });
    mediaType.value = this.options.mediaType ?? "";
    const descriptionField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    descriptionField.createSpan({ cls: "ubc-prompt-label", text: t("Description") });
    const description = descriptionField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": t("Bookmark description") }
    });
    description.value = this.options.description ?? "";
    const tagsField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    tagsField.createSpan({ cls: "ubc-prompt-label", text: t("Tags") });
    const tags = tagsField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: t("Separate tags with spaces"), "aria-label": t("Bookmark tags") }
    });
    tags.value = (this.options.tags ?? []).join(" ");
    const favoriteField = this.contentEl.createEl("label", { cls: "ubc-prompt-check" });
    const favorite = favoriteField.createEl("input", { attr: { type: "checkbox" } });
    favorite.checked = Boolean(this.options.favorite);
    favoriteField.createSpan({ text: t("Show in favorites bar") });
    const appearanceField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    appearanceField.createSpan({ cls: "ubc-prompt-label", text: t("Bookmark image") });
    const visualKind = appearanceField.createEl("select", { attr: { "aria-label": t("Bookmark image type") } });
    visualKind.createEl("option", { text: t("Website favicon"), value: "favicon" });
    visualKind.createEl("option", { text: t("Custom image"), value: "image" });
    visualKind.createEl("option", { text: t("Custom text"), value: "text" });
    visualKind.createEl("option", { text: t("Lucide icon"), value: "icon" });
    visualKind.value = this.options.visualKind ?? "favicon";
    const visualValueField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    visualValueField.createSpan({ cls: "ubc-prompt-label", text: t("Custom value") });
    const visualValue = visualValueField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": t("Custom bookmark image or text") }
    });
    visualValue.value = this.options.visualValue ?? "";
    const previewField = this.contentEl.createDiv({ cls: "ubc-bookmark-editor-preview-row" });
    previewField.createSpan({ cls: "ubc-prompt-label", text: t("Preview") });
    const preview = previewField.createDiv({ cls: "ubc-bookmark-editor-preview" });
    const renderPreview = () => {
      preview.empty();
      const kind = visualKind.value;
      const previewBookmark = {
        id: "preview",
        kind: "bookmark",
        parentId: null,
        title: title.value.trim() || "Bookmark",
        url: url.value.trim() || "https://example.com",
        order: 0,
        createdAt: 0,
        favorite: favorite.checked,
        visualKind: kind,
        visualValue: kind === "favicon" ? void 0 : visualValue.value.trim() || void 0
      };
      renderBookmarkVisual(preview, previewBookmark, "ubc-bookmark-editor-preview-icon", this.app);
      preview.createSpan({ cls: "ubc-bookmark-editor-preview-title", text: previewBookmark.title });
    };
    const syncVisualField = () => {
      const kind = visualKind.value;
      visualValueField.toggleClass("is-hidden", kind === "favicon");
      visualValue.placeholder = kind === "image" ? "https://\u2026 or Images/icon.png" : kind === "icon" ? "bookmark, globe, link, etc." : "AI, G, \u2605, etc.";
      renderPreview();
    };
    visualKind.addEventListener("change", syncVisualField);
    visualValue.addEventListener("input", renderPreview);
    title.addEventListener("input", renderPreview);
    url.addEventListener("input", renderPreview);
    syncVisualField();
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: t("Cancel") }).addEventListener("click", () => this.finish(void 0));
    const save = actions.createEl("button", { text: t("Save") });
    const submit = () => {
      const nextUrl = url.value.trim();
      if (!nextUrl) return;
      const kind = visualKind.value;
      this.finish({
        title: title.value.trim() || nextUrl,
        url: nextUrl,
        description: description.value.trim(),
        tags: tags.value.trim() ? tags.value.trim().split(/\s+/) : [],
        ...folder ? { parentId: folder.value || null } : {},
        mediaType: mediaType.value || void 0,
        favorite: favorite.checked,
        visualKind: kind,
        visualValue: kind === "favicon" ? void 0 : visualValue.value.trim() || void 0
      });
    };
    const syncSave = () => {
      const enabled = Boolean(url.value.trim());
      save.disabled = !enabled;
      save.toggleClass("mod-cta", enabled);
    };
    save.addEventListener("click", submit);
    url.addEventListener("input", syncSave);
    title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!url.value.trim()) {
        url.focus();
        return;
      }
      submit();
    });
    url.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || save.disabled) return;
      event.preventDefault();
      submit();
    });
    syncSave();
    title.focus();
    title.select();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolveDraft(void 0);
  }
  finish(draft) {
    if (this.settled) return;
    this.settled = true;
    this.resolveDraft(draft);
    this.close();
  }
};

// src/bookmarks/bookmark-url.ts
var import_obsidian6 = require("obsidian");
function resolveBookmarkUrl(url, app) {
  if (!/{{\s*selection\s*}}/.test(url)) return url;
  const selection = app.workspace.getActiveViewOfType(import_obsidian6.MarkdownView)?.editor?.getSelection().trim() || "";
  return url.replace(/{{\s*selection\s*}}/g, encodeURIComponent(selection));
}

// src/ui/folder-picker-modal.ts
var import_obsidian7 = require("obsidian");
function pickBookmarkFolder(app, store, options = {}) {
  return new Promise((resolve) => {
    new BookmarkFolderPickerModal(app, store, options.excludeFolderId, resolve).open();
  });
}
var BookmarkFolderPickerModal = class extends import_obsidian7.FuzzySuggestModal {
  constructor(app, store, excludeFolderId, resolveChoice) {
    super(app);
    this.store = store;
    this.excludeFolderId = excludeFolderId;
    this.resolveChoice = resolveChoice;
    this.setPlaceholder(t("Choose bookmark folder"));
  }
  chosen = false;
  getItems() {
    const choices = [{ id: null, label: t("Bookmarks root") }];
    for (const folder of this.store.folders()) {
      if (this.excludeFolderId && !this.store.canMoveFolder(this.excludeFolderId, folder.id)) continue;
      choices.push({ id: folder.id, label: this.store.folderPath(folder.id) });
    }
    return choices;
  }
  getItemText(item) {
    return item.label;
  }
  onChooseItem(item) {
    this.chosen = true;
    this.resolveChoice(item.id);
  }
  onClose() {
    super.onClose();
    window.setTimeout(() => {
      if (!this.chosen) this.resolveChoice(void 0);
    }, 0);
  }
};

// src/ui/text-prompt.ts
var import_obsidian8 = require("obsidian");
function promptText(app, title, initialValue = "", placeholder = "") {
  return new Promise((resolve) => {
    new TextPromptModal(app, title, initialValue, placeholder, resolve).open();
  });
}
var TextPromptModal = class extends import_obsidian8.Modal {
  constructor(app, promptTitle, initialValue, placeholder, resolveValue) {
    super(app);
    this.promptTitle = promptTitle;
    this.initialValue = initialValue;
    this.placeholder = placeholder;
    this.resolveValue = resolveValue;
  }
  settled = false;
  onOpen() {
    this.contentEl.createEl("h2", { text: this.promptTitle });
    const field = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    if (this.placeholder) field.createSpan({ cls: "ubc-prompt-label", text: this.placeholder });
    const input = field.createEl("input", {
      attr: {
        type: "text",
        placeholder: this.placeholder,
        "aria-label": this.placeholder || this.promptTitle
      }
    });
    input.value = this.initialValue;
    input.addClass("ubc-prompt-input");
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: t("Cancel") }).addEventListener("click", () => this.finish(void 0));
    const save = actions.createEl("button", { text: t("Save") });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.finish(value);
    };
    const syncSave = () => {
      const enabled = Boolean(input.value.trim());
      save.disabled = !enabled;
      save.toggleClass("mod-cta", enabled);
    };
    save.addEventListener("click", submit);
    input.addEventListener("input", syncSave);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || save.disabled) return;
      event.preventDefault();
      submit();
    });
    syncSave();
    input.focus();
    input.select();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolveValue(void 0);
  }
  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolveValue(value);
    this.close();
  }
};

// src/ui/web-content-menu-model.ts
function buildWebContentMenuEntries(plugin, view, params) {
  const entries = [];
  const add = (title, action, options = {}) => entries.push({ kind: "item", title: t(title), action, ...options });
  const separator = () => {
    if (entries.length > 0 && entries[entries.length - 1]?.kind !== "separator") {
      entries.push({ kind: "separator" });
    }
  };
  const link = params.linkURL?.trim();
  const media = params.srcURL?.trim();
  const selection = params.selectionText?.trim();
  const bookmarkStore = plugin.core.bookmarks;
  const containerMode = typeof plugin.core.settings === "function" ? plugin.core.settings().containerMode : "automatic";
  if (link) {
    add("Open link", () => view.navigate(link), { icon: "external-link" });
    add("Open link in new tab", () => void plugin.openBrowser({ url: link }), { icon: "plus" });
    add("Open link in background tab", () => void plugin.openBrowser({ url: link, reveal: false }), { icon: "copy-plus" });
    add("Open link in new window", () => void plugin.openBrowser({ url: link, placement: "window" }), { icon: "picture-in-picture" });
    if (containerMode !== "off") {
      for (const container of plugin.core.containers.list()) {
        add(t("Open link in {name}", { name: container.name }), () => void plugin.openBrowser({ url: link, containerId: container.id }), { icon: "box" });
      }
    }
    const linkedBookmark = bookmarkStore?.findByUrl?.(link);
    add(linkedBookmark ? "Remove bookmark" : "Bookmark link", () => {
      bookmarkStore?.toggleBookmark?.({ title: params.linkText || link, url: link });
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    }, { icon: linkedBookmark ? "bookmark-check" : "bookmark" });
    add("Copy link", () => void navigator.clipboard.writeText(link), { icon: "copy" });
    add("Show link in history", () => view.showHistoryQuery(link), { icon: "history" });
    separator();
  }
  if (media && params.mediaType === "image") {
    const imageMatchesLink = Boolean(link && link === media);
    if (!imageMatchesLink) {
      add("Open image in new tab", () => void plugin.openBrowser({ url: media }), { icon: "image" });
    }
    add("Copy image", () => view.copyWebImageAt(params.x, params.y), { icon: "copy" });
    if (!imageMatchesLink) {
      add("Copy image URL", () => void navigator.clipboard.writeText(media), { icon: "copy" });
    }
    add("Download image", () => view.downloadWebResource(media), { icon: "download" });
    separator();
  }
  if (selection && !params.isEditable) {
    const shown = selection.slice(0, 40) + (selection.length > 40 ? "\u2026" : "");
    add(t("Search \u201C{query}\u201D", { query: shown }), () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
    add("Copy selected text", () => void navigator.clipboard.writeText(selection), { icon: "copy" });
    separator();
  }
  if (params.isEditable) {
    const flags = params.editFlags ?? {};
    add("Undo", () => view.executeWebEdit("undo"), { disabled: flags.canUndo === false });
    add("Redo", () => view.executeWebEdit("redo"), { disabled: flags.canRedo === false });
    separator();
    add("Cut", () => view.executeWebEdit("cut"), { disabled: flags.canCut === false });
    add("Copy", () => view.executeWebEdit("copy"), { disabled: flags.canCopy === false });
    add("Paste", () => view.executeWebEdit("paste"), { disabled: flags.canPaste === false });
    add("Delete", () => view.executeWebEdit("delete"), { disabled: flags.canDelete === false });
    add("Select all", () => view.executeWebEdit("selectAll"), { disabled: flags.canSelectAll === false });
    separator();
    if (selection) {
      const shown = selection.slice(0, 40) + (selection.length > 40 ? "\u2026" : "");
      add(t("Search \u201C{query}\u201D", { query: shown }), () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
      separator();
    }
  }
  if (params.isEditable && view.hasRecoverableFormValues()) {
    add("Restore previous value", () => void view.restoreFocusedFormValue(), { icon: "form-input" });
    add("Restore all saved form values", () => void view.restoreFormValues(), { icon: "form-input" });
    add("Show saved form values", () => view.showRecoveryCandidates());
    add("Disable recovery for this field", () => void view.disableFocusedFormRecoveryField(), { icon: "circle-off" });
    separator();
  }
  if (params.isEditable && view.formRecoveryEnabledForSite()) {
    add("Disable form recovery for this site", () => view.disableFormRecoveryForSite(), { icon: "shield-off" });
    separator();
  } else if (params.isEditable && view.formRecoveryMasterEnabled()) {
    add("Enable form recovery for this site", () => view.enableFormRecoveryForSite(), { icon: "shield-check" });
    separator();
  }
  const contextualTarget = Boolean(link || media || selection || params.isEditable);
  if (!contextualTarget) {
    const currentPageBookmarked = typeof view.currentPageBookmarked === "function" ? view.currentPageBookmarked() : false;
    add("Back", () => view.goBack(), { icon: "arrow-left", disabled: !view.canGoBack() });
    add("Forward", () => view.goForward(), { icon: "arrow-right", disabled: !view.canGoForward() });
    add("Reload", () => view.reload(), { icon: "rotate-cw" });
    add("Hard reload", () => view.hardReload());
    add("Stop loading", () => view.stopLoading());
    separator();
    add("Home", () => view.showInternal("home"), { icon: "home" });
    add(currentPageBookmarked ? "Edit bookmark" : "Bookmark this page", () => view.bookmarkCurrentPage(), {
      icon: currentPageBookmarked ? "bookmark-check" : "bookmark"
    });
    add("Copy page URL", () => void navigator.clipboard.writeText(view.currentUrl()), { icon: "copy" });
    add("View page in history", () => view.showHistoryQuery(view.currentUrl()), { icon: "history" });
    if (containerMode !== "off") {
      add("Reopen in container\u2026", () => view.openContainerPicker(), { icon: "boxes" });
    }
    separator();
    add("Zoom in", () => view.zoomIn(), { icon: "zoom-in" });
    add("Zoom out", () => view.zoomOut(), { icon: "zoom-out" });
    add("Reset site zoom", () => view.resetZoom());
    add("Inspect page", () => view.inspectPage(), { icon: "code" });
  }
  while (entries[entries.length - 1]?.kind === "separator") entries.pop();
  return entries;
}

// src/ui/popup-dismissal.ts
var openMenus = /* @__PURE__ */ new Map();
var installedDocuments = /* @__PURE__ */ new WeakSet();
var trackedMenus = /* @__PURE__ */ new WeakSet();
function showDismissibleMenu(menu, show, doc = document) {
  dismissOpenMenus(doc);
  trackDismissibleMenu(menu, doc);
  show();
}
function trackDismissibleMenu(menu, doc = document) {
  if (trackedMenus.has(menu)) return;
  trackedMenus.add(menu);
  let menus = openMenus.get(doc);
  if (!menus) {
    menus = /* @__PURE__ */ new Set();
    openMenus.set(doc, menus);
  }
  menus.add(menu);
  menu.onHide(() => {
    menus?.delete(menu);
    if (menus?.size === 0) openMenus.delete(doc);
  });
  if (!installedDocuments.has(doc)) {
    installedDocuments.add(doc);
    doc.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu")) return;
      dismissOpenMenus(doc);
    }, true);
  }
}
function dismissOpenMenus(doc = document) {
  for (const menu of [...openMenus.get(doc) ?? []]) menu.hide();
}

// src/ui/context-menus.ts
function showPageMenu(plugin, view, event) {
  const menu = new import_obsidian9.Menu();
  menu.addItem(
    (item) => item.setTitle(t("Back")).setIcon("arrow-left").setDisabled(!view.canGoBack()).onClick(() => view.goBack())
  );
  menu.addItem(
    (item) => item.setTitle(t("Forward")).setIcon("arrow-right").setDisabled(!view.canGoForward()).onClick(() => view.goForward())
  );
  menu.addItem((item) => item.setTitle(t("Reload")).setIcon("rotate-cw").onClick(() => view.reload()));
  menu.addItem((item) => item.setTitle(t("Stop loading")).setIcon("square").onClick(() => view.stopLoading()));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Open home")).setIcon("home").onClick(() => view.showInternal("home")));
  menu.addItem((item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => plugin.openBrowserTabSearch()));
  menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => plugin.openQuickSwitcher()));
  menu.addItem(
    (item) => item.setTitle(view.currentPageBookmarked() ? t("Edit bookmark") : t("Bookmark this page")).setIcon(view.currentPageBookmarked() ? "bookmark-check" : "bookmark").onClick(() => view.bookmarkCurrentPage())
  );
  menu.addItem((item) => item.setTitle(t("Copy page URL")).setIcon("copy").onClick(async () => {
    await navigator.clipboard.writeText(view.currentUrl());
    new import_obsidian9.Notice(t("URL copied."));
  }));
  menu.addItem(
    (item) => item.setTitle(t("View page in history")).setIcon("history").onClick(() => view.showHistoryQuery(view.currentUrl()))
  );
  if (view.hasRecoverableFormValues()) {
    menu.addItem(
      (item) => item.setTitle(t("Restore saved form values")).setIcon("form-input").onClick(() => view.restoreFormValues())
    );
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Zoom in")).setIcon("zoom-in").onClick(() => view.zoomIn()));
  menu.addItem((item) => item.setTitle(t("Zoom out")).setIcon("zoom-out").onClick(() => view.zoomOut()));
  menu.addItem((item) => item.setTitle(t("Reset site zoom")).onClick(() => view.resetZoom()));
  menu.addItem((item) => item.setTitle(t("Inspect page")).setIcon("code").onClick(() => view.inspectPage()));
  if (plugin.core.settings().containerMode !== "off") {
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle(t("Container\u2026")).setIcon("boxes").onClick(() => view.openContainerPicker())
    );
  }
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}
function showWebContentMenu(plugin, view, params, position) {
  const menu = new import_obsidian9.Menu();
  for (const entry of buildWebContentMenuEntries(plugin, view, params)) {
    if (entry.kind === "separator") {
      menu.addSeparator();
      continue;
    }
    menu.addItem((item) => {
      item.setTitle(entry.title);
      if (entry.icon) item.setIcon(entry.icon);
      if (entry.disabled) item.setDisabled(true);
      item.onClick(entry.action);
    });
  }
  showDismissibleMenu(menu, () => menu.showAtPosition(position));
}
function showBookmarkMenu(plugin, view, bookmark, event) {
  const menu = new import_obsidian9.Menu();
  menu.addItem((item) => item.setTitle(t("Open")).setIcon("external-link").onClick(() => view.navigate(resolveBookmarkUrl(bookmark.url, plugin.app))));
  menu.addItem((item) => item.setTitle(t("Open in new tab")).setIcon("plus").onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app) })));
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle(t("Open in {v0}", { v0: container.name })).setIcon("box").onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app), containerId: container.id }))
      );
    }
  }
  menu.addItem((item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => navigator.clipboard.writeText(bookmark.url)));
  menu.addSeparator();
  menu.addItem(
    (item) => item.setTitle(bookmark.favorite ? t("Remove from favorites") : t("Add to favorites")).setIcon(bookmark.favorite ? "star-off" : "star").onClick(() => {
      plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })
  );
  menu.addItem((item) => item.setTitle(t("Edit")).setIcon("pencil").onClick(async () => {
    const draft = await editBookmark(plugin.app, bookmark.title, bookmark.url, t("Edit bookmark"), {
      store: plugin.core.bookmarks,
      parentId: bookmark.parentId,
      mediaType: bookmark.mediaType,
      favorite: bookmark.favorite,
      visualKind: bookmark.visualKind,
      visualValue: bookmark.visualValue,
      description: bookmark.description,
      tags: bookmark.tags
    });
    if (!draft) return;
    if (!plugin.core.bookmarks.updateBookmark(bookmark.id, draft)) return;
    if (draft.parentId !== void 0) plugin.core.bookmarks.moveBookmark(bookmark.id, draft.parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Move to folder")).setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks);
    if (parentId === void 0) return;
    plugin.core.bookmarks.moveBookmark(bookmark.id, parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Show in history")).setIcon("history").onClick(() => view.showHistoryQuery(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Delete")).setIcon("trash").onClick(() => {
    void (async () => {
      const confirmed = await confirmAction(
        plugin.app,
        t("Delete bookmark"),
        t("Delete \u201C{v0}\u201D from your bookmarks?", { v0: bookmark.title || bookmark.url }),
        t("Delete bookmark")
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteBookmark(bookmark.id);
      plugin.core.scheduleSave();
      view.renderFavoritesBar();
      if (view.currentInternalSurface() === "bookmarks") view.showInternal("bookmarks");
    })();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}
function showBookmarkFolderMenu(plugin, view, folder, event) {
  const menu = new import_obsidian9.Menu();
  const bookmarks = plugin.core.bookmarks.descendantBookmarks(folder.id);
  menu.addItem(
    (item) => item.setTitle(t("Open all")).setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks, void 0, true))
  );
  menu.addItem(
    (item) => item.setTitle(t("Open all in new tabs")).setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks))
  );
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle("Open all in " + container.name).setIcon("box").setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks, container.id))
      );
    }
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("New bookmark")).setIcon("bookmark-plus").onClick(async () => {
    const draft = await editBookmark(plugin.app, "", "", t("New bookmark"), { store: plugin.core.bookmarks, parentId: folder.id });
    if (!draft) return;
    plugin.core.bookmarks.addBookmark(draft);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("New folder")).setIcon("folder-plus").onClick(async () => {
    const title = await promptText(plugin.app, t("New bookmark folder"), "", t("Folder name"));
    if (title === void 0) return;
    plugin.core.bookmarks.addFolder(title, folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Rename")).setIcon("pencil").onClick(async () => {
    const title = await promptText(plugin.app, t("Rename bookmark folder"), folder.title, t("Folder name"));
    if (title === void 0) return;
    plugin.core.bookmarks.renameFolder(folder.id, title);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Move")).setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks, { excludeFolderId: folder.id });
    if (parentId === void 0) return;
    if (!plugin.core.bookmarks.moveFolder(folder.id, parentId)) {
      new import_obsidian9.Notice(t("That move would create an invalid bookmark-folder cycle."));
      return;
    }
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Sort contents")).setIcon("arrow-down-a-z").onClick(() => {
    plugin.core.bookmarks.sortChildren(folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle(t("Delete folder")).setIcon("trash").onClick(() => {
    void (async () => {
      const descendants = plugin.core.bookmarks.descendantBookmarks(folder.id);
      const confirmed = await confirmAction(
        plugin.app,
        t("Delete bookmark folder"),
        descendants.length ? t("Delete \u201C{v0}\u201D and its {v1} bookmark{v2}?", { v0: folder.title, v1: descendants.length, v2: descendants.length === 1 ? "" : "s" }) : t("Delete the empty folder \u201C{v0}\u201D?", { v0: folder.title }),
        t("Delete folder")
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteFolder(folder.id);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}
function showFavoritesBarMenu(plugin, view, event) {
  const menu = new import_obsidian9.Menu();
  if (!view.currentUrl().startsWith("browser://")) {
    menu.addItem((item) => item.setTitle(t("Add current page to favorites")).setIcon("star").onClick(() => view.favoriteCurrentPage()));
  }
  menu.addItem((item) => item.setTitle(t("Open bookmarks")).setIcon("book-open").onClick(() => view.showInternal("bookmarks")));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle(t("Hide favorites bar")).onClick(() => {
    plugin.core.updateSettings({ showFavoritesBar: false });
    plugin.refreshBrowserViews();
  }));
  showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument : document);
}

// src/ui/recovery-details-modal.ts
var import_obsidian10 = require("obsidian");
function showRecoveryDetails(app, details) {
  new RecoveryDetailsModal(app, details).open();
}
var RecoveryDetailsModal = class extends import_obsidian10.Modal {
  constructor(app, details) {
    super(app);
    this.details = details;
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: t("Recovery details") });
    const list = this.contentEl.createEl("dl", { cls: "ubc-recovery-details" });
    addRow(list, "URL", this.details.url || "Unknown");
    addRow(list, "Detailed tab state", this.details.richRestoreAvailable ? "Available" : "Not available");
    addRow(
      list,
      "Saved back/forward pages",
      `${this.details.navigationEntries} page${this.details.navigationEntries === 1 ? "" : "s"}`
    );
    addRow(
      list,
      "Saved form values",
      `${this.details.formFields} field${this.details.formFields === 1 ? "" : "s"}`
    );
    addRow(
      list,
      "Reopen behavior",
      this.details.stale ? "Reload the saved URL and use available site data" : "Restore detailed tab state when possible"
    );
    this.contentEl.createEl("p", {
      text: t("Browser Core does not save a full live copy of the page. Some page state can only be restored by the browser engine, while saved form values and the website's own drafts are recovered separately.")
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: t("Close") }).addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
};
function addRow(parent, term, value) {
  parent.createEl("dt", { text: term });
  parent.createEl("dd", { text: value });
}

// src/ui/form-recovery-candidates-modal.ts
var import_obsidian11 = require("obsidian");
function showFormRecoveryCandidates(app, fields, restoreSafeMatches) {
  new FormRecoveryCandidatesModal(app, fields, restoreSafeMatches).open();
}
var FormRecoveryCandidatesModal = class extends import_obsidian11.Modal {
  constructor(app, fields, restoreSafeMatches) {
    super(app);
    this.fields = fields;
    this.restoreSafeMatches = restoreSafeMatches;
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: t("Saved form values") });
    this.contentEl.createEl("p", {
      text: t("These values were saved for this page. Browser Core restores only fields it can match confidently; ambiguous fields remain unchanged.")
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
  onClose() {
    this.contentEl.empty();
  }
};
function fieldLabel(field) {
  return field.label || field.ariaLabel || field.placeholder || field.name || field.id || "Unnamed field";
}
function fieldTypeLabel(type) {
  const labels = {
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
    color: "Color"
  };
  return labels[type] ?? humanizeToken(type || "field");
}
function fieldDetails(field) {
  const label = fieldLabel(field);
  const details = [];
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
  return details.join(" \xB7 ");
}
function humanizeToken(value) {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Field";
}
function fieldValue(field) {
  if (field.type === "checkbox" || field.type === "radio") {
    return field.checked ? "Selected" : "Not selected";
  }
  if (field.values?.length) return field.values.join(", ");
  if (typeof field.value === "string") return truncate(field.value, 240);
  return "Saved state available";
}
function truncate(value, max) {
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
}

// src/navigation/address-normalizer.ts
function normalizeBrowserAddress(value, searchUrl) {
  const trimmed = value.trim();
  if (!trimmed) return "browser://home";
  if (/^browser:\/\//i.test(trimmed)) {
    return "browser://" + trimmed.slice("browser://".length).toLowerCase();
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const inferred = inferWebAddress(trimmed);
  return inferred ?? searchUrl(trimmed);
}
function inferWebAddress(value) {
  if (/\s/.test(value) || value.includes("@")) return void 0;
  let parsed;
  try {
    parsed = new URL("https://" + value);
  } catch {
    return void 0;
  }
  const hostname = parsed.hostname;
  if (!hostname) return void 0;
  if (hostname === "localhost" || isIpv4(hostname) || isBracketedIpv6(value)) {
    return "http://" + value;
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return void 0;
  const suffix = labels.at(-1) ?? "";
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(suffix)) return void 0;
  return "https://" + value;
}
function isIpv4(hostname) {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}
function isBracketedIpv6(value) {
  return /^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#]|$)/i.test(value);
}

// src/ui/bookmark-popover.ts
var import_obsidian12 = require("obsidian");
function showBookmarkPopover(plugin, bookmark, anchor, content, onClose) {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView ?? window;
  const dismiss = content.createDiv({ cls: "ubc-menu-dismiss-layer" });
  const panel = doc.body.createDiv({ cls: "ubc-bookmark-popover", attr: { role: "dialog", "aria-label": t("Edit bookmark") } });
  panel.style.maxWidth = `${Math.max(0, doc.documentElement.clientWidth - 16)}px`;
  const header = panel.createDiv({ cls: "ubc-bookmark-popover-heading" });
  renderBookmarkVisual(header, bookmark, "ubc-bookmark-editor-preview-icon", plugin.app);
  const heading = header.createDiv();
  heading.createEl("strong", { text: t("Bookmark saved") });
  heading.createDiv({ cls: "ubc-bookmark-meta", text: bookmark.url });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove();
    dismiss.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", escape, true);
    win.removeEventListener("resize", close);
    onClose?.();
  };
  const outside = (event) => {
    if (!panel.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const escape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    anchor.focus();
  };
  dismiss.addEventListener("pointerdown", close);
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", escape, true);
  win.addEventListener("resize", close);
  const save = () => {
    plugin.core.scheduleSave();
    plugin.refreshBrowserViews();
  };
  const field = (label) => {
    const container = panel.createEl("label", { cls: "ubc-prompt-field" });
    container.createSpan({ cls: "ubc-prompt-label", text: t(label) });
    return container;
  };
  const name = field("Title").createEl("input", { attr: { type: "text" } });
  name.value = bookmark.title;
  name.addEventListener("input", () => {
    plugin.core.bookmarks.updateBookmark(bookmark.id, { title: name.value });
    save();
  });
  const folderField = field("Save in");
  const folderRow = folderField.createDiv({ cls: "ubc-bookmark-folder-select" });
  const folder = folderRow.createEl("select");
  const renderFolders = () => {
    folder.empty();
    folder.createEl("option", { value: "", text: t("Bookmarks root") });
    for (const item of plugin.core.bookmarks.folders()) {
      folder.createEl("option", { value: item.id, text: plugin.core.bookmarks.folderPath(item.id) });
    }
    folder.value = bookmark.parentId ?? "";
  };
  renderFolders();
  folder.addEventListener("change", () => {
    plugin.core.bookmarks.moveBookmark(bookmark.id, folder.value || null);
    save();
  });
  const newFolder = folderRow.createEl("button", { attr: { type: "button", title: t("New folder"), "aria-label": t("New folder") } });
  (0, import_obsidian12.setIcon)(newFolder, "folder-plus");
  newFolder.addEventListener("click", async () => {
    const title = await promptText(plugin.app, t("New bookmark folder"), "", t("Folder name"));
    if (!title?.trim() || !plugin.core.bookmarks.getBookmark(bookmark.id)) return;
    const created = plugin.core.bookmarks.addFolder(title, bookmark.parentId);
    plugin.core.bookmarks.moveBookmark(bookmark.id, created.id);
    save();
    renderFolders();
  });
  const type = field("Media type").createEl("select");
  type.createEl("option", { value: "", text: t("Detected: {type}", { type: t(BOOKMARK_MEDIA.find((entry) => entry.type === inferBookmarkMedia(bookmark.url)).label) }) });
  for (const entry of BOOKMARK_MEDIA) type.createEl("option", { value: entry.type, text: t(entry.label) });
  type.value = bookmark.mediaType ?? "";
  type.addEventListener("change", () => {
    plugin.core.bookmarks.updateBookmark(bookmark.id, { mediaType: type.value || void 0 });
    save();
  });
  const selectedField = panel.createEl("label", { cls: "ubc-selected-check" });
  const selected = selectedField.createEl("input", { attr: { type: "checkbox" } });
  selected.checked = bookmark.favorite;
  const selectedLabel = selectedField.createDiv();
  selectedLabel.createEl("strong", { text: t("Show in selected members") });
  selectedLabel.createDiv({ cls: "ubc-bookmark-meta", text: t("Your everyday pages, one click away.") });
  selected.addEventListener("change", () => {
    plugin.core.bookmarks.setFavorite(bookmark.id, selected.checked);
    save();
  });
  const details = panel.createEl("details", { cls: "ubc-bookmark-details" });
  details.createEl("summary", { text: t("Details") });
  const description = details.createEl("input", { attr: { placeholder: t("Description"), "aria-label": t("Description") } });
  description.value = bookmark.description ?? "";
  description.addEventListener("input", () => {
    plugin.core.bookmarks.updateBookmark(bookmark.id, { description: description.value });
    save();
  });
  const tags = details.createEl("input", { attr: { placeholder: t("Separate tags with spaces"), "aria-label": t("Tags") } });
  tags.value = (bookmark.tags ?? []).join(" ");
  tags.addEventListener("input", () => {
    plugin.core.bookmarks.updateBookmark(bookmark.id, { tags: tags.value.trim().split(/\s+/).filter(Boolean) });
    save();
  });
  const footer = panel.createDiv({ cls: "ubc-modal-actions" });
  const remove = footer.createEl("button", { text: t("Delete bookmark"), cls: "ubc-bookmark-remove" });
  remove.addEventListener("click", () => {
    plugin.core.bookmarks.deleteBookmark(bookmark.id);
    save();
    close();
  });
  footer.createEl("button", { text: t("Done"), cls: "mod-cta" }).addEventListener("click", () => {
    close();
    anchor.focus();
  });
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, doc.documentElement.clientWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(rect.bottom + 8, win.innerHeight - panel.offsetHeight - 8))}px`;
  name.focus();
  name.select();
  return close;
}

// src/ui/browser-view.ts
var BROWSER_VIEW_TYPE = "unified-browser-core-view";
var BrowserView = class _BrowserView extends import_obsidian13.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }
  rootEl;
  toolbarEl;
  backButtonEl;
  forwardButtonEl;
  reloadButtonEl;
  favoritesBarEl;
  bookmarkButtonEl;
  recoveryBannerEl;
  browserContentEl;
  webLayerEl;
  internalLayerEl;
  loadingShieldEl;
  addressEl;
  containerButtonEl;
  activeContainerMenu = null;
  statusEl;
  browserHeaderTitleEl = null;
  browserHeaderEl = null;
  historySearchEl = null;
  webview = null;
  webviewDomReady = false;
  internalSurface = null;
  containerId = "default";
  siteAssignmentBypassOrigin;
  siteAssignmentBypassReason;
  faviconDataUrl;
  faviconSourceUrl;
  currentTitle = "New tab";
  currentUrlValue = "browser://home";
  pendingHistoryIntent = null;
  lastNavigatedUrl = "";
  lifecycleId = createId("leaf");
  pinned = false;
  stateInitialized = false;
  pendingViewState;
  manualRetention = "default";
  restoredFromLeafId;
  restoreTargetUrl;
  restoreTargetIndex;
  checkpointTimer;
  popupDisposer;
  contextMenuDisposer;
  formRecoveryWatchEnabled = false;
  richRestoreAttempted = false;
  restoreIntentGeneration = 0;
  pendingInitialWebUrl;
  ignoreBootstrapAboutBlank = false;
  clearBootstrapHistoryAfterFallback = false;
  transientHistory = [];
  transientIndex = -1;
  pendingTransientTraversalIndex = null;
  historyObserver = null;
  historyRevealNodeId;
  closeReasonOverride;
  expandedHistoryBranches = /* @__PURE__ */ new Set();
  expandedResidualParents = /* @__PURE__ */ new Set();
  collapsedBookmarkFolders = /* @__PURE__ */ new Set();
  bookmarkSearchQuery = "";
  bookmarkLayout = "type";
  bookmarkPopoverClose;
  recoveryInteractionDisposer;
  popupInteractionDisposer;
  navigationHistoryAdapter = new ElectronNavigationHistoryAdapter();
  leafId() {
    return this.lifecycleId;
  }
  refreshLeafHeader() {
    const container = this.leaf.getContainer();
    const activeInWindow = this.plugin.app.workspace.getMostRecentLeaf(container) === this.leaf;
    this.plugin.tabStripAdapter.refreshLeafHeader(this.leaf, activeInWindow);
    window.requestAnimationFrame(() => {
      this.applyTabStyle();
    });
  }
  getViewType() {
    return BROWSER_VIEW_TYPE;
  }
  getDisplayText() {
    return this.currentTitle || "Browser";
  }
  getIcon() {
    return "globe";
  }
  async onOpen() {
    this.rootEl = this.contentEl;
    this.rootEl.empty();
    this.rootEl.addClass("ubc-browser-view");
    this.applyAccessibility();
    this.registerDomEvent(this.rootEl.ownerDocument, "pointerdown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu")) return;
      this.dismissTransientPopups();
    }, true);
    this.registerEvent(this.leaf.on("pinned-change", (pinned) => {
      this.pinned = pinned;
      this.plugin.core.history.touchLeaf(this.leafId(), { pinned });
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      this.applyTabStyle();
    }));
    this.buildChrome();
    this.applyTabStyle();
    if (this.pendingViewState) {
      const pending = this.pendingViewState;
      this.pendingViewState = void 0;
      this.applyViewState(pending);
    }
  }
  async onClose() {
    this.activeContainerMenu?.hide();
    await this.captureRecoveryState();
    this.disconnectHistoryObserver();
    if (this.webview) await this.teardownFormRecoveryInstrumentation(this.webview);
    this.destroyWebview();
    this.clearTabStyle();
    this.browserHeaderTitleEl?.removeClass("ubc-browser-title-container");
    this.browserHeaderEl?.removeClass("ubc-browser-view-header");
    this.browserHeaderTitleEl = null;
    this.browserHeaderEl = null;
    if (this.plugin.isUnloading()) {
      this.finalizeClose("shutdown");
      return;
    }
    if (this.closeReasonOverride) {
      this.finalizeClose(this.closeReasonOverride);
      return;
    }
    window.setTimeout(() => {
      let leafStillExists = false;
      this.plugin.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf === this.leaf) leafStillExists = true;
      });
      const reason = leafStillExists && this.leaf.view !== this ? "view-replaced" : "user";
      this.finalizeClose(reason);
    }, 0);
  }
  finalizeClose(reason) {
    this.plugin.core.history.closeLeaf(this.leafId(), reason);
    this.plugin.core.scheduleSave();
  }
  getState() {
    return {
      lifecycleId: this.lifecycleId,
      bookmarkLayout: this.bookmarkLayout,
      title: this.currentTitle,
      faviconDataUrl: this.faviconDataUrl,
      url: this.currentUrlValue,
      containerId: this.containerId,
      siteAssignmentBypassOrigin: this.siteAssignmentBypassOrigin,
      siteAssignmentBypassReason: this.siteAssignmentBypassReason,
      pinned: this.pinned,
      manualRetention: this.manualRetention,
      restoredFromLeafId: this.restoredFromLeafId,
      internalSurface: this.internalSurface ?? void 0,
      transientHistory: [...this.transientHistory],
      transientIndex: this.transientIndex
    };
  }
  async setState(state, result) {
    await super.setState(state, result);
    if (!this.rootEl) {
      this.pendingViewState = { ...state };
      return;
    }
    this.applyViewState(state);
  }
  applyViewState(state) {
    if (state.bookmarkLayout) this.bookmarkLayout = state.bookmarkLayout;
    const url = state.url || (state.internalSurface ? "browser://" + state.internalSurface : "browser://home");
    const requestedContainer = this.plugin.core.normalizeContainer(state.containerId);
    const initialState = !this.stateInitialized;
    if (!initialState && requestedContainer !== this.containerId) {
      void this.replaceCurrentTab({
        url,
        containerId: requestedContainer,
        state: {
          pinned: state.pinned,
          manualRetention: state.manualRetention ?? this.manualRetention,
          siteAssignmentBypassOrigin: state.siteAssignmentBypassOrigin,
          siteAssignmentBypassReason: state.siteAssignmentBypassReason,
          restoreTargetUrl: state.restoreTargetUrl,
          restoreTargetIndex: state.restoreTargetIndex,
          internalSurface: state.internalSurface,
          transientHistory: state.transientHistory,
          transientIndex: state.transientIndex
        }
      });
      return;
    }
    if (initialState) {
      const savedLeaf = this.plugin.core.state.history.leaves[state.lifecycleId ?? state.restoredFromLeafId ?? ""];
      const savedEntry = state.transientHistory?.[state.transientIndex ?? state.transientHistory.length - 1];
      const savedTitle = state.title ?? (savedEntry?.kind === "web" ? savedEntry.title : void 0) ?? savedLeaf?.lastTitle;
      this.currentTitle = savedTitle?.trim() || url;
      this.faviconDataUrl = validSavedFavicon(state.faviconDataUrl);
      this.refreshLeafHeader();
      if (state.lifecycleId) this.lifecycleId = state.lifecycleId;
      this.containerId = requestedContainer;
      this.pinned = state.pinned ?? this.pinned;
    }
    this.manualRetention = state.manualRetention ?? this.manualRetention;
    this.siteAssignmentBypassOrigin = state.siteAssignmentBypassOrigin;
    this.siteAssignmentBypassReason = state.siteAssignmentBypassReason ?? (state.siteAssignmentBypassOrigin ? "explicit" : void 0);
    this.restoredFromLeafId = state.restoredFromLeafId;
    this.restoreTargetUrl = state.restoreTargetUrl;
    this.restoreTargetIndex = state.restoreTargetIndex;
    if (state.transientHistory) this.transientHistory = [...state.transientHistory];
    else if (initialState) this.transientHistory = [];
    this.transientIndex = typeof state.transientIndex === "number" ? state.transientIndex : this.transientHistory.length - 1;
    if (initialState) {
      this.plugin.core.history.beginLeaf({
        leafId: this.leafId(),
        containerId: this.containerId,
        pinned: this.pinned,
        manualRetention: this.manualRetention,
        restoredFromLeafId: this.restoredFromLeafId,
        url
      });
      this.stateInitialized = true;
    } else {
      this.plugin.core.history.touchLeaf(this.leafId(), {
        containerId: this.containerId,
        pinned: this.pinned,
        manualRetention: this.manualRetention,
        restoredFromLeafId: this.restoredFromLeafId,
        lastUrl: url
      });
    }
    if (url.startsWith("browser://")) {
      this.showInternal(
        url.slice("browser://".length) || "home",
        this.transientHistory.length === 0,
        false
      );
    } else {
      this.navigate(url);
    }
    this.refreshNavigationButtons();
  }
  currentUrl() {
    return this.currentUrlValue;
  }
  zoomIn() {
    this.applyZoom(this.plugin.core.zoom.adjust(this.currentUrlValue, 0.1));
  }
  zoomOut() {
    this.applyZoom(this.plugin.core.zoom.adjust(this.currentUrlValue, -0.1));
  }
  resetZoom() {
    this.plugin.core.zoom.reset(this.currentUrlValue);
    this.applyZoom(this.plugin.core.zoom.factorForUrl(this.currentUrlValue));
  }
  refreshZoom() {
    const webview = this.readyWebview();
    if (!webview) return;
    const desired = hostZoomFactor(this.rootEl.ownerDocument) * this.plugin.core.zoom.factorForUrl(this.currentUrlValue);
    if (!webview.getZoomFactor || Math.abs(webview.getZoomFactor() - desired) > 1e-3) webview.setZoomFactor?.(desired);
  }
  inspectPage() {
    this.readyWebview()?.openDevTools?.();
  }
  executeWebEdit(command) {
    this.readyWebview()?.[command]?.();
  }
  copyWebImageAt(x, y) {
    this.readyWebview()?.copyImageAt?.(x, y);
  }
  downloadWebResource(url) {
    this.readyWebview()?.downloadURL?.(url);
  }
  refreshBookmarks() {
    this.renderFavoritesBar();
    this.updateBookmarkButton();
    if (this.internalSurface === "bookmarks") this.showInternal("bookmarks", false);
  }
  showHistoryQuery(query) {
    this.showInternal("history");
    window.requestAnimationFrame(() => {
      if (!this.historySearchEl) return;
      this.historySearchEl.value = query;
      this.historySearchEl.dispatchEvent(new Event("input"));
      this.historySearchEl.focus();
    });
  }
  openBookmarkSet(bookmarks, containerId, useCurrent = false) {
    if (!bookmarks.length) return;
    let start = 0;
    if (useCurrent) {
      const first = bookmarks[0];
      if (first) {
        if (containerId && containerId !== this.containerId) {
          void this.plugin.openBrowser({ url: resolveBookmarkUrl(first.url, this.plugin.app), containerId });
        } else this.navigate(resolveBookmarkUrl(first.url, this.plugin.app));
        start = 1;
      }
    }
    for (let index = start; index < bookmarks.length; index++) {
      const bookmark = bookmarks[index];
      if (bookmark) void this.plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, this.plugin.app), containerId });
    }
  }
  bookmarkAllOpenTabs() {
    const views = this.plugin.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap(
      (leaf) => leaf.view instanceof _BrowserView ? [leaf.view] : []
    );
    const webViews = views.filter((view) => !view.currentUrl().startsWith("browser://"));
    if (!webViews.length) {
      new import_obsidian13.Notice(t("There are no web pages to bookmark."));
      return;
    }
    const newViews = webViews.filter((view) => !this.plugin.core.bookmarks.isBookmarked(view.currentUrl()));
    if (!newViews.length) {
      new import_obsidian13.Notice(t("All open web pages are already bookmarked."));
      return;
    }
    const folder = this.plugin.core.bookmarks.addFolder(
      "Open tabs " + (/* @__PURE__ */ new Date()).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
    );
    for (const view of newViews) {
      this.plugin.core.bookmarks.addBookmark({
        title: view.getDisplayText(),
        url: view.currentUrl(),
        parentId: folder.id
      });
    }
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    new import_obsidian13.Notice("Bookmarked " + newViews.length + " open browser tab(s)." + (newViews.length < webViews.length ? " Existing bookmarks were skipped." : ""));
  }
  currentPageBookmarked() {
    return !this.currentUrlValue.startsWith("browser://") && this.plugin.core.bookmarks.isBookmarked(this.currentUrlValue);
  }
  focusAddressBar() {
    this.addressEl?.focus();
    this.addressEl?.select();
  }
  focusHistorySearch() {
    if (this.internalSurface !== "history") this.showInternal("history");
    window.requestAnimationFrame(() => {
      this.historySearchEl?.focus();
      this.historySearchEl?.select();
    });
  }
  focusHomeSearch() {
    if (this.internalSurface !== "home") return;
    window.requestAnimationFrame(() => {
      this.internalLayerEl.querySelector(".ubc-home-search")?.focus();
    });
  }
  openContainerPicker() {
    if (!this.containerButtonEl || this.plugin.core.settings().containerMode === "off") return;
    const rect = this.containerButtonEl.getBoundingClientRect();
    this.showContainerMenuAt({ x: rect.left, y: rect.bottom });
  }
  lifecycleIdentity() {
    return this.lifecycleId;
  }
  currentInternalSurface() {
    return this.internalSurface;
  }
  applyTabStyle() {
    const enabled = this.plugin.core.settings().tabStripIntegrationEnabled;
    const containerColor = this.plugin.core.settings().containerMode === "off" ? void 0 : this.plugin.core.containers.get(this.containerId).color;
    this.plugin.tabStripAdapter.applyLeafStyle(
      this.leaf,
      resolveTabLayoutPolicy(this.plugin.core.settings().tabStyle),
      enabled,
      this.pinned,
      containerColor
    );
    if (enabled) this.plugin.tabStripAdapter.applyLeafFavicon(this.leaf, this.faviconDataUrl);
  }
  applyAccessibility() {
    this.rootEl?.toggleClass("ubc-reduced-motion", this.plugin.core.settings().reducedMotion);
  }
  hasRecoverableFormValues() {
    return this.plugin.core.formRecovery.hasForDocument(this.containerId, this.currentUrlValue);
  }
  formRecoveryEnabledForSite() {
    return this.plugin.core.settings().formRecoveryEnabled && this.plugin.core.formRecovery.isEnabledForUrl(this.containerId, this.currentUrlValue);
  }
  formRecoveryMasterEnabled() {
    return this.plugin.core.settings().formRecoveryEnabled;
  }
  refreshContainerPresentation() {
    this.updateContainerIndicator();
    this.applyTabStyle();
  }
  enableFormRecoveryForSite() {
    if (!this.plugin.core.formRecovery.enableSite(this.containerId, this.currentUrlValue)) {
      new import_obsidian13.Notice(t("Form recovery is only available for web pages."));
      return;
    }
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new import_obsidian13.Notice(t("Form recovery enabled for this site."));
  }
  showRecoveryCandidates() {
    const fields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    if (!fields.length) {
      new import_obsidian13.Notice(t("No saved form values are available for this page."));
      return;
    }
    showFormRecoveryCandidates(
      this.plugin.app,
      fields,
      () => void this.restoreFormValues({ watchNextSteps: true })
    );
  }
  disableFormRecoveryForSite() {
    if (!this.plugin.core.formRecovery.disableSite(this.containerId, this.currentUrlValue, true)) {
      new import_obsidian13.Notice(t("Form recovery is only available for web pages."));
      return;
    }
    this.formRecoveryWatchEnabled = false;
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new import_obsidian13.Notice(t("Form recovery disabled and stored form values cleared for this site."));
  }
  async syncFormRecoveryInstrumentation() {
    const webview = this.readyWebview();
    if (!webview) return;
    if (this.formRecoveryEnabledForSite()) {
      await this.installFormRecoveryInstrumentation(webview);
      return;
    }
    await this.teardownFormRecoveryInstrumentation(webview);
  }
  async resetFormRecoveryCaptureBaseline() {
    const webview = this.readyWebview();
    if (!webview?.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        const capture = window.__ubcFormRecoveryCaptureV1;
        if (!capture) return false;
        capture.fields = Object.create(null);
        capture.dirty = false;
        return true;
      })()`);
    } catch {
    }
  }
  async disableFocusedFormRecoveryField() {
    const field = await this.focusedFormField();
    if (!field || !this.plugin.core.formRecovery.excludeField(this.containerId, this.currentUrlValue, field)) {
      new import_obsidian13.Notice(t("Could not identify the focused form field."));
      return;
    }
    this.plugin.core.scheduleSave();
    new import_obsidian13.Notice(t("This form field is excluded from recovery on this site."));
  }
  async restoreFocusedFormValue() {
    const saved = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!saved.length || !webview?.executeJavaScript) {
      new import_obsidian13.Notice(t("No saved form value is available for this page."));
      return;
    }
    const payload = JSON.stringify(saved);
    const restored = await webview.executeJavaScript(`(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
      const saved = ${payload};
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
      const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
      const nearby = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
      let best = null;
      let bestScore = 0;
      for (const old of saved) {
        let score = old.type === type ? 1 : 0;
        if (old.id && el.id === old.id) score += 8;
        if (old.name && el.getAttribute('name') === old.name) score += 6;
        if (old.autocomplete && el.getAttribute('autocomplete') === old.autocomplete) score += 5;
        if (old.ariaLabel && el.getAttribute('aria-label') === old.ariaLabel) score += 5;
        if (old.label && old.label === label) score += 5;
        if (old.placeholder && el.getAttribute('placeholder') === old.placeholder) score += 3;
        if (old.nearbyText && old.nearbyText === nearby) score += 3;
        if (score > bestScore) { best = old; bestScore = score; }
      }
      if (!best || bestScore < 6) return false;
      if (type === 'checkbox' || type === 'radio') el.checked = Boolean(best.checked);
      else if (el instanceof HTMLSelectElement && Array.isArray(best.values)) {
        for (const option of el.options) option.selected = best.values.includes(option.value);
      } else if (typeof best.value === 'string') {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, best.value);
        else el.value = best.value;
      } else return false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    new import_obsidian13.Notice(restored ? t("Restored the previous value for this field.") : t("No matching saved value was found for this field."));
  }
  async restoreFormValues(options = {}) {
    const recoveryFields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!recoveryFields.length || !webview?.executeJavaScript) {
      if (!options.silent) new import_obsidian13.Notice(t("No saved form values for this page."));
      return;
    }
    const watchNextSteps = options.watchNextSteps ?? true;
    if (watchNextSteps) this.formRecoveryWatchEnabled = true;
    const payload = JSON.stringify(recoveryFields);
    const restored = await webview.executeJavaScript(`(() => {
      const saved = ${payload};
      const stateKey = '__ubcFormRecoveryAssistV1';
      const state = window[stateKey] || (window[stateKey] = { touched: new WeakSet(), observer: null, scheduled: false, listening: false, markTouched: null });
      const labelOf = (el) => (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
      const nearbyOf = (el) => {
        const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
        return (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
      };
      const setNativeValue = (el, value) => {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      };
      if (!state.listening) {
        state.markTouched = (event) => {
          if (event.isTrusted && event.target instanceof Element) state.touched.add(event.target);
        };
        document.addEventListener('input', state.markTouched, true);
        document.addEventListener('change', state.markTouched, true);
        state.listening = true;
      }
      const apply = (conservative) => {
        const fields = Array.from(document.querySelectorAll('input, textarea, select'));
        let count = 0;
        for (const old of saved) {
          let best = null;
          let bestScore = 0;
          for (const el of fields) {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          let score = 0;
          if (old.id && el.id === old.id) score += 8;
          if (old.name && el.getAttribute('name') === old.name) score += 6;
          if (old.autocomplete && el.getAttribute('autocomplete') === old.autocomplete) score += 5;
          if (old.ariaLabel && el.getAttribute('aria-label') === old.ariaLabel) score += 5;
          if (old.label && labelOf(el) === old.label) score += 5;
          if (old.placeholder && el.getAttribute('placeholder') === old.placeholder) score += 3;
          if (old.nearbyText && nearbyOf(el) === old.nearbyText) score += 3;
          if (old.value && typeof el.value === 'string' && el.value === old.value) score += 4;
          if (old.type === type) score += 1;
          if (score > bestScore) { bestScore = score; best = el; }
          }
          if (!best || bestScore < 6 || (conservative && state.touched.has(best))) continue;
          const type = (best.getAttribute('type') || best.tagName).toLowerCase();
          if (conservative && type !== 'checkbox' && type !== 'radio' && best.tagName !== 'SELECT' && best.value) continue;
          if (type === 'checkbox' || type === 'radio') {
            best.checked = Boolean(old.checked);
          } else if (best.tagName === 'SELECT' && Array.isArray(old.values)) {
            for (const option of best.options) option.selected = old.values.includes(option.value);
          } else if (typeof old.value === 'string') {
            setNativeValue(best, old.value);
          }
          best.dispatchEvent(new Event('input', { bubbles: true }));
          best.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        return count;
      };
      const initialCount = apply(false);
      if (${watchNextSteps ? "true" : "false"} && !state.observer) {
        state.observer = new MutationObserver(() => {
          if (state.scheduled) return;
          state.scheduled = true;
          requestAnimationFrame(() => {
            state.scheduled = false;
            apply(true);
          });
        });
        state.observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      return initialCount;
    })()`);
    if (!options.silent) {
      new import_obsidian13.Notice(
        restored > 0 ? t("Restored {v0} form field(s).{v1}", { v0: restored, v1: watchNextSteps ? " Matching fields in later form steps will also be restored when they appear." : "" }) : t("No matching fields were found for the saved form values.")
      );
    }
  }
  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    trackDismissibleMenu(menu, this.rootEl?.ownerDocument ?? document);
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Home")).setIcon("home").onClick(() => this.showInternal("home")));
    menu.addItem((item) => item.setTitle(t("History")).setIcon("history").onClick(() => this.showInternal("history")));
    menu.addItem((item) => item.setTitle(t("Bookmarks")).setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
    const closed = this.plugin.core.history.recentlyClosed(1)[0];
    menu.addItem((item) => item.setTitle(t("Reopen closed tab")).setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
      if (closed) void this.plugin.restoreLeaf(closed.id);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Site permissions\u2026")).setIcon("shield-check").onClick((event) => this.showPermissionMenu(event)));
    menu.addItem((item) => item.setTitle(t("Zoom in")).setIcon("zoom-in").onClick(() => this.zoomIn()));
    menu.addItem((item) => item.setTitle(t("Zoom out")).setIcon("zoom-out").onClick(() => this.zoomOut()));
    menu.addItem((item) => item.setTitle(t("Reset site zoom")).onClick(() => this.resetZoom()));
    menu.addItem((item) => item.setTitle(t("Settings")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    menu.addItem((item) => item.setTitle(t("Inspect page")).setIcon("code").onClick(() => this.inspectPage()));
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle(t("Reload")).setIcon("rotate-cw").onClick(() => this.reload())
    );
    const pinned = this.pinned;
    menu.addItem(
      (item) => item.setTitle(pinned ? t("Unpin browser tab") : t("Pin browser tab")).setIcon("pin").onClick(() => {
        this.leaf.setPinned(!pinned);
        this.plugin.core.history.touchLeaf(this.leafId(), { pinned: !pinned });
        this.plugin.core.scheduleSave();
      })
    );
    menu.addItem(
      (item) => item.setTitle(this.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")).setIcon("archive-restore").onClick(() => {
        this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
        this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
        this.plugin.core.scheduleSave();
        this.plugin.scheduleSessionCheckpoint();
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Duplicate browser tab")).setIcon("copy").onClick(() => this.plugin.openBrowser({ url: this.currentUrlValue, containerId: this.containerId }))
    );
    menu.addItem(
      (item) => item.setTitle(t("Move browser tab to new window")).setIcon("picture-in-picture").onClick(() => {
        try {
          this.plugin.app.workspace.moveLeafToPopout(this.leaf);
        } catch {
          new import_obsidian13.Notice(t("This Obsidian build cannot move the tab to a new window."));
        }
      })
    );
    for (const container of this.plugin.core.containers.list()) {
      if (container.id === this.containerId) continue;
      menu.addItem(
        (item) => item.setTitle(t("Reopen in {v0}", { v0: container.name })).setIcon("box").onClick(() => this.reopenInContainer(container.id))
      );
    }
    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem(
        (item) => item.setTitle(t("Bookmark current page")).setIcon("bookmark").onClick(() => this.bookmarkCurrentPage())
      );
      menu.addItem(
        (item) => item.setTitle(t("Copy page URL")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(this.currentUrlValue))
      );
    }
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => this.plugin.openBrowserTabSearch())
    );
    menu.addItem(
      (item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => this.plugin.openQuickSwitcher())
    );
    menu.addSeparator();
    const siblings = this.plugin.tabStripAdapter.leavesInSameGroup(this.leaf).filter((leaf) => leaf.view instanceof _BrowserView);
    const selfIndex = siblings.indexOf(this.leaf);
    menu.addItem(
      (item) => item.setTitle(t("Close browser tabs to the left")).setIcon("panel-left-close").setDisabled(selfIndex <= 0).onClick(() => {
        for (const leaf of siblings.slice(0, selfIndex)) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Close browser tabs to the right")).setIcon("panel-right-close").setDisabled(selfIndex < 0 || selfIndex >= siblings.length - 1).onClick(() => {
        for (const leaf of siblings.slice(selfIndex + 1)) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Close other browser tabs")).setIcon("x").onClick(() => {
        for (const leaf of siblings) if (leaf !== this.leaf) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Close unpinned browser tabs")).setIcon("x-circle").onClick(() => {
        for (const leaf of siblings) {
          if (leaf.view instanceof _BrowserView && !leaf.view.getState().pinned) leaf.detach();
        }
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Close browser tab")).setIcon("x").onClick(() => this.leaf.detach())
    );
  }
  buildChrome() {
    const privateTitleContainer = this.titleContainerEl;
    this.browserHeaderTitleEl = privateTitleContainer ?? this.containerEl.querySelector(".view-header-title-container");
    this.browserHeaderEl = this.browserHeaderTitleEl?.parentElement ?? null;
    const toolbarHost = this.browserHeaderTitleEl ?? this.rootEl;
    if (this.browserHeaderTitleEl) {
      this.browserHeaderTitleEl.empty();
      this.browserHeaderTitleEl.addClass("ubc-browser-title-container");
      this.browserHeaderEl?.addClass("ubc-browser-view-header");
    }
    this.toolbarEl = toolbarHost.createDiv({ cls: "ubc-toolbar" });
    this.backButtonEl = this.addToolbarButton("arrow-left", t("Back"), () => this.goBack());
    this.backButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(-1, event);
    });
    this.forwardButtonEl = this.addToolbarButton("arrow-right", t("Forward"), () => this.goForward());
    this.forwardButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(1, event);
    });
    this.reloadButtonEl = this.addToolbarButton("rotate-cw", t("Reload"), () => {
      if (this.rootEl.hasClass("ubc-is-loading")) this.stopLoading();
      else this.reload();
    });
    this.reloadButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new import_obsidian13.Menu();
      menu.addItem((item) => item.setTitle(t("Reload")).setIcon("rotate-cw").onClick(() => this.reload()));
      menu.addItem((item) => item.setTitle(t("Hard reload")).onClick(() => this.hardReload()));
      menu.addItem((item) => item.setTitle(t("Stop loading")).onClick(() => this.stopLoading()));
      showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    });
    this.addressEl = this.toolbarEl.createEl("input", {
      cls: "ubc-address",
      attr: { type: "text", spellcheck: "false", "aria-label": t("Address and search") }
    });
    this.register(bindAddressSuggestions(this.addressEl, this.plugin.core, (value) => this.navigate(value)));
    this.addressEl.addEventListener("keydown", (event) => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      this.navigate(this.normalizeAddress(this.addressEl.value));
    });
    this.addressEl.addEventListener("focus", () => this.addressEl.select());
    this.addressEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showAddressMenu(event);
    });
    this.statusEl = this.toolbarEl.createSpan({
      cls: "ubc-navigation-status",
      text: t("Ready"),
      attr: { "aria-live": "polite", "aria-atomic": "true", title: t("Navigation status") }
    });
    this.bookmarkButtonEl = this.addToolbarButton("bookmark", t("Bookmark page"), () => this.bookmarkCurrentPage());
    this.containerButtonEl = this.addToolbarButton("box", t("Container"), (event) => this.showContainerMenu(event));
    this.containerButtonEl.addClass("ubc-container-button");
    this.updateContainerIndicator();
    this.favoritesBarEl = this.rootEl.createDiv({ cls: "ubc-favorites-bar" });
    this.favoritesBarEl.addEventListener("contextmenu", (event) => {
      if (event.target !== this.favoritesBarEl) return;
      event.preventDefault();
      showFavoritesBarMenu(this.plugin, this, event);
    });
    this.recoveryBannerEl = this.rootEl.createDiv({ cls: "ubc-recovery-banner is-hidden", attr: { role: "status" } });
    this.browserContentEl = this.rootEl.createDiv({ cls: "ubc-content" });
    this.browserContentEl.appendChild(this.recoveryBannerEl);
    for (const event of ["pointerdown", "wheel", "keydown"]) {
      this.browserContentEl.addEventListener(event, (input) => {
        if (!this.recoveryBannerEl.contains(input.target)) this.hideRecoveryBanner();
      }, { capture: true, passive: true });
    }
    this.webLayerEl = this.browserContentEl.createDiv({ cls: "ubc-web-layer is-hidden" });
    this.loadingShieldEl = this.webLayerEl.createDiv({
      cls: "ubc-loading-shield is-hidden",
      attr: { "aria-hidden": "true" }
    });
    this.internalLayerEl = this.browserContentEl.createDiv({ cls: "ubc-internal-layer is-hidden" });
    this.browserContentEl.addEventListener("contextmenu", (event) => {
      if (this.internalSurface) return;
      if (this.webview && event.composedPath().includes(this.webview)) return;
      event.preventDefault();
      showPageMenu(this.plugin, this, event);
    });
    this.renderFavoritesBar();
    this.updateBookmarkButton();
    this.refreshNavigationButtons();
  }
  addToolbarButton(icon, label, callback) {
    const button = this.toolbarEl.createEl("button", {
      cls: "ubc-toolbar-button clickable-icon",
      attr: { "aria-label": label, title: label }
    });
    (0, import_obsidian13.setIcon)(button, icon);
    button.addEventListener("click", callback);
    return button;
  }
  applyZoom(factor) {
    this.readyWebview()?.setZoomFactor?.(hostZoomFactor(this.rootEl.ownerDocument) * factor);
    this.plugin.core.scheduleSave();
    this.setNavigationStatus("loaded", `Zoom ${Math.round(factor * 100)}%`);
  }
  setNavigationStatus(status, detail) {
    const label = detail ?? {
      idle: "Ready",
      waiting: "Waiting\u2026",
      loading: "Loading\u2026",
      loaded: "Loaded",
      failed: "Load failed",
      offline: "Offline",
      stopped: "Stopped",
      restored: "Restored"
    }[status];
    const header = this.leaf.tabHeaderEl;
    header?.toggleClass("ubc-browser-tab-pending", status === "waiting" || status === "loading" || status === "failed" || status === "offline" || status === "stopped");
    if (this.statusEl) {
      this.statusEl.textContent = t(label);
      this.statusEl.dataset.status = status;
      this.statusEl.title = t(label);
    }
    if (this.reloadButtonEl) {
      const loading = status === "waiting" || status === "loading";
      (0, import_obsidian13.setIcon)(this.reloadButtonEl, loading ? "x" : "rotate-cw");
      const actionLabel = t(loading ? "Stop loading" : "Reload");
      this.reloadButtonEl.setAttribute("aria-label", actionLabel);
      this.reloadButtonEl.title = actionLabel;
    }
  }
  renderFavoritesBar() {
    if (!this.favoritesBarEl) return;
    this.rootEl.toggleClass("ubc-native-background", !this.plugin.core.settings().initialBackgroundOverride);
    const backgroundSettings = this.plugin.core.settings();
    if (backgroundSettings.initialBackgroundOverride && backgroundSettings.initialBackgroundSource === "custom") {
      this.rootEl.style.setProperty("--ubc-initial-background", backgroundSettings.initialBackgroundColor);
    } else this.rootEl.style.removeProperty("--ubc-initial-background");
    this.updateBookmarkButton();
    this.favoritesBarEl.empty();
    const visible = this.plugin.core.settings().showFavoritesBar;
    const favorites = this.plugin.core.settings().bookmarkBarMode === "all" ? this.plugin.core.bookmarks.children(null) : this.plugin.core.bookmarks.favorites();
    this.favoritesBarEl.toggleClass("is-hidden", !visible);
    if (!visible) return;
    const library = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item ubc-bar-library", attr: { title: t("Open bookmarks"), "aria-label": t("Open bookmarks") } });
    (0, import_obsidian13.setIcon)(library, "book-open");
    library.addEventListener("click", () => this.showInternal("bookmarks"));
    if (!favorites.length && this.plugin.core.settings().bookmarkBarMode === "selected") {
      const choose = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item", text: t("Choose members") });
      choose.addEventListener("click", () => {
        this.bookmarkLayout = "selected";
        this.showInternal("bookmarks");
      });
    }
    for (const item of favorites) {
      if (item.kind === "folder") {
        const folder = this.favoritesBarEl.createEl("button", { cls: "ubc-favorite-item" });
        (0, import_obsidian13.setIcon)(folder.createSpan(), "folder");
        folder.createSpan({ text: item.title });
        folder.addEventListener("click", () => {
          const menu = new import_obsidian13.Menu();
          const append = (parentId, target) => {
            for (const child of this.plugin.core.bookmarks.children(parentId)) {
              target.addItem((entry) => {
                entry.setTitle(child.title).setIcon(child.kind === "folder" ? "folder" : "bookmark");
                if (child.kind === "folder") {
                  const item2 = entry;
                  if (item2.setSubmenu) append(child.id, item2.setSubmenu());
                  else entry.onClick(() => {
                    this.bookmarkLayout = "folder";
                    this.showInternal("bookmarks");
                  });
                } else entry.onClick(() => this.navigate(resolveBookmarkUrl(child.url, this.plugin.app)));
              });
            }
          };
          append(item.id, menu);
          const rect = folder.getBoundingClientRect();
          this.openContainerMenu(menu, { x: rect.left, y: rect.bottom });
        });
        folder.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkFolderMenu(this.plugin, this, item, event);
        });
        continue;
      }
      const bookmark = this.favoritesBarEl.createEl("button", {
        cls: "ubc-favorite-item",
        attr: { title: `${item.title || item.url}
${item.url}` }
      });
      renderBookmarkVisual(bookmark, item, "ubc-favorite-visual", this.plugin.app);
      bookmark.createSpan({ cls: "ubc-favorite-title", text: item.title || item.url });
      bookmark.addEventListener("click", (event) => this.openWebTargetFromPointer(item.url, event));
      bookmark.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        this.openWebTargetFromPointer(item.url, event);
      });
      bookmark.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showBookmarkMenu(this.plugin, this, item, event);
      });
    }
  }
  navigate(rawUrl) {
    this.bookmarkPopoverClose?.();
    this.discardPendingRestore();
    const url = this.normalizeAddress(rawUrl);
    if (url.startsWith("browser://")) {
      this.showInternal(url.slice("browser://".length) || "home");
      return;
    }
    const origin = webOrigin(url);
    const bypassAssignment = Boolean(origin && origin === this.siteAssignmentBypassOrigin);
    const assignedContainer = bypassAssignment ? this.containerId : this.plugin.core.resolveContainerForNavigation(url, this.containerId);
    if (assignedContainer !== this.containerId) {
      void this.replaceCurrentTab({ url, containerId: assignedContainer });
      return;
    }
    if (!bypassAssignment) {
      this.siteAssignmentBypassOrigin = void 0;
      this.siteAssignmentBypassReason = void 0;
    }
    this.internalSurface = null;
    this.setNavigationStatus("waiting");
    this.showLoadingShield();
    this.currentUrlValue = url;
    this.addressEl.value = url;
    this.internalLayerEl.addClass("is-hidden");
    this.webLayerEl.removeClass("is-hidden");
    this.ensureWebview(url);
  }
  showInternal(surface = "home", recordTransient = true, discardRestore = true) {
    if (discardRestore) this.discardPendingRestore();
    const resolvedSurface = surface ?? "home";
    this.disconnectHistoryObserver();
    this.internalSurface = resolvedSurface;
    this.siteAssignmentBypassOrigin = void 0;
    this.siteAssignmentBypassReason = void 0;
    this.faviconDataUrl = void 0;
    this.faviconSourceUrl = void 0;
    this.currentUrlValue = `browser://${resolvedSurface}`;
    this.addressEl.value = this.currentUrlValue;
    this.updateBookmarkButton();
    this.webLayerEl.addClass("is-hidden");
    this.hideLoadingShield();
    this.internalLayerEl.removeClass("is-hidden");
    this.internalLayerEl.empty();
    if (resolvedSurface === "history") this.renderHistory();
    else if (resolvedSurface === "bookmarks") this.renderBookmarks();
    else this.renderHome();
    this.currentTitle = t(resolvedSurface === "history" ? "History" : resolvedSurface === "bookmarks" ? "Bookmarks" : "Home");
    this.plugin.core.history.touchLeaf(this.leafId(), {
      lastUrl: this.currentUrlValue,
      lastTitle: this.currentTitle
    });
    this.plugin.core.scheduleSave();
    if (recordTransient) {
      this.pushTransient({ kind: "internal", url: this.currentUrlValue, surface: resolvedSurface });
    }
    this.refreshNavigationButtons();
    this.refreshLeafHeader();
    this.plugin.scheduleSessionCheckpoint();
  }
  goBack() {
    if (this.traverseTransient(-1)) return;
    const webview = this.readyWebview();
    if (!webview || !this.safeCanGoBack(webview)) return;
    this.pendingHistoryIntent = "back";
    webview.goBack?.();
  }
  goForward() {
    if (this.traverseTransient(1)) return;
    const webview = this.readyWebview();
    if (!webview || !this.safeCanGoForward(webview)) return;
    this.pendingHistoryIntent = "forward";
    webview.goForward?.();
  }
  canGoBack() {
    const webview = this.readyWebview();
    return this.transientIndex > 0 || Boolean(webview && this.safeCanGoBack(webview));
  }
  canGoForward() {
    const webview = this.readyWebview();
    return this.transientIndex >= 0 && this.transientIndex < this.transientHistory.length - 1 || Boolean(webview && this.safeCanGoForward(webview));
  }
  reload() {
    const webview = this.readyWebview();
    if (!webview) return;
    this.plugin.core.history.addResidual({
      leafId: this.leafId(),
      residualKind: "reload",
      fromUrl: this.currentUrlValue,
      toUrl: this.currentUrlValue
    });
    this.plugin.core.scheduleSave();
    webview.reload();
  }
  hardReload() {
    const webview = this.readyWebview();
    if (!webview) return;
    this.plugin.core.history.addResidual({
      leafId: this.leafId(),
      residualKind: "reload",
      fromUrl: this.currentUrlValue,
      toUrl: this.currentUrlValue,
      detail: "hard-reload"
    });
    this.plugin.core.scheduleSave();
    if (webview.reloadIgnoringCache) webview.reloadIgnoringCache();
    else webview.reload();
  }
  stopLoading() {
    this.readyWebview()?.stop();
    this.rootEl.removeClass("ubc-is-loading");
    this.hideLoadingShield();
    this.setNavigationStatus("stopped");
  }
  bookmarkCurrentPage() {
    if (!this.currentUrlValue || this.currentUrlValue.startsWith("browser://")) return;
    this.bookmarkPopoverClose?.();
    const bookmark = this.plugin.core.bookmarks.addBookmark({
      title: this.currentTitle || this.currentUrlValue,
      url: this.currentUrlValue,
      faviconUrl: this.faviconSourceUrl ?? fallbackFaviconUrl(this.currentUrlValue)
    });
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    this.bookmarkPopoverClose = showBookmarkPopover(this.plugin, bookmark, this.bookmarkButtonEl, this.browserContentEl);
  }
  favoriteCurrentPage() {
    if (!this.currentUrlValue || this.currentUrlValue.startsWith("browser://")) return;
    const bookmark = this.plugin.core.bookmarks.addBookmark({
      title: this.currentTitle || this.currentUrlValue,
      url: this.currentUrlValue,
      favorite: true,
      faviconUrl: this.faviconSourceUrl ?? fallbackFaviconUrl(this.currentUrlValue)
    });
    this.plugin.core.bookmarks.setFavorite(bookmark.id, true);
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    new import_obsidian13.Notice(t("Added to favorites."));
  }
  updateBookmarkButton() {
    if (!this.bookmarkButtonEl) return;
    const bookmark = !this.currentUrlValue.startsWith("browser://") ? this.plugin.core.bookmarks.findByUrl(this.currentUrlValue) : void 0;
    (0, import_obsidian13.setIcon)(this.bookmarkButtonEl, "star");
    const label = bookmark ? t("Edit bookmark") : t("Bookmark page");
    this.bookmarkButtonEl.setAttribute("aria-label", label);
    this.bookmarkButtonEl.title = label;
    this.bookmarkButtonEl.toggleClass("is-active", Boolean(bookmark));
  }
  reopenInContainer(containerId) {
    void this.replaceCurrentTab({
      url: this.currentUrlValue,
      containerId
    });
  }
  async replaceCurrentTab(request) {
    await this.captureRecoveryState();
    await this.plugin.openBrowser({
      ...request,
      restoredFromLeafId: this.leafId()
    });
    this.closeReasonOverride = "replaced";
    this.leaf.detach();
  }
  ensureWebview(url) {
    if (!this.webview) {
      const webview2 = this.plugin.managedWebviewBackend.create(
        this.plugin.core.containers.get(this.containerId).partition,
        () => this.plugin.core.settings(),
        this.rootEl.ownerDocument
      );
      this.webview = webview2;
      this.webviewDomReady = false;
      this.bindWebview(webview2);
      this.webLayerEl.appendChild(webview2);
      if (this.plugin.core.settings().blockPasskeyRequests || !this.richRestoreAttempted && this.restoredFromLeafId) {
        this.pendingInitialWebUrl = url;
        this.ignoreBootstrapAboutBlank = true;
        webview2.src = "about:blank";
      } else {
        this.pendingInitialWebUrl = void 0;
        webview2.src = url;
      }
      return;
    }
    const webview = this.webview;
    if (this.readyWebview() && webview.loadURL) void webview.loadURL(url);
    else webview.src = url;
  }
  bindWebview(webview) {
    webview.addEventListener("will-navigate", () => {
      void this.captureRecoveryState();
    });
    webview.addEventListener("did-attach", () => {
      this.bindGuestRuntime(webview, false);
      void this.initializeAttachedWebview(webview);
    });
    webview.addEventListener("did-navigate", (rawEvent) => {
      const event = rawEvent;
      if (event.isMainFrame === false) return;
      const url = event.url || this.safeWebviewUrl(webview) || this.currentUrlValue;
      if (this.ignoreBootstrapAboutBlank && url === "about:blank") return;
      if (url !== "about:blank") this.ignoreBootstrapAboutBlank = false;
      if (this.clearBootstrapHistoryAfterFallback && url !== "about:blank") {
        this.navigationHistoryAdapter.clear(webview);
        this.clearBootstrapHistoryAfterFallback = false;
      }
      this.handleCommittedNavigation(url);
    });
    webview.addEventListener("did-navigate-in-page", (rawEvent) => {
      const event = rawEvent;
      if (event.isMainFrame === false) return;
      const url = event.url || this.safeWebviewUrl(webview) || this.currentUrlValue;
      const previousUrl = this.currentUrlValue;
      const currentTransient = this.transientHistory[this.transientIndex];
      const previousWebIndex = currentTransient?.kind === "web" ? currentTransient.webIndex : void 0;
      this.currentUrlValue = url;
      this.addressEl.value = url;
      const reason = this.pendingHistoryIntent || "in-page";
      this.pendingHistoryIntent = null;
      const webIndex = this.navigationHistoryAdapter.activeIndex(webview);
      const classification = classifyInPageNavigation(previousWebIndex, webIndex, reason);
      if (this.pendingTransientTraversalIndex !== null) {
        const target = this.transientHistory[this.pendingTransientTraversalIndex];
        if (target?.kind === "web") {
          target.url = url;
          target.webIndex = webIndex;
        }
        this.pendingTransientTraversalIndex = null;
      } else if (classification === "navigation") {
        this.pushTransient({ kind: "web", url, webIndex });
      } else if (currentTransient?.kind === "web") {
        currentTransient.url = url;
        currentTransient.webIndex = webIndex;
      }
      if (classification === "navigation") {
        this.plugin.core.history.addNavigation({
          leafId: this.leafId(),
          containerId: this.containerId,
          url,
          title: this.currentTitle,
          reason,
          sessionEntryIndex: webIndex
        });
      } else {
        this.plugin.core.history.addResidual({
          leafId: this.leafId(),
          residualKind: "in-page",
          fromUrl: previousUrl,
          toUrl: url
        });
        this.plugin.core.history.updateCurrentNavigation(this.leafId(), {
          url,
          title: this.currentTitle,
          sessionEntryIndex: webIndex
        });
      }
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      void this.captureRecoveryState();
      if (this.formRecoveryWatchEnabled && this.hasRecoverableFormValues()) {
        void this.restoreFormValues({ silent: true, watchNextSteps: true });
      }
    });
    webview.addEventListener("did-redirect-navigation", (rawEvent) => {
      const event = rawEvent;
      if (!event.url) return;
      this.plugin.core.history.addResidual({
        leafId: this.leafId(),
        residualKind: "redirect",
        fromUrl: this.lastNavigatedUrl || this.currentUrlValue,
        toUrl: event.url
      });
      this.plugin.core.scheduleSave();
    });
    webview.addEventListener("page-title-updated", (rawEvent) => {
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      const event = rawEvent;
      this.syncWebviewTitle(webview, event.title);
    });
    webview.addEventListener("page-favicon-updated", (rawEvent) => {
      const event = rawEvent;
      this.rememberFaviconSource(event.favicons ?? []);
      void this.captureFavicon(webview, event.favicons ?? []);
    });
    webview.addEventListener("context-menu", (rawEvent) => {
      if (this.contextMenuDisposer) return;
      const event = rawEvent;
      if (!event.params) return;
      rawEvent.preventDefault();
      const rect = webview.getBoundingClientRect();
      showWebContentMenu(this.plugin, this, event.params, {
        x: rect.left + event.params.x,
        y: rect.top + event.params.y
      });
    });
    webview.addEventListener("did-start-loading", () => {
      this.rootEl.addClass("ubc-is-loading");
      this.showLoadingShield();
      this.setNavigationStatus("loading");
    });
    webview.addEventListener("did-stop-loading", () => {
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      this.rootEl.removeClass("ubc-is-loading");
      this.hideLoadingShield();
      this.setNavigationStatus("loaded");
      this.syncWebviewTitle(webview);
    });
    webview.addEventListener("did-fail-load", (rawEvent) => {
      const event = rawEvent;
      if (event.isMainFrame === false || event.errorCode === -3) return;
      this.rootEl.addClass("did-fail-load");
      this.hideLoadingShield();
      const offline = event.errorCode === -106 || /INTERNET_DISCONNECTED/i.test(event.errorDescription || "");
      this.setNavigationStatus(offline ? "offline" : "failed", event.errorDescription || void 0);
    });
    webview.addEventListener("dom-ready", () => {
      if (this.webview !== webview || !webview.isConnected) return;
      this.webviewDomReady = true;
      this.bindGuestRuntime(webview, true);
      this.refreshNavigationButtons();
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      this.rootEl.removeClass("did-fail-load");
      this.contextMenuDisposer?.();
      this.contextMenuDisposer = this.plugin.contextMenuAdapter.bind(
        webview,
        (params) => buildWebContentMenuEntries(this.plugin, this, params)
      );
      void this.handleDomReady();
    });
  }
  discardPendingRestore() {
    this.restoreIntentGeneration += 1;
    this.restoredFromLeafId = void 0;
    this.restoreTargetUrl = void 0;
    this.restoreTargetIndex = void 0;
    this.richRestoreAttempted = true;
    this.pendingInitialWebUrl = void 0;
    this.ignoreBootstrapAboutBlank = false;
    this.clearBootstrapHistoryAfterFallback = false;
    this.hideRecoveryBanner();
  }
  async initializeAttachedWebview(webview) {
    const restoreGeneration = this.restoreIntentGeneration;
    const fallbackUrl = this.pendingInitialWebUrl;
    this.pendingInitialWebUrl = void 0;
    if (!this.richRestoreAttempted && this.restoredFromLeafId) {
      this.richRestoreAttempted = true;
      const capsule = this.plugin.core.restore.get(this.restoredFromLeafId);
      const targetIndex = this.restoreTargetUrl && typeof this.restoreTargetIndex === "number" ? capsule && this.navigationHistoryAdapter.entryMatches(
        capsule,
        this.restoreTargetIndex,
        this.restoreTargetUrl
      ) ? this.restoreTargetIndex : void 0 : capsule?.index;
      const targetIsRestorable = !this.restoreTargetUrl || typeof targetIndex === "number";
      const restored = Boolean(
        capsule && targetIsRestorable && typeof targetIndex === "number" && await this.navigationHistoryAdapter.restore(webview, capsule, targetIndex)
      );
      if (restoreGeneration !== this.restoreIntentGeneration) {
        const currentUrl = this.currentUrlValue;
        if (!currentUrl.startsWith("browser://")) {
          if (this.isReadyWebview(webview) && webview.loadURL) void webview.loadURL(currentUrl);
          else webview.src = currentUrl;
        }
        return;
      }
      if (capsule && targetIsRestorable && typeof targetIndex === "number" && restored) {
        if (this.transientHistory.length === 0) {
          this.transientHistory = capsule.entries.map((entry, index) => ({
            kind: "web",
            url: typeof entry.url === "string" ? entry.url : "about:blank",
            title: typeof entry.title === "string" ? entry.title : void 0,
            webIndex: index
          }));
          this.transientIndex = Math.min(Math.max(targetIndex, 0), this.transientHistory.length - 1);
        }
        this.restoreTargetUrl = void 0;
        this.restoreTargetIndex = void 0;
        this.setNavigationStatus("restored", "Restored navigation state");
        this.showRecoveryBanner("Navigation state restored from the closed tab. Some live page state may still need to reload.", "success");
        return;
      }
      this.restoreTargetUrl = void 0;
      this.restoreTargetIndex = void 0;
      this.setNavigationStatus("waiting", "Reloading saved URL");
      if (this.ignoreBootstrapAboutBlank) this.clearBootstrapHistoryAfterFallback = true;
      this.showRecoveryBanner(
        capsule ? "Detailed tab recovery could not be applied. Browser Core is reopening the saved URL and can still use form recovery or the website's own saved state." : "Detailed tab recovery is no longer available. Browser Core is reopening the saved URL from browsing history.",
        "warning"
      );
    }
    if (!fallbackUrl) return;
    if (this.isReadyWebview(webview) && webview.loadURL) void webview.loadURL(fallbackUrl);
    else webview.src = fallbackUrl;
  }
  bindGuestRuntime(webview, finalAttempt) {
    if (!this.popupInteractionDisposer) {
      this.popupInteractionDisposer = observeGuestInteraction(webview, () => {
        this.dismissTransientPopups();
        this.bookmarkPopoverClose?.();
      });
    }
    if (!this.popupDisposer) {
      this.popupDisposer = this.plugin.windowOpenAdapter.bind(webview, (url, disposition) => {
        void this.plugin.openFromOpener(url, this.containerId, disposition);
      });
    }
    if (finalAttempt && !this.popupDisposer) {
      webview.removeAttribute("allowpopups");
    }
    this.plugin.bindPermissions(webview, this.containerId);
    this.watchRecoveryInteractions();
  }
  syncWebviewTitle(webview, eventTitle) {
    const title = eventTitle?.trim() || this.safeWebviewTitle(webview)?.trim();
    if (!title || title === "about:blank") return;
    this.currentTitle = title;
    const transient = this.transientHistory[this.transientIndex];
    if (transient?.kind === "web") transient.title = title;
    this.plugin.core.history.updateCurrentNavigation(this.leafId(), {
      title,
      url: this.currentUrlValue
    });
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
    this.refreshLeafHeader();
  }
  handleCommittedNavigation(url) {
    const reason = this.pendingHistoryIntent || "navigate";
    this.pendingHistoryIntent = null;
    this.lastNavigatedUrl = this.currentUrlValue;
    const previousOrigin = webOrigin(this.currentUrlValue);
    this.currentUrlValue = url;
    if (previousOrigin !== webOrigin(url)) {
      this.faviconDataUrl = void 0;
      this.faviconSourceUrl = void 0;
      this.refreshLeafHeader();
    }
    const committedOrigin = webOrigin(url);
    if (this.siteAssignmentBypassReason === "opener") {
      const openerBypassOrigin = this.plugin.core.containers.openerBypassOriginForCommittedUrl(
        url,
        this.containerId
      );
      if (openerBypassOrigin) {
        this.siteAssignmentBypassOrigin = openerBypassOrigin;
      } else {
        this.siteAssignmentBypassOrigin = void 0;
        this.siteAssignmentBypassReason = void 0;
      }
    } else if (committedOrigin !== this.siteAssignmentBypassOrigin) {
      this.siteAssignmentBypassOrigin = void 0;
      this.siteAssignmentBypassReason = void 0;
    }
    this.addressEl.value = url;
    this.updateBookmarkButton();
    const webIndex = this.webview ? this.navigationHistoryAdapter.activeIndex(this.webview) : void 0;
    if (this.pendingTransientTraversalIndex !== null) {
      const target = this.transientHistory[this.pendingTransientTraversalIndex];
      if (target?.kind === "web") {
        target.url = url;
        target.webIndex = webIndex;
      }
      this.pendingTransientTraversalIndex = null;
    } else {
      this.pushTransient({ kind: "web", url, webIndex, title: this.currentTitle });
    }
    this.plugin.core.history.addNavigation({
      leafId: this.leafId(),
      containerId: this.containerId,
      url,
      title: this.currentTitle,
      reason,
      sessionEntryIndex: webIndex
    });
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
  }
  async handleDomReady() {
    const webview = this.readyWebview();
    if (!webview) return;
    this.refreshZoom();
    if (!this.faviconDataUrl) void this.captureFavicon(webview, []);
    if (this.formRecoveryEnabledForSite()) {
      await this.installFormRecoveryInstrumentation(webview);
    }
    if (this.hasRecoverableFormValues()) {
      if (this.formRecoveryWatchEnabled) {
        await this.restoreFormValues({ silent: true, watchNextSteps: true });
      } else {
        new import_obsidian13.Notice(t("Saved form values are available for this page."));
      }
    }
    if (this.checkpointTimer === void 0) {
      this.checkpointTimer = window.setInterval(() => {
        void this.captureRecoveryState();
      }, 3e4);
    }
  }
  async captureFavicon(webview, candidates) {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    const expectedUrl = this.safeWebviewUrl(webview) || this.currentUrlValue;
    this.rememberFaviconSource(candidates, expectedUrl);
    const supplied = JSON.stringify(candidates.slice(0, 8));
    try {
      const result = await webview.executeJavaScript(`(async () => {
        const supplied = ${supplied};
        const discovered = Array.from(
          document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
        ).map((el) => el.href).filter(Boolean);
        let fallback = null;
        try { fallback = new URL('/favicon.ico', location.href).href; } catch {}
        const urls = [...new Set([...supplied, ...discovered, ...(fallback ? [fallback] : [])])];
        const asDataUrl = (blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        for (const raw of urls) {
          try {
            const absolute = new URL(raw, location.href).href;
            if (absolute.startsWith('data:image/')) {
              if (absolute.length <= 180000) return { dataUrl: absolute };
              continue;
            }
            if (!/^https?:/i.test(absolute)) continue;
            const response = await fetch(absolute, { credentials: 'include', cache: 'force-cache' });
            if (!response.ok) continue;
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > 131072) continue;
            const encoded = await asDataUrl(blob);
            if (encoded && encoded.length <= 180000) return { dataUrl: encoded, sourceUrl: absolute };
          } catch {}
        }
        return null;
      })()`);
      if (!result?.dataUrl) return;
      const liveUrl = this.safeWebviewUrl(webview) || this.currentUrlValue;
      if (liveUrl !== expectedUrl) return;
      if (result.sourceUrl) this.rememberFaviconSource([result.sourceUrl], liveUrl);
      this.faviconDataUrl = result.dataUrl;
      this.plugin.scheduleSessionCheckpoint();
      this.refreshLeafHeader();
    } catch {
    }
  }
  rememberFaviconSource(candidates, url = this.currentUrlValue) {
    const source = candidates.find((candidate) => /^https?:/i.test(candidate)) ?? fallbackFaviconUrl(url);
    if (!source || source === this.faviconSourceUrl) return;
    this.faviconSourceUrl = source;
    const bookmark = this.plugin.core.bookmarks.findByUrl(url);
    if (!bookmark || bookmark.visualKind !== "favicon" || bookmark.faviconUrl === source) return;
    this.plugin.core.bookmarks.updateBookmark(bookmark.id, { faviconUrl: source });
    this.plugin.core.scheduleSave();
    this.renderFavoritesBar();
  }
  showRecoveryBanner(message, tone) {
    if (!this.recoveryBannerEl) return;
    if (!this.plugin.core.settings().showRecoveryNotifications) {
      this.hideRecoveryBanner();
      return;
    }
    this.recoveryBannerEl.empty();
    this.recoveryBannerEl.removeClass("is-hidden", "is-success", "is-warning");
    this.recoveryBannerEl.addClass(tone === "success" ? "is-success" : "is-warning");
    this.recoveryBannerEl.createSpan({ cls: "ubc-recovery-message", text: t(message) });
    const actions = this.recoveryBannerEl.createDiv({ cls: "ubc-recovery-actions" });
    if (tone === "warning") {
      actions.createEl("button", { text: t("Retry restore") }).addEventListener("click", () => void this.retryRichRestore());
      actions.createEl("button", { text: t("Reload normally") }).addEventListener("click", () => {
        this.hideRecoveryBanner();
        const webview = this.webview;
        if (!webview) return;
        if (this.readyWebview() && webview.loadURL) void webview.loadURL(this.currentUrlValue);
        else webview.src = this.currentUrlValue;
      });
      if (this.hasRecoverableFormValues()) {
        actions.createEl("button", { text: t("Restore form values") }).addEventListener("click", () => void this.restoreFormValues());
      }
    }
    actions.createEl("button", { text: t("Recovery details") }).addEventListener("click", () => this.openRecoveryDetails());
    const retention = actions.createEl("button", {
      text: this.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")
    });
    retention.addEventListener("click", () => {
      this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      const preserving = this.manualRetention === "preserve";
      retention.setText(preserving ? t("Use normal recovery retention") : t("Keep recovery data"));
      new import_obsidian13.Notice(
        preserving ? t("Detailed recovery data for this tab will be kept until you remove it.") : t("Detailed recovery data for this tab will use normal retention again.")
      );
    });
    actions.createEl("button", { text: t("Dismiss"), attr: { "aria-label": t("Dismiss recovery message") } }).addEventListener("click", () => this.hideRecoveryBanner());
    actions.createEl("button", { text: t("Never show again") }).addEventListener("click", () => {
      this.plugin.core.updateSettings({ showRecoveryNotifications: false });
      this.plugin.refreshBrowserViews();
    });
    this.watchRecoveryInteractions();
  }
  watchRecoveryInteractions() {
    if (this.recoveryInteractionDisposer || !this.webview || !this.recoveryBannerEl || this.recoveryBannerEl.hasClass("is-hidden")) return;
    this.recoveryInteractionDisposer = observeGuestInteraction(this.webview, () => this.hideRecoveryBanner());
  }
  refreshRecoveryNotification() {
    if (!this.plugin.core.settings().showRecoveryNotifications) this.hideRecoveryBanner();
  }
  hideRecoveryBanner() {
    this.recoveryBannerEl?.addClass("is-hidden");
    this.recoveryInteractionDisposer?.();
    this.recoveryInteractionDisposer = void 0;
  }
  async retryRichRestore() {
    const webview = this.readyWebview();
    if (!webview || !this.restoredFromLeafId) return;
    const capsule = this.plugin.core.restore.get(this.restoredFromLeafId);
    if (!capsule || !await this.navigationHistoryAdapter.restore(webview, capsule)) {
      new import_obsidian13.Notice(t("Detailed tab recovery is not currently available; the page can still be reopened normally."));
      return;
    }
    this.setNavigationStatus("restored", "Restored tab state");
    this.showRecoveryBanner("Detailed tab state restored. Some page state may still depend on the website.", "success");
  }
  openRecoveryDetails() {
    const sourceId = this.restoredFromLeafId;
    const capsule = sourceId ? this.plugin.core.restore.get(sourceId) : void 0;
    const sourceRecord = sourceId ? this.plugin.core.state.history.leaves[sourceId] : void 0;
    const sourceNodes = sourceId ? this.plugin.core.history.nodesForLeaf(sourceId) : [];
    showRecoveryDetails(this.plugin.app, {
      richRestoreAvailable: Boolean(capsule),
      navigationEntries: capsule?.entries.length ?? 0,
      formFields: this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue).length,
      stale: sourceNodes.some((node) => node.kind === "navigation" && node.stale) || Boolean(sourceRecord && !capsule),
      url: this.currentUrlValue
    });
  }
  async captureRecoveryState() {
    const webview = this.readyWebview();
    if (!webview) return;
    const recoveryUrl = this.safeWebviewUrl(webview) || "";
    if (!recoveryUrl || recoveryUrl.startsWith("browser://")) return;
    const leafRecord = this.plugin.core.state.history.leaves[this.leafId()];
    if (leafRecord?.richRestoreSuppressed) {
      if (this.plugin.core.restore.get(this.leafId())) this.plugin.core.restore.remove(this.leafId());
    } else {
      const capsule = this.navigationHistoryAdapter.capture(webview, this.leafId());
      if (capsule) this.plugin.core.restore.put(capsule);
    }
    if (this.formRecoveryEnabledForSite()) {
      const fields = await this.captureFormFields(webview);
      if (fields.length) {
        this.plugin.core.formRecovery.put(this.containerId, recoveryUrl, fields, this.plugin.core.settings());
      }
    }
    this.plugin.core.sweepRestoreCapsules();
    this.plugin.core.scheduleSave();
  }
  async captureFormFields(webview) {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return [];
    try {
      return await webview.executeJavaScript(`(() => {
        const captureState = window.__ubcFormRecoveryCaptureV1;
        if (captureState && captureState.dirty === false) return [];
        const sensitiveAutocomplete = /(?:password|cc-|one-time-code|webauthn)/i;
        const describe = (el) => {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          const autocomplete = el.getAttribute('autocomplete') || '';
          if (type === 'password' || type === 'file' || type === 'hidden' || sensitiveAutocomplete.test(autocomplete)) return null;
          const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
          const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
          const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
          const base = {
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            type,
            label: label || undefined,
            autocomplete: autocomplete || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            nearbyText: nearbyText || undefined,
          };
          if (type === 'checkbox' || type === 'radio') return { ...base, checked: Boolean(el.checked), value: el.value || undefined };
          if (el.tagName === 'SELECT') {
            const values = Array.from(el.selectedOptions || []).map((option) => option.value);
            return values.length ? { ...base, values } : null;
          }
          const value = typeof el.value === 'string' ? el.value : '';
          return value ? { ...base, value } : null;
        };
        const keyOf = (field) => [
          field.id || '', field.name || '', field.type || '', field.label || '',
          field.autocomplete || '', field.ariaLabel || '', field.placeholder || '',
          field.nearbyText || '', (field.type === 'radio' || field.type === 'checkbox') ? (field.value || '') : '',
        ].join('\\u001f');
        const merged = new Map();
        const buffered = captureState && captureState.fields;
        if (buffered) {
          for (const field of Object.values(buffered)) if (field) merged.set(keyOf(field), field);
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
          const field = describe(el);
          if (field) merged.set(keyOf(field), field);
        }
        const result = Array.from(merged.values());
        if (captureState) {
          captureState.fields = Object.create(null);
          captureState.dirty = false;
        }
        return result;
      })()`);
    } catch {
      return [];
    }
  }
  async installFormRecoveryInstrumentation(webview) {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        if (window.__ubcFormRecoveryCaptureV1) return true;
        const sensitiveAutocomplete = /(?:password|cc-|one-time-code|webauthn)/i;
        const state = { fields: Object.create(null), dirty: false, onInput: null, onChange: null };
        const describe = (el) => {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return null;
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          const autocomplete = el.getAttribute('autocomplete') || '';
          if (type === 'password' || type === 'file' || type === 'hidden' || sensitiveAutocomplete.test(autocomplete)) return null;
          const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
          const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
          const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
          const field = {
            name: el.getAttribute('name') || undefined,
            id: el.id || undefined,
            type,
            label: label || undefined,
            autocomplete: autocomplete || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            nearbyText: nearbyText || undefined,
          };
          if (type === 'checkbox' || type === 'radio') return { ...field, checked: Boolean(el.checked), value: el.value || undefined };
          if (el.tagName === 'SELECT') {
            const values = Array.from(el.selectedOptions || []).map((option) => option.value);
            return values.length ? { ...field, values } : null;
          }
          const value = typeof el.value === 'string' ? el.value : '';
          return value ? { ...field, value } : null;
        };
        const keyOf = (field) => [
          field.id || '', field.name || '', field.type || '', field.label || '',
          field.autocomplete || '', field.ariaLabel || '', field.placeholder || '',
          field.nearbyText || '', (field.type === 'radio' || field.type === 'checkbox') ? (field.value || '') : '',
        ].join('\\u001f');
        const capture = (target) => {
          const field = describe(target);
          if (field) {
            state.fields[keyOf(field)] = field;
            state.dirty = true;
          }
        };
        state.onInput = (event) => capture(event.target);
        state.onChange = (event) => capture(event.target);
        document.addEventListener('input', state.onInput, true);
        document.addEventListener('change', state.onChange, true);
        for (const el of document.querySelectorAll('input, textarea, select')) capture(el);
        window.__ubcFormRecoveryCaptureV1 = state;
        return true;
      })()`);
    } catch {
    }
  }
  async teardownFormRecoveryInstrumentation(webview) {
    if (!this.isReadyWebview(webview) || !webview.executeJavaScript) return;
    try {
      await webview.executeJavaScript(`(() => {
        const capture = window.__ubcFormRecoveryCaptureV1;
        if (capture) {
          if (capture.onInput) document.removeEventListener('input', capture.onInput, true);
          if (capture.onChange) document.removeEventListener('change', capture.onChange, true);
          delete window.__ubcFormRecoveryCaptureV1;
        }
        const assist = window.__ubcFormRecoveryAssistV1;
        if (assist) {
          if (assist.observer) assist.observer.disconnect();
          if (assist.markTouched) {
            document.removeEventListener('input', assist.markTouched, true);
            document.removeEventListener('change', assist.markTouched, true);
          }
          delete window.__ubcFormRecoveryAssistV1;
        }
        return true;
      })()`);
    } catch {
    }
  }
  async focusedFormField() {
    const webview = this.readyWebview();
    if (!webview?.executeJavaScript) return void 0;
    try {
      const field = await webview.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return null;
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        const autocomplete = el.getAttribute('autocomplete') || '';
        if (type === 'password' || type === 'file' || type === 'hidden' || /(?:password|cc-|one-time-code|webauthn)/i.test(autocomplete)) return null;
        const label = (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim();
        const host = el.closest('label, fieldset, [role="group"], [role="listitem"]');
        const nearbyText = (host && host.innerText ? host.innerText : '').trim().slice(0, 240);
        return {
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
          type,
          label: label || undefined,
          autocomplete: autocomplete || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          nearbyText: nearbyText || undefined,
          value: type === 'checkbox' || type === 'radio' ? (el.value || undefined) : undefined,
        };
      })()`);
      return field ?? void 0;
    } catch {
      return void 0;
    }
  }
  destroyWebview() {
    this.bookmarkPopoverClose?.();
    this.hideRecoveryBanner();
    if (this.checkpointTimer !== void 0) {
      window.clearInterval(this.checkpointTimer);
      this.checkpointTimer = void 0;
    }
    if (!this.webview) return;
    this.webviewDomReady = false;
    this.popupInteractionDisposer?.();
    this.popupInteractionDisposer = void 0;
    this.popupDisposer?.();
    this.popupDisposer = void 0;
    this.contextMenuDisposer?.();
    this.contextMenuDisposer = void 0;
    this.plugin.managedWebviewBackend.destroy(this.webview);
    this.webview = null;
    this.hideLoadingShield();
  }
  dismissTransientPopups() {
    const doc = this.containerEl.ownerDocument;
    dismissOpenMenus(doc);
    this.activeContainerMenu?.hide();
  }
  showLoadingShield() {
    if (!this.plugin.core.settings().fullPageLoadingShield) return;
    if (this.webviewDomReady) return;
    this.loadingShieldEl?.removeClass("is-hidden");
  }
  refreshLanguage() {
    this.backButtonEl.title = t("Back");
    this.backButtonEl.setAttribute("aria-label", t("Back"));
    this.forwardButtonEl.title = t("Forward");
    this.forwardButtonEl.setAttribute("aria-label", t("Forward"));
    this.renderFavoritesBar();
    this.refreshNavigationButtons();
    if (this.internalSurface) this.showInternal(this.internalSurface, false);
  }
  hideLoadingShield() {
    this.loadingShieldEl?.addClass("is-hidden");
  }
  refreshLoadingShield() {
    if (!this.plugin.core.settings().fullPageLoadingShield) this.hideLoadingShield();
  }
  disconnectHistoryObserver() {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
  }
  clearTabStyle() {
    this.plugin.tabStripAdapter.clearLeafStyle(this.leaf);
  }
  renderHome() {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-home" });
    page.addEventListener("contextmenu", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("button, input, a")) return;
      event.preventDefault();
      const menu = new import_obsidian13.Menu();
      menu.addItem((item) => item.setTitle(t("New browser tab")).setIcon("plus").onClick(() => void this.plugin.openBrowser()));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem((item) => item.setTitle("New tab in " + container.name).setIcon("box").onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: container.id })));
      }
      const closed = this.plugin.core.history.recentlyClosed(1)[0];
      menu.addItem((item) => item.setTitle(t("Reopen closed tab")).setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.plugin.restoreLeaf(closed.id);
      }));
      menu.addItem(
        (item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => this.plugin.openBrowserTabSearch())
      );
      menu.addItem(
        (item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => this.plugin.openQuickSwitcher())
      );
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Show history")).setIcon("history").onClick(() => this.showInternal("history")));
      menu.addItem((item) => item.setTitle(t("Show bookmarks")).setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
      showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    });
    page.createEl("h1", { text: t("Home") });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: t("Search your vault, browse the web, or continue where you left off.")
    });
    const searchMode = { value: this.plugin.core.settings().homeSearchMode };
    const modePicker = page.createDiv({ cls: "ubc-home-search-modes", attr: { role: "group", "aria-label": t("Home search mode") } });
    const vaultMode = modePicker.createEl("button", { text: t("Vault"), attr: { type: "button" } });
    const webMode = modePicker.createEl("button", { text: t("Web"), attr: { type: "button" } });
    const search = page.createEl("input", {
      cls: "ubc-home-search",
      attr: { "aria-label": t("Home search") }
    });
    const searchResults = page.createDiv({ cls: "ubc-home-search-results" });
    const homeSections = page.createDiv({ cls: "ubc-home-sections" });
    let currentVaultResults = [];
    const renderVaultSearch = () => {
      searchResults.empty();
      const query = search.value.trim();
      if (!query) {
        currentVaultResults = [];
        homeSections.removeClass("is-hidden");
        return;
      }
      currentVaultResults = this.plugin.homeAdapter.searchFiles(query, 10);
      homeSections.addClass("is-hidden");
      const heading = searchResults.createDiv({ cls: "ubc-home-results-heading" });
      heading.createEl("strong", {
        text: currentVaultResults.length ? String(currentVaultResults.length) + " vault result" + (currentVaultResults.length === 1 ? "" : "s") : t("No vault files found")
      });
      if (!currentVaultResults.length) {
        heading.createSpan({ text: t("Try another name or switch to Web."), cls: "ubc-card-subtitle" });
        return;
      }
      this.renderVaultFileCards(searchResults, currentVaultResults);
    };
    const setMode = (mode, persist = true) => {
      searchMode.value = mode;
      vaultMode.toggleClass("is-active", mode === "vault");
      webMode.toggleClass("is-active", mode === "web");
      vaultMode.setAttribute("aria-pressed", String(mode === "vault"));
      webMode.setAttribute("aria-pressed", String(mode === "web"));
      search.placeholder = mode === "vault" ? t("Search files in your vault") : t("Search the web or enter an address");
      searchResults.empty();
      homeSections.removeClass("is-hidden");
      if (persist && this.plugin.core.settings().homeSearchMode !== mode) {
        this.plugin.core.updateSettings({ homeSearchMode: mode });
      }
      if (mode === "vault") renderVaultSearch();
      search.focus();
    };
    vaultMode.addEventListener("click", () => setMode("vault"));
    webMode.addEventListener("click", () => setMode("web"));
    search.addEventListener("input", () => {
      if (searchMode.value === "vault") renderVaultSearch();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (searchMode.value === "web") {
        this.navigate(this.normalizeAddress(search.value));
        return;
      }
      const first = currentVaultResults[0];
      if (first) void this.openVaultHomeFile(first.path, event.metaKey || event.ctrlKey);
    });
    if (this.plugin.core.settings().showVaultBookmarksOnHome) {
      const bookmarked = this.plugin.homeAdapter.bookmarkedFiles(8);
      if (bookmarked.length) {
        homeSections.createEl("h2", { text: t("Bookmarked files") });
        this.renderVaultFileCards(homeSections, bookmarked);
      }
    }
    if (this.plugin.core.settings().showRecentVaultFilesOnHome) {
      const files = this.plugin.homeAdapter.recentFiles(8);
      if (files.length) {
        homeSections.createEl("h2", { text: t("Recent files") });
        this.renderVaultFileCards(homeSections, files);
      }
    }
    const webBookmarks = this.plugin.core.bookmarks.allBookmarks().slice(0, 8);
    if (webBookmarks.length) {
      homeSections.createEl("h2", { text: t("Web bookmarks") });
      const list = homeSections.createDiv({ cls: "ubc-card-list" });
      for (const bookmark of webBookmarks) {
        const button = list.createEl("button", { cls: "ubc-card", text: bookmark.title || bookmark.url });
        button.createSpan({ cls: "ubc-card-subtitle", text: bookmark.url });
        button.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          this.openWebTargetFromPointer(bookmark.url, event);
        });
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkMenu(this.plugin, this, bookmark, event);
        });
      }
    }
    const recent = this.plugin.core.history.recentlyClosed(6);
    if (recent.length) {
      homeSections.createEl("h2", { text: t("Recently closed browser tabs") });
      const list = homeSections.createDiv({ cls: "ubc-card-list" });
      for (const leaf of recent) {
        const internalLabel = internalSurfaceLabel(leaf.lastUrl);
        const displayTitle = internalLabel || leaf.lastTitle || leaf.lastUrl || "Closed tab";
        const displayLocation = internalLabel ? "Browser Core page" : leaf.lastUrl || "";
        const button = list.createEl("button", {
          cls: "ubc-card",
          text: displayTitle
        });
        button.createSpan({
          cls: "ubc-card-subtitle",
          text: leaf.closeReason === "view-replaced" ? "Switched to another view" + (displayLocation ? " \xB7 " + displayLocation : "") : displayLocation
        });
        button.addEventListener("click", () => this.plugin.restoreLeaf(leaf.id));
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const menu = new import_obsidian13.Menu();
          menu.addItem((item) => item.setTitle(t("Restore")).setIcon("rotate-ccw").onClick(() => this.plugin.restoreLeaf(leaf.id)));
          for (const container of this.plugin.core.containers.list()) {
            menu.addItem(
              (item) => item.setTitle("Restore in " + container.name).setIcon("box").onClick(() => this.plugin.restoreLeaf(leaf.id, { containerId: container.id }))
            );
          }
          if (leaf.lastUrl && !leaf.lastUrl.startsWith("browser://")) {
            menu.addItem((item) => item.setTitle(t("Open history")).setIcon("history").onClick(() => this.showHistoryQuery(leaf.lastUrl || "")));
          }
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(t("Remove from history")).setIcon("trash").onClick(() => {
            void (async () => {
              const confirmed = await confirmAction(
                this.plugin.app,
                t("Remove closed tab from history"),
                t("Remove this closed tab's browsing history and detailed recovery data?"),
                t("Remove")
              );
              if (!confirmed) return;
              this.plugin.core.redactLeafHistory(leaf.id);
              this.plugin.core.history.forgetLeafRecord(leaf.id);
              this.plugin.core.scheduleSave();
              this.showInternal("home", false);
            })();
          }));
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
      }
    }
    setMode(searchMode.value, false);
  }
  renderVaultFileCards(parent, files) {
    const list = parent.createDiv({ cls: "ubc-card-list ubc-vault-file-list" });
    for (const file of files) {
      const button = list.createEl("button", {
        cls: "ubc-card ubc-vault-file-card",
        text: file.name,
        attr: { "aria-label": "Open " + file.path }
      });
      button.createSpan({
        cls: "ubc-card-subtitle",
        text: file.matchedAlias ? "Alias: " + file.matchedAlias + " \xB7 " + file.path : file.path
      });
      button.addEventListener("click", () => void this.openVaultHomeFile(file.path));
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new import_obsidian13.Menu();
        menu.addItem(
          (item) => item.setTitle(t("Open")).setIcon("file").onClick(() => void this.openVaultHomeFile(file.path))
        );
        menu.addItem(
          (item) => item.setTitle(t("Open in new tab")).setIcon("plus").onClick(() => void this.openVaultHomeFile(file.path, true))
        );
        menu.addItem(
          (item) => item.setTitle(t("Copy file path")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(file.path))
        );
        showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
      });
    }
  }
  async openVaultHomeFile(path, newTab = false) {
    if (!newTab) this.closeReasonOverride = "view-replaced";
    try {
      const opened = await this.plugin.homeAdapter.openFile(this.leaf, path, newTab);
      if (!opened) {
        if (!newTab) this.closeReasonOverride = void 0;
        new import_obsidian13.Notice(t("That file is no longer available."));
      }
    } catch (error) {
      if (!newTab) this.closeReasonOverride = void 0;
      console.error("Unified Browser Core: failed to open Home file", error);
      new import_obsidian13.Notice(t("Could not open that file."));
    }
  }
  renderBookmarks() {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-bookmarks" });
    const hero = page.createDiv({ cls: "ubc-bookmark-hero" });
    (0, import_obsidian13.setIcon)(hero.createDiv({ cls: "ubc-bookmark-hero-icon" }), "library-big");
    const heading = hero.createDiv();
    heading.createEl("h1", { text: t("Bookmarks") });
    heading.createEl("p", { text: t("Save freely. Find what you need by type or folder.") });
    const actions = page.createDiv({ cls: "ubc-surface-actions" });
    const add = actions.createEl("button", { text: t("New bookmark"), cls: "mod-cta" });
    add.addEventListener("click", async () => {
      const draft = await editBookmark(this.plugin.app, "", "", t("New bookmark"), { store: this.plugin.core.bookmarks });
      if (!draft) return;
      this.plugin.core.bookmarks.addBookmark(draft);
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
    actions.createEl("button", { text: t("New folder") }).addEventListener("click", async () => {
      const title = await promptText(this.plugin.app, t("New bookmark folder"), "", t("Folder name"));
      if (!title?.trim()) return;
      this.plugin.core.bookmarks.addFolder(title);
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
    const imports = actions.createEl("button", { text: t("Import") });
    imports.addEventListener("click", () => {
      const menu = new import_obsidian13.Menu();
      menu.addItem((item) => item.setTitle(t("Import Obsidian Bookmarks")).setIcon("book-open").onClick(async () => {
        await this.plugin.importObsidianBookmarks();
        this.refreshBookmarks();
      }));
      menu.addItem((item) => item.setTitle(t("Import Web viewer Bookmarks")).setIcon("bookmark-plus").onClick(async () => {
        await this.plugin.importWebViewerBookmarks();
        this.refreshBookmarks();
      }));
      const rect = imports.getBoundingClientRect();
      showDismissibleMenu(menu, () => menu.showAtPosition({ x: rect.left, y: rect.bottom }), this.containerEl.ownerDocument);
    });
    const stats = page.createDiv({ cls: "ubc-bookmark-stats" });
    stats.createSpan({ text: t("{count} bookmarks", { count: this.plugin.core.bookmarks.allBookmarks().length }) });
    stats.createSpan({ text: t("{count} selected", { count: this.plugin.core.bookmarks.favorites().length }) });
    stats.createSpan({ text: t("{count} folders", { count: this.plugin.core.bookmarks.folders().length }) });
    const controls = page.createDiv({ cls: "ubc-bookmark-controls" });
    const search = controls.createEl("input", { cls: "ubc-bookmark-search", attr: { type: "search", placeholder: t("Name, URL, folder or tag"), "aria-label": t("Search bookmarks") } });
    search.value = this.bookmarkSearchQuery;
    const modes = controls.createDiv({ cls: "ubc-bookmark-segments", attr: { role: "group", "aria-label": t("Organize by") } });
    const choices = [["type", "By type", "shapes"], ["folder", "By folder", "folder"], ["selected", "Selected members", "star"]];
    for (const [mode, label, icon] of choices) {
      const button = modes.createEl("button", { attr: { "aria-pressed": String(this.bookmarkLayout === mode) } });
      (0, import_obsidian13.setIcon)(button.createSpan(), icon);
      button.createSpan({ text: t(label) });
      button.toggleClass("is-active", this.bookmarkLayout === mode);
      button.addEventListener("click", () => {
        this.bookmarkLayout = mode;
        this.showInternal("bookmarks", false);
      });
    }
    const summary = page.createDiv({ cls: "ubc-bookmark-summary", attr: { "aria-live": "polite" } });
    const list = page.createDiv({ cls: "ubc-bookmark-manager" });
    const render = () => {
      list.empty();
      const needle = this.bookmarkSearchQuery.toLowerCase().trim();
      const all = this.plugin.core.bookmarks.allBookmarks();
      const matches = all.filter((bookmark) => [bookmark.title, bookmark.url, bookmark.description ?? "", ...bookmark.tags ?? [], bookmark.parentId ? this.plugin.core.bookmarks.folderPath(bookmark.parentId) : ""].some((value) => value.toLowerCase().includes(needle)));
      summary.setText(needle ? t("{count} results", { count: matches.length }) : this.bookmarkLayout === "selected" ? t("Pick the pages you use every day from your bookmarks.") : "");
      if (!matches.length && (needle || !this.plugin.core.bookmarks.folders().length || this.bookmarkLayout !== "folder")) {
        const empty = list.createDiv({ cls: "ubc-empty-state ubc-bookmark-empty" });
        (0, import_obsidian13.setIcon)(empty.createDiv({ cls: "ubc-bookmark-empty-icon" }), needle ? "search" : "bookmark-plus");
        empty.createEl("h2", { text: t(needle ? "No matching bookmarks" : "No bookmarks yet") });
        empty.createEl("p", { text: t(needle ? "Try another title, URL, or folder name." : "Save a page with the star in the toolbar, or add your first bookmark here.") });
        if (!needle) empty.createEl("button", { text: t("New bookmark"), cls: "mod-cta" }).addEventListener("click", () => add.click());
        return;
      }
      if (this.bookmarkLayout === "folder" && !needle) {
        this.renderBookmarkFolder(list, null, 0, render);
        return;
      }
      if (this.bookmarkLayout === "selected" || needle) {
        const grid = list.createDiv({ cls: "ubc-bookmark-grid" });
        const sorted = this.bookmarkLayout === "selected" ? [...matches].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.favoriteOrder ?? a.order) - (b.favoriteOrder ?? b.order)) : matches;
        for (const bookmark of sorted) this.renderBookmarkCard(grid, bookmark);
        return;
      }
      const categories = list.createDiv({ cls: "ubc-bookmark-category-index" });
      for (const media of BOOKMARK_MEDIA) {
        const members = matches.filter((bookmark) => classifyBookmark(bookmark) === media.type);
        if (!members.length) continue;
        const section = list.createEl("section", { cls: "ubc-bookmark-category" });
        const groupHeading = section.createDiv({ cls: "ubc-bookmark-category-heading" });
        (0, import_obsidian13.setIcon)(groupHeading.createSpan(), media.icon);
        groupHeading.createEl("h2", { text: t(media.label) });
        groupHeading.createSpan({ cls: "ubc-bookmark-count", text: String(members.length) });
        const shortcut = categories.createEl("button", { cls: "ubc-bookmark-category-chip" });
        (0, import_obsidian13.setIcon)(shortcut.createSpan(), media.icon);
        shortcut.createSpan({ text: t(media.label) + " \xB7 " + members.length });
        shortcut.addEventListener("click", () => section.scrollIntoView({ block: "start", behavior: this.plugin.core.settings().reducedMotion ? "auto" : "smooth" }));
        const grid = section.createDiv({ cls: "ubc-bookmark-grid" });
        for (const bookmark of members) this.renderBookmarkCard(grid, bookmark);
      }
    };
    search.addEventListener("input", () => {
      this.bookmarkSearchQuery = search.value;
      render();
    });
    render();
  }
  renderBookmarkCard(parent, bookmark) {
    const card = parent.createEl("article", { cls: "ubc-bookmark-card" });
    card.toggleClass("is-selected", bookmark.favorite);
    const top = card.createDiv({ cls: "ubc-bookmark-card-top" });
    renderBookmarkVisual(top, bookmark, "ubc-bookmark-card-visual", this.plugin.app);
    this.renderBookmarkFavoriteToggle(top, bookmark);
    const open = card.createEl("button", { cls: "ubc-bookmark-card-title", text: bookmark.title || bookmark.url });
    open.title = bookmark.url;
    open.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
    open.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.openWebTargetFromPointer(bookmark.url, event);
      }
    });
    let host = bookmark.url;
    try {
      host = new URL(bookmark.url).hostname || bookmark.url;
    } catch {
    }
    card.createDiv({ cls: "ubc-bookmark-meta", text: host });
    if (bookmark.description) card.createEl("p", { cls: "ubc-bookmark-card-description", text: bookmark.description });
    const footer = card.createDiv({ cls: "ubc-bookmark-card-footer" });
    const media = BOOKMARK_MEDIA.find((entry) => entry.type === classifyBookmark(bookmark));
    const badge = footer.createSpan({ cls: "ubc-bookmark-type-badge" });
    (0, import_obsidian13.setIcon)(badge.createSpan(), media.icon);
    badge.createSpan({ text: t(media.label) });
    const edit = footer.createEl("button", { cls: "clickable-icon", attr: { title: t("Edit bookmark"), "aria-label": t("Edit bookmark") } });
    (0, import_obsidian13.setIcon)(edit, "pencil");
    edit.addEventListener("click", () => {
      this.bookmarkPopoverClose?.();
      this.bookmarkPopoverClose = showBookmarkPopover(this.plugin, bookmark, edit, this.browserContentEl, () => this.refreshBookmarks());
    });
    const move = footer.createEl("button", { cls: "clickable-icon", attr: { title: t("Move to folder"), "aria-label": t("Move to folder") } });
    (0, import_obsidian13.setIcon)(move, "folder-input");
    move.addEventListener("click", async () => {
      const parentId = await pickBookmarkFolder(this.plugin.app, this.plugin.core.bookmarks);
      if (parentId === void 0 || !this.plugin.core.bookmarks.moveBookmark(bookmark.id, parentId)) return;
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
    if (bookmark.parentId) card.createDiv({ cls: "ubc-bookmark-card-path", text: this.plugin.core.bookmarks.folderPath(bookmark.parentId) });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showBookmarkMenu(this.plugin, this, bookmark, event);
    });
  }
  renderBookmarkSearchResult(parent, bookmark) {
    const row = parent.createDiv({ cls: "ubc-bookmark-row ubc-bookmark-search-result" });
    renderBookmarkVisual(row, bookmark, "ubc-bookmark-kind", this.plugin.app);
    const content = row.createDiv({ cls: "ubc-bookmark-row-content" });
    const button = content.createEl("button", { cls: "ubc-link-button", text: bookmark.title || bookmark.url });
    button.title = bookmark.url;
    button.addEventListener("click", (event) => this.openWebTargetFromPointer(bookmark.url, event));
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.openWebTargetFromPointer(bookmark.url, event);
    });
    const path = bookmark.parentId ? this.plugin.core.bookmarks.folderPath(bookmark.parentId) : "";
    content.createSpan({
      cls: "ubc-bookmark-meta",
      text: path ? `${path} \xB7 ${bookmark.url}` : bookmark.url
    });
    if (bookmark.description) content.createSpan({ cls: "ubc-bookmark-meta", text: bookmark.description });
    if (bookmark.tags?.length) content.createSpan({ cls: "ubc-bookmark-meta", text: bookmark.tags.join(" \xB7 ") });
    this.renderBookmarkFavoriteToggle(row, bookmark);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showBookmarkMenu(this.plugin, this, bookmark, event);
    });
  }
  renderBookmarkFolder(parent, parentId, depth, refresh) {
    for (const item of this.plugin.core.bookmarks.children(parentId)) {
      const row = parent.createDiv({ cls: "ubc-bookmark-row" });
      row.style.setProperty("--ubc-depth", String(depth));
      if (item.kind === "folder") {
        const collapsed = this.collapsedBookmarkFolders.has(item.id);
        const toggle = row.createEl("button", {
          cls: "ubc-bookmark-folder-toggle clickable-icon",
          attr: {
            type: "button",
            "aria-label": (collapsed ? "Expand " : "Collapse ") + item.title,
            "aria-expanded": String(!collapsed)
          }
        });
        (0, import_obsidian13.setIcon)(toggle, collapsed ? "chevron-right" : "chevron-down");
        const title = row.createEl("button", {
          cls: "ubc-bookmark-folder-title",
          text: item.title,
          attr: { type: "button" }
        });
        const count = this.plugin.core.bookmarks.descendantBookmarks(item.id).length;
        row.createSpan({
          cls: "ubc-bookmark-count",
          text: String(count),
          attr: { "aria-label": t("{v0} bookmark{v1} in {v2}", { v0: count, v1: count === 1 ? "" : "s", v2: item.title }) }
        });
        const toggleFolder = () => {
          if (collapsed) this.collapsedBookmarkFolders.delete(item.id);
          else this.collapsedBookmarkFolders.add(item.id);
          refresh();
        };
        toggle.addEventListener("click", toggleFolder);
        title.addEventListener("click", toggleFolder);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkFolderMenu(this.plugin, this, item, event);
        });
        if (!collapsed) this.renderBookmarkFolder(parent, item.id, depth + 1, refresh);
      } else {
        renderBookmarkVisual(row, item, "ubc-bookmark-kind", this.plugin.app);
        const content = row.createDiv({ cls: "ubc-bookmark-row-content" });
        const button = content.createEl("button", { cls: "ubc-link-button", text: item.title || item.url });
        button.title = item.url;
        button.addEventListener("click", (event) => this.openWebTargetFromPointer(item.url, event));
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          this.openWebTargetFromPointer(item.url, event);
        });
        content.createSpan({ cls: "ubc-bookmark-meta", text: item.url });
        this.renderBookmarkFavoriteToggle(row, item);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showBookmarkMenu(this.plugin, this, item, event);
        });
      }
    }
  }
  renderBookmarkFavoriteToggle(parent, bookmark) {
    const button = parent.createEl("button", {
      cls: "ubc-bookmark-favorite-toggle clickable-icon",
      attr: {
        type: "button",
        "aria-label": bookmark.favorite ? t("Remove from favorites") : t("Add to favorites"),
        title: bookmark.favorite ? t("Remove from favorites") : t("Add to favorites")
      }
    });
    (0, import_obsidian13.setIcon)(button, "star");
    button.toggleClass("is-active", bookmark.favorite);
    button.setAttribute("aria-pressed", String(bookmark.favorite));
    button.addEventListener("click", () => {
      this.plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
  }
  renderHistory() {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-history" });
    const heading = page.createDiv({ cls: "ubc-surface-heading" });
    heading.createEl("h1", { text: t("History") });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: t("Browse visits by day, tab, and alternate path. Filtering only changes what is shown.")
    });
    const filters = page.createDiv({ cls: "ubc-history-filters" });
    const search = filters.createEl("input", {
      attr: {
        placeholder: t("Search title, URL, domain, or tab"),
        "aria-label": t("Search history")
      }
    });
    this.historySearchEl = search;
    const dayFilter = filters.createEl("input", {
      attr: { type: "date", "aria-label": t("Filter history by day") }
    });
    const containerFilter = filters.createEl("select", {
      attr: { "aria-label": t("Filter history by container") }
    });
    containerFilter.createEl("option", { text: t("All containers"), value: "" });
    for (const container of this.plugin.core.containers.list()) {
      containerFilter.createEl("option", { text: container.name, value: container.id });
    }
    const clearFilters = filters.createEl("button", { text: t("Clear filters") });
    const summary = page.createDiv({ cls: "ubc-history-summary", attr: { "aria-live": "polite" } });
    const timeline = page.createDiv({ cls: "ubc-history-timeline" });
    const render = () => {
      this.disconnectHistoryObserver();
      timeline.empty();
      const needle = search.value.toLowerCase().trim();
      const selectedDay = dayFilter.value;
      const selectedContainer = containerFilter.value;
      const nodes = this.plugin.core.history.allNodes().filter((node) => node.kind !== "residual").filter((node) => {
        const day = historyDayKey(node.timestamp, this.plugin.core.settings().historyDayStartMinutes);
        if (selectedDay && day !== selectedDay) return false;
        if (selectedContainer) {
          const nodeContainerId = node.kind === "navigation" ? node.containerId : this.plugin.core.state.history.leaves[node.leafId]?.containerId;
          if (nodeContainerId !== selectedContainer) return false;
        }
        if (!needle) return true;
        if (node.kind !== "navigation") return false;
        const leafTitle = this.plugin.core.state.history.leaves[node.leafId]?.lastTitle || "";
        let domain = "";
        try {
          domain = new URL(node.url).hostname;
        } catch {
          domain = "";
        }
        return [node.title, node.url, domain, leafTitle].some((value) => value.toLowerCase().includes(needle));
      });
      const byDay = /* @__PURE__ */ new Map();
      for (const node of nodes) {
        const key = historyDayKey(node.timestamp, this.plugin.core.settings().historyDayStartMinutes);
        const bucket = byDay.get(key) ?? [];
        bucket.push(node);
        byDay.set(key, bucket);
      }
      const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
      const navigationCount = nodes.filter((node) => node.kind === "navigation").length;
      const tombstoneCount = nodes.filter((node) => node.kind === "tombstone").length;
      const filtersActive = Boolean(needle || selectedDay || selectedContainer);
      summary.setText(
        navigationCount ? t("{v0} visit{v1} across {v2} day{v3}{v4}{v5}", { v0: navigationCount, v1: navigationCount === 1 ? "" : "s", v2: days.length, v3: days.length === 1 ? "" : "s", v4: tombstoneCount ? ` \xB7 ${tombstoneCount} deleted entr${tombstoneCount === 1 ? "y" : "ies"} retained` : "", v5: filtersActive ? " \xB7 filtered" : "" }) : tombstoneCount ? t("{v0} deleted histor{v1} retained to preserve navigation paths{v2}", { v0: tombstoneCount, v1: tombstoneCount === 1 ? "y entry" : "y entries", v2: filtersActive ? " \xB7 filtered" : "" }) : filtersActive ? t("No history matches these filters.") : t("No browser history yet.")
      );
      clearFilters.toggleClass("is-hidden", !filtersActive);
      if (!days.length) {
        const empty = timeline.createDiv({ cls: "ubc-history-empty" });
        empty.createEl("strong", { text: filtersActive ? t("No matching visits") : t("No history yet") });
        empty.createEl("p", {
          text: filtersActive ? t("Try clearing one or more filters.") : t("Visited web pages will appear here without creating artificial gaps for idle time.")
        });
        return;
      }
      const revealNode = this.historyRevealNodeId ? this.plugin.core.state.history.nodes[this.historyRevealNodeId] : void 0;
      const revealDay = revealNode ? historyDayKey(revealNode.timestamp, this.plugin.core.settings().historyDayStartMinutes) : void 0;
      const revealDayIndex = revealDay ? days.findIndex(([day]) => day === revealDay) : -1;
      let renderedDays = 0;
      const batchSize = 14;
      const sentinel = document.createElement("button");
      sentinel.className = "ubc-history-load-more";
      sentinel.textContent = "Load older history";
      const appendBatch = () => {
        sentinel.remove();
        const batch = days.slice(renderedDays, renderedDays + batchSize);
        renderedDays += batch.length;
        for (const [day, dayNodes] of batch) {
          const section = timeline.createEl("section", { cls: "ubc-history-day" });
          const dayHeading = section.createEl("h2", { text: day });
          dayHeading.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            this.showHistoryDayMenu(day, dayNodes, event, () => {
              dayFilter.value = day;
              render();
            }, render);
          });
          const byLeaf = /* @__PURE__ */ new Map();
          for (const node of dayNodes.sort((a, b) => a.timestamp - b.timestamp)) {
            const bucket = byLeaf.get(node.leafId) ?? [];
            bucket.push(node);
            byLeaf.set(node.leafId, bucket);
          }
          for (const [leafId, leafNodes] of byLeaf) {
            const leafRecord = this.plugin.core.state.history.leaves[leafId];
            const group = section.createDiv({ cls: "ubc-history-leaf" });
            const leafHeader = group.createDiv({ cls: "ubc-history-leaf-header" });
            leafHeader.createSpan({
              text: leafRecord?.lastTitle || "Tab",
              attr: { title: this.plugin.core.containers.nameFor(leafRecord?.containerId) }
            });
            leafHeader.addEventListener("contextmenu", (event) => {
              event.preventDefault();
              this.showHistoryLeafMenu(leafId, leafNodes, event, render);
            });
            if (leafRecord?.closedAt && leafRecord.lastUrl) {
              const restore = leafHeader.createEl("button", { text: t("Restore") });
              restore.addEventListener("click", () => this.plugin.restoreLeaf(leafId));
            }
            this.renderHistoryLeafNodes(
              group,
              leafNodes,
              Boolean(needle || selectedDay || selectedContainer)
            );
          }
        }
        if (renderedDays < days.length) timeline.appendChild(sentinel);
      };
      sentinel.addEventListener("click", appendBatch);
      const initialBatches = revealDayIndex >= 0 ? Math.floor(revealDayIndex / batchSize) + 1 : 1;
      for (let batch = 0; batch < initialBatches; batch++) appendBatch();
      if (this.historyRevealNodeId) {
        const revealId = this.historyRevealNodeId;
        window.requestAnimationFrame(() => {
          const row = [...timeline.querySelectorAll("[data-history-node-id]")].find((candidate) => candidate.dataset.historyNodeId === revealId);
          if (!row) return;
          row.addClass("is-revealed");
          row.tabIndex = -1;
          row.scrollIntoView({
            block: "center",
            behavior: this.plugin.core.settings().reducedMotion ? "auto" : "smooth"
          });
          row.focus({ preventScroll: true });
          this.historyRevealNodeId = void 0;
        });
      }
      if (renderedDays < days.length && typeof IntersectionObserver !== "undefined") {
        this.historyObserver = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) appendBatch();
          },
          { root: this.internalLayerEl, rootMargin: "300px" }
        );
        this.historyObserver.observe(sentinel);
      }
    };
    search.addEventListener("input", render);
    dayFilter.addEventListener("change", render);
    containerFilter.addEventListener("change", render);
    clearFilters.addEventListener("click", () => {
      search.value = "";
      dayFilter.value = "";
      containerFilter.value = "";
      render();
      search.focus();
    });
    render();
  }
  openWebTargetFromPointer(url, event) {
    url = resolveBookmarkUrl(url, this.plugin.app);
    const modifiedTab = event.metaKey || event.ctrlKey || event.button === 1;
    if (event.shiftKey && !modifiedTab) {
      void this.plugin.openBrowser({ url, placement: "window" });
      return;
    }
    if (modifiedTab) {
      void this.plugin.openBrowser({
        url,
        reveal: event.shiftKey
      });
      return;
    }
    this.navigate(url);
  }
  showHistoryDayMenu(day, dayNodes, event, filterDay, refresh) {
    const menu = new import_obsidian13.Menu();
    const navigationNodes = dayNodes.filter((node) => node.kind === "navigation");
    const branchIds = [...new Set(navigationNodes.map((node) => node.branchId))];
    menu.addItem((item) => item.setTitle(t("Expand all alternate paths")).onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.add(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Collapse all alternate paths")).onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.delete(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Open all tabs from this day")).setIcon("copy-plus").onClick(() => {
      const latestByLeaf = /* @__PURE__ */ new Map();
      for (const node of navigationNodes) {
        const current = latestByLeaf.get(node.leafId);
        if (!current || node.timestamp > current.timestamp) latestByLeaf.set(node.leafId, node);
      }
      for (const node of latestByLeaf.values()) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle(t("Search within this day")).setIcon("search").onClick(filterDay));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Delete this day's history")).setIcon("trash").onClick(() => {
      void (async () => {
        if (!await confirmAction(this.plugin.app, t("Delete history day"), t("Delete web history recorded in {v0}?", { v0: day }), t("Delete history"))) return;
        this.plugin.core.redactHistoryNodes(navigationNodes.map((node) => node.id));
        refresh();
      })();
    }));
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }
  showHistoryLeafMenu(leafId, leafNodes, event, refresh) {
    const record = this.plugin.core.state.history.leaves[leafId];
    const navigationNodes = leafNodes.filter((node) => node.kind === "navigation");
    const mainBranch = this.plugin.core.history.currentBranchForLeaf(leafId) ?? navigationNodes.at(-1)?.branchId;
    const mainNodes = mainBranch ? this.plugin.core.history.navigationNodesForBranch(mainBranch) : navigationNodes;
    const menu = new import_obsidian13.Menu();
    if (record?.lastUrl) {
      menu.addItem((item) => item.setTitle(t("Restore tab")).setIcon("rotate-ccw").onClick(() => void this.plugin.restoreLeaf(leafId)));
      const originalContainerExists = Boolean(this.plugin.core.containers.find(record.containerId));
      menu.addItem(
        (item) => item.setTitle(originalContainerExists ? t("Restore in original container") : t("Original container deleted")).setIcon("box").setDisabled(!originalContainerExists).onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: record.containerId }))
      );
      for (const container of this.plugin.core.containers.list()) {
        if (container.id === record.containerId) continue;
        menu.addItem((item) => item.setTitle("Restore in " + container.name).setIcon("box").onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: container.id })));
      }
      menu.addItem((item) => item.setTitle(t("Pin restored tab")).setIcon("pin").onClick(() => void this.plugin.restoreLeaf(leafId, { pinned: true })));
    }
    menu.addItem((item) => item.setTitle(t("Open current path in new tabs")).setDisabled(mainNodes.length === 0).onClick(() => {
      for (const node of mainNodes) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle(record?.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")).onClick(() => {
      if (!record) return;
      record.manualRetention = record.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.scheduleSave();
      refresh();
    }));
    menu.addItem((item) => item.setTitle(t("Copy tab history")).setIcon("copy").onClick(() => {
      const text = navigationNodes.map((node) => `${new Date(node.timestamp).toLocaleString()}	${node.title}	${node.url}`).join("\n");
      void navigator.clipboard.writeText(text);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Delete tab history")).setIcon("trash").onClick(() => {
      void (async () => {
        if (!await confirmAction(this.plugin.app, t("Delete tab history"), t("Delete this tab's browsing history and detailed recovery data?"), t("Delete history"))) return;
        this.plugin.core.redactLeafHistory(leafId);
        refresh();
      })();
    }));
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }
  renderHistoryLeafNodes(parent, nodes, filtered = false) {
    const navigationNodes = nodes.filter((node) => node.kind === "navigation");
    const leafId = nodes[0]?.leafId;
    const lastBranch = (leafId && this.plugin.core.history.currentBranchForLeaf(leafId)) ?? navigationNodes.at(-1)?.branchId;
    const branches = /* @__PURE__ */ new Map();
    for (const node of navigationNodes) {
      const bucket = branches.get(node.branchId) ?? [];
      bucket.push(node);
      branches.set(node.branchId, bucket);
    }
    const renderedSummaries = /* @__PURE__ */ new Set();
    for (const node of nodes) {
      if (node.kind === "residual") continue;
      const row = parent.createDiv({ cls: "ubc-history-node" });
      if (node.kind === "tombstone") {
        row.addClass("is-tombstone");
        row.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        row.createSpan({ text: t("Deleted history entry") });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const check = this.plugin.core.history.canRemoveTombstone(node.id);
          const menu = new import_obsidian13.Menu();
          menu.addItem(
            (item) => item.setTitle(t("Remove deleted entry marker")).setIcon("trash").setDisabled(!check.ok).onClick(() => {
              const result = this.plugin.core.history.removeTombstone(node.id);
              if (!result.ok) {
                new import_obsidian13.Notice(result.reason || "This deleted entry marker cannot be removed.");
                return;
              }
              this.plugin.core.scheduleSave();
              this.showInternal("history");
            })
          );
          if (!check.ok && check.reason) {
            menu.addItem((item) => item.setTitle(check.reason || "").setDisabled(true));
          }
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
        continue;
      }
      row.dataset.historyNodeId = node.id;
      if (node.branchId !== lastBranch && !this.expandedHistoryBranches.has(node.branchId)) {
        row.remove();
        if (renderedSummaries.has(node.branchId)) continue;
        renderedSummaries.add(node.branchId);
        const summary = parent.createDiv({ cls: "ubc-history-node ubc-history-branch-summary" });
        summary.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        const count = branches.get(node.branchId)?.length ?? 1;
        const expand = summary.createEl("button", {
          cls: "ubc-history-link",
          text: t("Alternate path \xB7 {v0} visit{v1}", { v0: count, v1: count === 1 ? "" : "s" })
        });
        expand.addEventListener("click", () => {
          this.expandedHistoryBranches.add(node.branchId);
          this.showInternal("history");
        });
        summary.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const branchNodes = this.plugin.core.history.navigationNodesForBranch(node.branchId);
          const latest = branchNodes.at(-1);
          const menu = new import_obsidian13.Menu();
          menu.addItem((item) => item.setTitle(t("Show alternate path")).onClick(() => {
            this.expandedHistoryBranches.add(node.branchId);
            this.showInternal("history");
          }));
          menu.addItem(
            (item) => item.setTitle(t("Restore latest page from this path")).setIcon("rotate-ccw").setDisabled(!latest).onClick(() => {
              if (latest) void this.plugin.restoreHistoryNode(latest);
            })
          );
          menu.addItem((item) => item.setTitle(t("Open this path in new tabs")).setDisabled(branchNodes.length === 0).onClick(() => {
            for (const branchNode of branchNodes) void this.plugin.openBrowser({ url: branchNode.url, containerId: branchNode.containerId });
          }));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(t("Delete alternate path")).setIcon("trash").onClick(() => {
            void (async () => {
              if (!await confirmAction(this.plugin.app, t("Delete alternate history path"), t("Delete {v0} visit(s) from this path?", { v0: branchNodes.length }), t("Delete path"))) return;
              this.plugin.core.redactHistoryBranch(node.branchId);
              this.expandedHistoryBranches.delete(node.branchId);
              this.showInternal("history");
            })();
          }));
          showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
        });
        continue;
      }
      if (node.branchId !== lastBranch) row.addClass("is-expanded-branch");
      row.createEl("time", { text: new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      const button = row.createEl("button", { cls: "ubc-history-link", text: node.title || node.url });
      button.title = node.url;
      button.addEventListener("click", () => this.navigate(node.url));
      if (filtered) {
        const reveal = row.createEl("button", {
          cls: "ubc-history-reveal",
          text: t("Reveal"),
          attr: { "aria-label": t("Reveal this visit in its alternate path") }
        });
        reveal.addEventListener("click", () => this.revealHistoryNode(node));
      }
      const residuals = this.plugin.core.history.residualsOf(node.id);
      if (residuals.length) {
        const badge = row.createEl("button", {
          cls: "ubc-residual-badge",
          text: `+${residuals.length}`,
          attr: {
            "aria-label": t("Show {v0} reload, redirect, or navigation event{v1}", { v0: residuals.length, v1: residuals.length === 1 ? "" : "s" })
          }
        });
        badge.title = "Show reloads, redirects, and other navigation events";
        badge.addEventListener("click", () => {
          if (this.expandedResidualParents.has(node.id)) this.expandedResidualParents.delete(node.id);
          else this.expandedResidualParents.add(node.id);
          this.showInternal("history");
        });
      }
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new import_obsidian13.Menu();
        menu.addItem((item) => item.setTitle(t("Open")).onClick(() => this.navigate(node.url)));
        menu.addItem((item) => item.setTitle(t("Open in new tab")).onClick(() => this.plugin.openBrowser({ url: node.url, containerId: node.containerId })));
        for (const container of this.plugin.core.containers.list()) {
          menu.addItem(
            (item) => item.setTitle("Open in " + container.name).setIcon("box").onClick(() => this.plugin.openBrowser({ url: node.url, containerId: container.id }))
          );
        }
        menu.addItem(
          (item) => item.setTitle(t("Restore from here")).onClick(() => this.plugin.restoreHistoryNode(node))
        );
        menu.addItem(
          (item) => item.setTitle(t("Show in full history")).setIcon("locate").onClick(() => this.revealHistoryNode(node))
        );
        menu.addItem((item) => item.setTitle(t("Bookmark")).onClick(() => {
          this.plugin.core.bookmarks.addBookmark({ title: node.title, url: node.url });
          this.plugin.core.scheduleSave();
          this.renderFavoritesBar();
        }));
        menu.addItem(
          (item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(node.url))
        );
        menu.addItem(
          (item) => item.setTitle(t("Copy title")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(node.title || node.url))
        );
        if (residuals.length) {
          menu.addItem(
            (item) => item.setTitle(this.expandedResidualParents.has(node.id) ? t("Hide redirects and reloads") : t("Show redirects and reloads")).onClick(() => {
              if (this.expandedResidualParents.has(node.id)) this.expandedResidualParents.delete(node.id);
              else this.expandedResidualParents.add(node.id);
              this.showInternal("history");
            })
          );
        }
        if (node.branchId !== lastBranch) {
          menu.addItem((item) => item.setTitle(t("Collapse alternate path")).onClick(() => {
            this.expandedHistoryBranches.delete(node.branchId);
            this.showInternal("history");
          }));
        }
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(node.manualRetention === "preserve" ? t("Use normal recovery retention") : t("Keep recovery data")).onClick(() => {
          node.manualRetention = node.manualRetention === "preserve" ? "default" : "preserve";
          this.plugin.core.scheduleSave();
        }));
        menu.addItem((item) => item.setTitle(t("Delete history entry")).setIcon("trash").onClick(() => {
          void (async () => {
            const confirmed = await confirmAction(
              this.plugin.app,
              t("Delete history entry"),
              t("Delete \u201C{v0}\u201D from browser history?", { v0: node.title || node.url }),
              t("Delete history")
            );
            if (!confirmed) return;
            this.plugin.core.redactHistoryNode(node.id);
            this.showInternal("history");
          })();
        }));
        showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
      });
      if (this.expandedResidualParents.has(node.id)) {
        for (const residual of residuals) {
          const detail = parent.createDiv({ cls: "ubc-history-residual-detail" });
          detail.createSpan({ cls: "ubc-residual-kind", text: residualLabel(residual.residualKind) });
          const text = residual.residualKind === "redirect" ? `${residual.fromUrl || "unknown"} \u2192 ${residual.toUrl || "unknown"}` : residual.detail || residual.toUrl || residual.fromUrl || "Recorded browser event";
          detail.createSpan({ text });
          detail.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const menu = new import_obsidian13.Menu();
            menu.addItem((item) => item.setTitle(t("Copy event details")).setIcon("copy").onClick(() => {
              void navigator.clipboard.writeText(JSON.stringify(residual, null, 2));
            }));
            if (residual.residualKind === "redirect" && residual.fromUrl) {
              menu.addItem((item) => item.setTitle(t("Open redirect source")).onClick(() => this.navigate(residual.fromUrl)));
            }
            if (residual.residualKind === "redirect" && residual.toUrl) {
              menu.addItem((item) => item.setTitle(t("Open redirect destination")).onClick(() => this.navigate(residual.toUrl)));
            }
            menu.addItem((item) => item.setTitle(t("Hide redirects and reloads")).onClick(() => {
              this.expandedResidualParents.delete(node.id);
              this.showInternal("history");
            }));
            showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
          });
        }
      }
    }
  }
  revealHistoryNode(node) {
    this.expandedHistoryBranches.add(node.branchId);
    this.historyRevealNodeId = node.id;
    this.showInternal("history");
  }
  showContainerMenu(event) {
    this.showContainerMenuAt({ x: event.clientX, y: event.clientY });
  }
  showContainerMenuAt(position) {
    const mode = this.plugin.core.settings().containerMode;
    if (mode === "off") return;
    const menu = new import_obsidian13.Menu();
    menu.addItem(
      (item) => item.setTitle(t("Open new tab in this container")).setIcon("plus").onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: this.containerId }))
    );
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("Reopen current page in")).setIcon("repeat-2").setDisabled(true));
    for (const container of this.plugin.core.containers.list()) {
      menu.addItem((item) => {
        item.setTitle(container.name).setIcon(container.icon || "box");
        if (container.id === this.containerId) item.setChecked(true);
        item.onClick(() => {
          if (container.id !== this.containerId) this.reopenInContainer(container.id);
        });
      });
    }
    menu.addSeparator();
    if (mode !== "automatic") {
      menu.addItem(
        (item) => item.setTitle(t("Automatic site defaults are off")).setIcon("route-off").setDisabled(true)
      );
      menu.addItem((item) => item.setTitle(t("Manage containers")).setIcon("settings").onClick(() => this.plugin.openSettings()));
      this.openContainerMenu(menu, position);
      return;
    }
    const routing = this.plugin.core.containers.routingStatus(
      this.currentUrlValue,
      this.containerId,
      this.siteAssignmentBypassOrigin,
      this.siteAssignmentBypassReason
    );
    if (routing) {
      const assignment = routing.assignedContainerId ? this.plugin.core.containers.assignmentForHostname(routing.hostname) : void 0;
      if (assignment) {
        const assignedName = this.plugin.core.containers.nameFor(assignment.containerId);
        menu.addItem(
          (item) => item.setTitle(
            routing.bypassingAssignment ? routing.bypassReason === "opener" ? t("Sign-in flow stays in this container \xB7 site default is {v0}", { v0: assignedName }) : t("Opened here explicitly \xB7 site default is {v0}", { v0: assignedName }) : t("Site default \xB7 {v0}", { v0: assignedName })
          ).setIcon(routing.bypassingAssignment ? "shuffle" : "route").setDisabled(true)
        );
        if (routing.bypassingAssignment) {
          menu.addItem(
            (item) => item.setTitle(t("Return to site default \xB7 {v0}", { v0: assignedName })).setIcon("undo-2").onClick(() => this.reopenInContainer(assignment.containerId))
          );
        }
      } else {
        menu.addItem(
          (item) => item.setTitle(t("No default container for this site")).setIcon("route-off").setDisabled(true)
        );
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Site default container")).setIcon("route").setDisabled(true));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem(
          (item) => item.setTitle(t("Always open {v0} in {v1}", { v0: routing.hostname, v1: container.name })).setIcon(container.icon || "box").setChecked(routing.assignedContainerId === container.id).onClick(() => this.assignCurrentSiteToContainer(routing.hostname, container.id))
        );
      }
      if (assignment) {
        menu.addItem((item) => item.setTitle(t("Forget site default container")).onClick(() => {
          this.plugin.core.containers.unassignOrigin(assignment.originPattern);
          this.siteAssignmentBypassOrigin = void 0;
          this.siteAssignmentBypassReason = void 0;
          this.plugin.core.scheduleSave();
          this.plugin.scheduleSessionCheckpoint();
          this.updateContainerIndicator();
          new import_obsidian13.Notice("Forgot the site default container for " + assignment.originPattern);
        }));
      }
    } else {
      menu.addItem((item) => item.setTitle(t("Site defaults are only available for web pages")).setDisabled(true));
    }
    menu.addItem((item) => item.setTitle(t("Manage containers")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    this.openContainerMenu(menu, position);
  }
  openContainerMenu(menu, position) {
    this.activeContainerMenu?.hide();
    const dismissEl = this.browserContentEl.createDiv({ cls: "ubc-menu-dismiss-layer" });
    this.activeContainerMenu = menu;
    dismissEl.addEventListener("pointerdown", () => menu.hide());
    menu.onHide(() => {
      dismissEl.remove();
      if (this.activeContainerMenu === menu) {
        this.activeContainerMenu = null;
      }
    });
    showDismissibleMenu(menu, () => menu.showAtPosition(position), this.containerEl.ownerDocument);
  }
  assignCurrentSiteToContainer(hostname, containerId) {
    this.plugin.core.containers.assignOrigin(hostname, containerId);
    if (containerId === this.containerId) {
      this.siteAssignmentBypassOrigin = void 0;
      this.siteAssignmentBypassReason = void 0;
    }
    this.plugin.core.scheduleSave();
    this.plugin.scheduleSessionCheckpoint();
    this.updateContainerIndicator();
    new import_obsidian13.Notice(t("Always open {v0} in {v1}.", { v0: hostname, v1: this.plugin.core.containers.nameFor(containerId) }));
  }
  updateContainerIndicator() {
    if (!this.containerButtonEl) return;
    const mode = this.plugin.core.settings().containerMode;
    this.containerButtonEl.hidden = mode === "off";
    if (mode === "off") return;
    const container = this.plugin.core.containers.get(this.containerId);
    (0, import_obsidian13.setIcon)(this.containerButtonEl, container.icon || "box");
    const routing = this.plugin.core.containers.routingStatus(
      this.currentUrlValue,
      this.containerId,
      this.siteAssignmentBypassOrigin,
      this.siteAssignmentBypassReason
    );
    const assignedName = mode === "automatic" && routing?.assignedContainerId ? this.plugin.core.containers.nameFor(routing.assignedContainerId) : void 0;
    const routingHint = routing?.bypassingAssignment && assignedName ? routing.bypassReason === "opener" ? ` \xB7 sign-in flow stays here (site default: ${assignedName})` : ` \xB7 opened here explicitly (site default: ${assignedName})` : assignedName ? ` \xB7 site default: ${assignedName}` : mode === "manual" ? " \xB7 manual routing" : "";
    this.containerButtonEl.setAttribute("aria-label", "Container: " + container.name + routingHint);
    this.containerButtonEl.title = "Container: " + container.name + routingHint;
    this.containerButtonEl.style.setProperty(
      "--ubc-container-color",
      container.color || "var(--text-muted)"
    );
  }
  showPermissionMenu(event) {
    const menu = new import_obsidian13.Menu();
    const origin = this.currentOrigin();
    if (!origin) {
      menu.addItem((item) => item.setTitle(t("Site permissions are only available for web pages")).setDisabled(true));
      menu.addItem((item) => item.setTitle(t("Open Browser Core settings")).onClick(() => this.plugin.openSettings()));
      this.showMenuForEvent(menu, event);
      return;
    }
    const records = this.plugin.core.permissions.listForOrigin(this.containerId, origin);
    if (!records.length) {
      menu.addItem((item) => item.setTitle(t("No saved permissions for this site")).setDisabled(true));
    } else {
      for (const record of records) {
        menu.addItem(
          (item) => item.setTitle(`${permissionLabel(record.permission)}: ${permissionDecisionLabel(record.decision)}`).setDisabled(true)
        );
        for (const decision of ["allow", "block", "ask"]) {
          menu.addItem(
            (item) => item.setTitle(`${permissionDecisionLabel(decision)}: ${permissionLabel(record.permission)}`).setChecked(record.decision === decision).onClick(() => {
              if (decision === "ask") this.plugin.core.permissions.remove(this.containerId, origin, record.permission);
              else this.plugin.core.permissions.set(this.containerId, origin, record.permission, decision);
              this.plugin.core.scheduleSave();
            })
          );
        }
        menu.addSeparator();
      }
    }
    menu.addItem(
      (item) => item.setTitle(t("Reset site permissions")).setIcon("rotate-ccw").setDisabled(records.length === 0).onClick(() => {
        this.plugin.core.permissions.resetOrigin(this.containerId, origin);
        this.plugin.core.scheduleSave();
      })
    );
    menu.addItem((item) => item.setTitle(t("Open Browser Core settings")).setIcon("settings").onClick(() => this.plugin.openSettings()));
    this.showMenuForEvent(menu, event);
  }
  showMenuForEvent(menu, event) {
    if (event instanceof MouseEvent) showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
    else {
      const rect = (this.browserHeaderEl ?? this.toolbarEl).getBoundingClientRect();
      showDismissibleMenu(menu, () => menu.showAtPosition({ x: rect.right, y: rect.bottom }), this.containerEl.ownerDocument);
    }
  }
  currentOrigin() {
    try {
      const parsed = new URL(this.currentUrlValue);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : void 0;
    } catch {
      return void 0;
    }
  }
  showNavigationHistoryMenu(direction, event) {
    const menu = new import_obsidian13.Menu();
    const transientIndices = [];
    if (direction < 0) {
      for (let index = this.transientIndex - 1; index >= 0 && transientIndices.length < 12; index--) {
        transientIndices.push(index);
      }
    } else {
      for (let index = this.transientIndex + 1; index < this.transientHistory.length && transientIndices.length < 12; index++) {
        transientIndices.push(index);
      }
    }
    if (transientIndices.length) {
      const webEntries = this.webview ? this.navigationHistoryAdapter.entries(this.webview) : [];
      for (const index of transientIndices) {
        const entry = this.transientHistory[index];
        if (!entry) continue;
        menu.addItem((item) => {
          if (entry.kind === "internal") {
            item.setTitle(internalSurfaceLabel(entry.url) || "Browser Core").setIcon(entry.surface === "home" ? "home" : entry.surface === "history" ? "history" : "book-open");
          } else {
            const webEntry = typeof entry.webIndex === "number" ? webEntries[entry.webIndex] : void 0;
            const title = entry.title || (typeof webEntry?.title === "string" ? webEntry.title : "") || entry.url || "Web page";
            item.setTitle(title).setIcon("globe");
          }
          item.onClick(() => this.goToTransientIndex(index));
        });
      }
    } else {
      this.addFallbackWebNavigationItems(menu, direction);
    }
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle(t("Show full tab history")).setIcon("history").onClick(() => this.showInternal("history"))
    );
    menu.addItem(
      (item) => item.setTitle(t("Show alternate paths")).setIcon("git-branch").onClick(() => {
        for (const node of this.plugin.core.history.nodesForLeaf(this.leafId())) {
          if (node.kind === "navigation") this.expandedHistoryBranches.add(node.branchId);
        }
        this.showInternal("history");
      })
    );
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }
  addFallbackWebNavigationItems(menu, direction) {
    const webview = this.readyWebview();
    if (!webview) {
      menu.addItem(
        (item) => item.setTitle(direction < 0 ? t("No back history") : t("No forward history")).setDisabled(true)
      );
      return;
    }
    const entries = this.navigationHistoryAdapter.entries(webview);
    const activeIndex = this.navigationHistoryAdapter.activeIndex(webview) ?? 0;
    const indices = [];
    if (direction < 0) {
      for (let index = activeIndex - 1; index >= 0 && indices.length < 12; index--) indices.push(index);
    } else {
      for (let index = activeIndex + 1; index < entries.length && indices.length < 12; index++) indices.push(index);
    }
    if (!indices.length) {
      menu.addItem(
        (item) => item.setTitle(direction < 0 ? t("No back history") : t("No forward history")).setDisabled(true)
      );
      return;
    }
    for (const index of indices) {
      const entry = entries[index] ?? {};
      const url = typeof entry.url === "string" ? entry.url : "";
      const title = typeof entry.title === "string" && entry.title ? entry.title : url || "Web page";
      menu.addItem(
        (item) => item.setTitle(title).setIcon("globe").onClick(() => {
          this.pendingHistoryIntent = direction < 0 ? "back" : "forward";
          this.navigationHistoryAdapter.goToIndex(webview, index);
        })
      );
    }
  }
  showAddressMenu(event) {
    const menu = new import_obsidian13.Menu();
    const start = this.addressEl.selectionStart ?? 0;
    const end = this.addressEl.selectionEnd ?? start;
    const selectionStart = Math.min(start, end);
    const selectionEnd = Math.max(start, end);
    const rawSelected = this.addressEl.value.slice(selectionStart, selectionEnd);
    const selected = rawSelected.trim();
    const hasSelection = selectionEnd > selectionStart;
    menu.addItem(
      (item) => item.setTitle(t("Cut")).setDisabled(!hasSelection).onClick(async () => {
        if (!hasSelection) return;
        await navigator.clipboard.writeText(rawSelected);
        this.replaceAddressSelection("");
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Copy")).setDisabled(!hasSelection).onClick(() => {
        if (!hasSelection) return;
        void navigator.clipboard.writeText(rawSelected);
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Paste")).onClick(async () => {
        const value = await navigator.clipboard.readText();
        this.replaceAddressSelection(value);
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Paste and go")).onClick(async () => {
        const value = await navigator.clipboard.readText();
        if (value) this.navigate(this.normalizeAddress(value));
      })
    );
    menu.addItem(
      (item) => item.setTitle(t("Delete")).setDisabled(!hasSelection).onClick(() => this.replaceAddressSelection(""))
    );
    menu.addItem(
      (item) => item.setTitle(t("Select all")).onClick(() => {
        this.addressEl.focus();
        this.addressEl.select();
      })
    );
    menu.addSeparator();
    if (selected) {
      menu.addItem(
        (item) => item.setTitle("Search \u201C" + selected.slice(0, 40) + (selected.length > 40 ? "\u2026" : "") + "\u201D").setIcon("search").onClick(() => this.navigate(this.plugin.core.searchUrl(selected)))
      );
    }
    menu.addItem(
      (item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => void navigator.clipboard.writeText(this.currentUrlValue))
    );
    menu.addItem(
      (item) => item.setTitle(t("Copy page title and URL")).onClick(
        () => void navigator.clipboard.writeText(this.currentTitle + "\n" + this.currentUrlValue)
      )
    );
    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem(
        (item) => item.setTitle(t("Bookmark page")).setIcon("bookmark").onClick(() => this.bookmarkCurrentPage())
      );
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem(
          (item) => item.setTitle("Open current URL in " + container.name).setIcon("box").onClick(() => {
            void this.plugin.openBrowser({ url: this.currentUrlValue, containerId: container.id });
          })
        );
      }
      menu.addItem(
        (item) => item.setTitle(t("History for this site")).setIcon("history").onClick(() => {
          let origin = "";
          try {
            origin = new URL(this.currentUrlValue).hostname;
          } catch {
            origin = "";
          }
          this.showInternal("history");
          window.requestAnimationFrame(() => {
            if (!this.historySearchEl) return;
            this.historySearchEl.value = origin;
            this.historySearchEl.dispatchEvent(new Event("input"));
            this.historySearchEl.focus();
          });
        })
      );
    }
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle(t("Clear")).setIcon("x").onClick(() => {
        this.addressEl.value = "";
        this.addressEl.focus();
      })
    );
    showDismissibleMenu(menu, () => menu.showAtMouseEvent(event), this.containerEl.ownerDocument);
  }
  replaceAddressSelection(value) {
    const start = this.addressEl.selectionStart ?? this.addressEl.value.length;
    const end = this.addressEl.selectionEnd ?? start;
    this.addressEl.setRangeText(value, Math.min(start, end), Math.max(start, end), "end");
    this.addressEl.focus();
    this.addressEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  pushTransient(entry) {
    const current = this.transientHistory[this.transientIndex];
    if (current?.kind === entry.kind && current.url === entry.url) {
      if (current.kind === "web" && entry.kind === "web") {
        current.webIndex = entry.webIndex;
        current.title = entry.title ?? current.title;
      }
      this.refreshNavigationButtons();
      return;
    }
    this.transientHistory = this.transientHistory.slice(0, this.transientIndex + 1);
    this.transientHistory.push(entry);
    this.transientIndex = this.transientHistory.length - 1;
    this.refreshNavigationButtons();
  }
  traverseTransient(delta) {
    const targetIndex = this.transientIndex + delta;
    return this.goToTransientIndex(targetIndex);
  }
  goToTransientIndex(targetIndex) {
    if (targetIndex < 0 || targetIndex >= this.transientHistory.length) return false;
    const previousIndex = this.transientIndex;
    if (targetIndex === previousIndex) return true;
    const delta = targetIndex < previousIndex ? -1 : 1;
    const distance = Math.abs(targetIndex - previousIndex);
    const target = this.transientHistory[targetIndex];
    if (!target) return false;
    this.transientIndex = targetIndex;
    this.refreshNavigationButtons();
    if (target.kind === "internal") {
      this.pendingTransientTraversalIndex = null;
      this.showInternal(target.surface, false);
      return true;
    }
    this.internalSurface = null;
    this.currentUrlValue = target.url;
    this.currentTitle = target.title || (this.webview ? this.safeWebviewTitle(this.webview) : void 0) || target.url;
    this.addressEl.value = target.url;
    this.internalLayerEl.addClass("is-hidden");
    this.webLayerEl.removeClass("is-hidden");
    this.refreshLeafHeader();
    if (!this.webview) {
      this.pendingTransientTraversalIndex = targetIndex;
      this.ensureWebview(target.url);
      return true;
    }
    const webview = this.readyWebview();
    if (!webview) {
      this.pendingTransientTraversalIndex = targetIndex;
      this.webview.src = target.url;
      return true;
    }
    const currentWebIndex = this.navigationHistoryAdapter.activeIndex(webview);
    if (typeof target.webIndex === "number" && currentWebIndex !== target.webIndex && this.navigationHistoryAdapter.goToIndex(webview, target.webIndex)) {
      this.pendingHistoryIntent = delta < 0 ? "back" : "forward";
      this.pendingTransientTraversalIndex = targetIndex;
      return true;
    }
    const liveUrl = this.safeWebviewUrl(webview);
    if (liveUrl === target.url) {
      this.pendingTransientTraversalIndex = null;
      return true;
    }
    this.pendingHistoryIntent = delta < 0 ? "back" : "forward";
    this.pendingTransientTraversalIndex = targetIndex;
    if (distance === 1 && delta < 0 && this.safeCanGoBack(webview)) webview.goBack?.();
    else if (distance === 1 && delta > 0 && this.safeCanGoForward(webview)) webview.goForward?.();
    else if (webview.loadURL) void webview.loadURL(target.url);
    else webview.src = target.url;
    return true;
  }
  readyWebview() {
    return this.isReadyWebview(this.webview) ? this.webview : null;
  }
  isReadyWebview(webview) {
    return Boolean(
      webview && webview === this.webview && this.webviewDomReady && webview.isConnected
    );
  }
  safeWebviewUrl(webview) {
    if (!this.isReadyWebview(webview)) return void 0;
    try {
      return webview.getURL?.();
    } catch {
      return void 0;
    }
  }
  safeWebviewTitle(webview) {
    if (!this.isReadyWebview(webview)) return void 0;
    try {
      return webview.getTitle?.();
    } catch {
      return void 0;
    }
  }
  safeCanGoBack(webview) {
    if (!this.isReadyWebview(webview)) return false;
    try {
      return Boolean(webview.canGoBack?.());
    } catch {
      return false;
    }
  }
  safeCanGoForward(webview) {
    if (!this.isReadyWebview(webview)) return false;
    try {
      return Boolean(webview.canGoForward?.());
    } catch {
      return false;
    }
  }
  refreshNavigationButtons() {
    const backDisabled = !this.canGoBack();
    const forwardDisabled = !this.canGoForward();
    if (this.backButtonEl) {
      this.backButtonEl.disabled = backDisabled;
      this.backButtonEl.setAttribute("aria-disabled", String(backDisabled));
    }
    if (this.forwardButtonEl) {
      this.forwardButtonEl.disabled = forwardDisabled;
      this.forwardButtonEl.setAttribute("aria-disabled", String(forwardDisabled));
    }
  }
  normalizeAddress(value) {
    return normalizeBrowserAddress(value, (query) => this.plugin.core.searchUrl(query));
  }
};
function webOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : void 0;
  } catch {
    return void 0;
  }
}
function internalSurfaceLabel(url) {
  if (!url?.startsWith("browser://")) return void 0;
  const surface = url.slice("browser://".length).split(/[/?#]/, 1)[0] || "home";
  if (surface === "history") return "History";
  if (surface === "bookmarks") return "Bookmarks";
  if (surface === "home") return "Home";
  return "Browser Core";
}
function residualLabel(kind) {
  if (kind === "reload") return "Reload";
  if (kind === "redirect") return "Redirect";
  if (kind === "in-page") return "In-page navigation";
  return "Browser event";
}
function validSavedFavicon(value) {
  return typeof value === "string" && value.length < 35e4 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value) ? value : void 0;
}

// src/ui/permission-prompt.ts
var import_obsidian14 = require("obsidian");
function promptPermission(app, origin, permission) {
  return new Promise((resolve) => {
    new PermissionPromptModal(app, origin, permission, resolve).open();
  });
}
var PermissionPromptModal = class extends import_obsidian14.Modal {
  constructor(app, origin, permission, resolve) {
    super(app);
    this.origin = origin;
    this.permission = permission;
    this.resolve = resolve;
  }
  settled = false;
  onOpen() {
    this.contentEl.createEl("h2", { text: t("Site permission") });
    this.contentEl.createEl("p", {
      text: t("{v0} is requesting \u201C{v1}\u201D.", { v0: this.origin, v1: permissionLabel(this.permission) })
    });
    this.contentEl.createEl("p", {
      text: t("Allow and Block are remembered for this site in the current container. Not now denies this request without saving a decision.")
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-permission-actions" });
    const notNow = actions.createEl("button", { text: t("Not now") });
    notNow.addEventListener("click", () => this.finish("ask"));
    actions.createEl("button", { text: t("Block") }).addEventListener("click", () => this.finish("block"));
    const allow = actions.createEl("button", { text: t("Allow"), cls: "mod-cta" });
    allow.addEventListener("click", () => this.finish("allow"));
    notNow.focus();
  }
  onClose() {
    this.contentEl.empty();
    if (!this.settled) this.resolve("ask");
  }
  finish(decision) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(decision);
    this.close();
  }
};

// src/ui/tab-search-modal.ts
var import_obsidian15 = require("obsidian");
var TabSearchModal = class extends import_obsidian15.FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder(
      plugin.core.settings().containerMode === "off" ? "Search browser tabs by title, URL, domain, or pinned state" : "Search browser tabs by title, URL, domain, container, or pinned state"
    );
    this.setInstructions([
      { command: "\u2191\u2193", purpose: "Navigate" },
      { command: "\u21B5", purpose: "Switch tab" },
      { command: "Right click", purpose: "Tab actions" }
    ]);
    this.emptyStateText = "No matching browser tabs.";
  }
  onOpen() {
    super.onOpen();
    const bridge = this.resultContainerEl.ownerDocument.createElement("div");
    bridge.className = "ubc-tab-search-bridge";
    const text = bridge.createDiv({ cls: "ubc-tab-search-bridge-copy" });
    text.createEl("strong", { text: t("Looking for a Vault file?") });
    text.createSpan({ text: t("Use Obsidian's Quick Switcher for notes and files.") });
    const button = bridge.createEl("button", {
      text: t("Quick Switcher"),
      attr: { type: "button", "aria-label": t("Open Obsidian Quick Switcher") }
    });
    button.disabled = !this.plugin.commandAdapter.has(this.app, "switcher:open");
    button.addEventListener("click", () => {
      if (button.disabled) return;
      this.close();
      const hostWindow = this.modalEl.ownerDocument.defaultView ?? window;
      hostWindow.requestAnimationFrame(() => this.plugin.openQuickSwitcher());
    });
    this.resultContainerEl.before(bridge);
  }
  getItems() {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    const activeDocument = activeLeaf?.view.containerEl.ownerDocument;
    return this.plugin.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      const lifecycleId = state.lifecycleId || leaf.view.lifecycleIdentity();
      const record = this.plugin.core.state.history.leaves[lifecycleId];
      const containerId = this.plugin.core.normalizeContainer(state.containerId);
      let domain = "";
      try {
        const parsed = new URL(leaf.view.currentUrl());
        domain = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : "";
      } catch {
        domain = "";
      }
      return [{
        leaf,
        title: leaf.view.getDisplayText(),
        url: leaf.view.currentUrl(),
        domain,
        container: this.plugin.core.containers.nameFor(containerId),
        containerId,
        pinned: Boolean(state.pinned),
        active: leaf === activeLeaf,
        sameWindow: !activeDocument || leaf.view.containerEl.ownerDocument === activeDocument,
        lastActiveAt: record?.lastActiveAt ?? 0
      }];
    }).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
  getItemText(item) {
    return [
      item.title,
      item.url,
      item.domain,
      this.plugin.core.settings().containerMode === "off" ? "" : item.container,
      item.pinned ? "pinned pin" : "unpinned",
      item.active ? "current active" : "",
      item.sameWindow ? "" : "other window"
    ].filter(Boolean).join(" ");
  }
  renderSuggestion(match, el) {
    el.empty();
    const primary = el.createDiv({ cls: "ubc-tab-search-primary" });
    primary.createEl("strong", { text: match.item.title || "Browser tab" });
    primary.createSpan({
      cls: "ubc-tab-search-url",
      text: match.item.url.startsWith("browser://") ? t("Browser Core page") : match.item.url
    });
    const meta = el.createDiv({ cls: "ubc-tab-search-meta" });
    const parts = [
      match.item.pinned ? "Pinned" : "",
      match.item.active ? "Current" : "",
      !match.item.sameWindow ? "Other window" : "",
      this.plugin.core.settings().containerMode === "off" ? "" : match.item.container,
      match.item.domain,
      match.item.lastActiveAt ? relativeTime(match.item.lastActiveAt) : ""
    ].filter(Boolean);
    meta.setText(parts.join(" \xB7 "));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const { leaf, title, url } = match.item;
      const view = leaf.view instanceof BrowserView ? leaf.view : void 0;
      const menu = new import_obsidian15.Menu();
      menu.addItem((item) => item.setTitle(t("Switch to tab")).setIcon("mouse-pointer-click").onClick(() => this.plugin.app.workspace.revealLeaf(leaf)));
      menu.addItem((item) => item.setTitle(match.item.pinned ? t("Unpin") : t("Pin")).setIcon("pin").onClick(() => leaf.setPinned(!match.item.pinned)));
      menu.addItem((item) => item.setTitle(t("Move to new window")).setIcon("picture-in-picture").onClick(() => {
        try {
          this.plugin.app.workspace.moveLeafToPopout(leaf);
        } catch {
          new import_obsidian15.Notice(t("This Obsidian build cannot move the tab to a new window."));
        }
      }));
      if (view) {
        if (this.plugin.core.settings().containerMode !== "off") {
          for (const container of this.plugin.core.containers.list()) {
            menu.addItem(
              (item) => item.setTitle("Reopen in " + container.name).setIcon("box").setDisabled(container.id === match.item.containerId).onClick(() => view.reopenInContainer(container.id))
            );
          }
        }
        if (!url.startsWith("browser://")) {
          const bookmark = this.plugin.core.bookmarks.findByUrl(url);
          menu.addItem((item) => item.setTitle(bookmark ? t("Remove bookmark") : t("Bookmark")).setIcon(bookmark ? "bookmark-check" : "bookmark").onClick(() => {
            this.plugin.core.bookmarks.toggleBookmark({ title, url });
            this.plugin.core.scheduleSave();
            this.plugin.refreshBrowserViews();
          }));
          menu.addItem((item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => {
            void navigator.clipboard.writeText(url);
          }));
        }
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => {
        this.close();
        const hostWindow = this.modalEl.ownerDocument.defaultView ?? window;
        hostWindow.requestAnimationFrame(() => this.plugin.openQuickSwitcher());
      }));
      menu.addItem((item) => item.setTitle(t("Close tab")).setIcon("x").onClick(() => leaf.detach()));
      menu.showAtMouseEvent(event);
    });
  }
  onChooseItem(item) {
    this.plugin.app.workspace.revealLeaf(item.leaf);
  }
};
function relativeTime(timestamp) {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// src/persistence/hybrid-persistence.ts
var HybridBrowserPersistence = class {
  constructor(scope, dataPort) {
    this.scope = scope;
    this.dataPort = dataPort;
  }
  revision = 0;
  async load() {
    const lightweight = await this.dataPort.load();
    const lightRevision = lightweight?.__hybridRevision;
    const heavy = lightweight?.__hybridHeavyFallback ? null : await this.loadHeavy(lightRevision);
    if (!lightweight && !heavy) return null;
    if (typeof lightRevision === "number") this.revision = Math.max(this.revision, lightRevision);
    const cleanLightweight = stripHybridMetadata(lightweight);
    if (lightweight?.__hybridHeavyFallback) return cleanLightweight;
    if (!heavy) return cleanLightweight;
    if (typeof lightRevision === "number" && heavy.revision !== lightRevision) {
      return cleanLightweight;
    }
    return {
      ...cleanLightweight ?? {},
      ...heavy.state
    };
  }
  async save(state) {
    const previousRevision = this.revision;
    const revision = Math.max(Date.now(), this.revision + 1);
    const heavy = {
      history: state.history,
      restoreCapsules: state.restoreCapsules,
      formRecovery: state.formRecovery
    };
    const lightweight = {
      version: state.version,
      settings: state.settings,
      siteZoom: state.siteZoom,
      containers: state.containers,
      siteContainerRules: state.siteContainerRules,
      bookmarks: state.bookmarks,
      permissions: state.permissions,
      formRecoveryPolicies: state.formRecoveryPolicies,
      sessionCheckpoint: state.sessionCheckpoint,
      surfingMigration: state.surfingMigration,
      __hybridRevision: revision,
      __hybridHeavyFallback: false
    };
    if (await this.saveHeavy({ revision, state: heavy })) {
      try {
        await this.dataPort.save(lightweight);
        this.revision = revision;
        await this.pruneHeavy(revision);
        return;
      } catch (error) {
        await this.deleteHeavy(revision);
        this.revision = previousRevision;
        throw error;
      }
    }
    await this.dataPort.save({
      ...state,
      __hybridRevision: revision,
      __hybridHeavyFallback: true
    });
    this.revision = revision;
  }
  async loadHeavy(revision) {
    if (typeof indexedDB === "undefined") return null;
    let db;
    try {
      const database = await openDb();
      db = database;
      const read = (key) => new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      const raw = typeof revision === "number" ? await read(this.generationKey(revision)) : await read(this.scope);
      if (!raw && typeof revision === "number") {
        const legacy = await read(this.scope);
        if (legacy && "revision" in legacy && legacy.revision === revision) {
          return legacy;
        }
        return null;
      }
      if (!raw) return null;
      if ("revision" in raw && "state" in raw) return raw;
      return { revision: 0, state: raw };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
  async saveHeavy(envelope) {
    if (typeof indexedDB === "undefined") return false;
    let db;
    try {
      const database = await openDb();
      db = database;
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(envelope, this.generationKey(envelope.revision));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }
  async deleteHeavy(revision) {
    if (typeof indexedDB === "undefined") return;
    let db;
    try {
      const database = await openDb();
      db = database;
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(this.generationKey(revision));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
    } finally {
      db?.close();
    }
  }
  async pruneHeavy(keepRevision) {
    if (typeof indexedDB === "undefined") return;
    let db;
    try {
      const database = await openDb();
      db = database;
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const key = String(cursor.key);
          if (key === this.scope || key.startsWith(this.scope + ":") && key !== this.generationKey(keepRevision)) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
    } finally {
      db?.close();
    }
  }
  generationKey(revision) {
    return this.scope + ":" + revision;
  }
};
function stripHybridMetadata(value) {
  if (!value) return null;
  const { __hybridRevision: _revision, __hybridHeavyFallback: _fallback, ...state } = value;
  return state;
}
var DB_NAME = "unified-browser-core";
var STORE = "heavy-state";
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// src/main.ts
var UnifiedBrowserCorePlugin = class extends import_obsidian16.Plugin {
  core;
  api;
  permissionAdapter = new ElectronPermissionAdapter();
  sessionDataAdapter = new ElectronSessionDataAdapter();
  windowOpenAdapter = new ElectronWindowOpenAdapter();
  contextMenuAdapter = new ElectronContextMenuAdapter();
  managedWebviewBackend = new ManagedWebviewBackend();
  tabStripAdapter = new ObsidianTabStripAdapter();
  settingsAdapter = new ObsidianSettingsAdapter();
  commandAdapter = new ObsidianCommandAdapter();
  homeAdapter;
  bookmarksAdapter;
  surfingMigrationAdapter;
  webViewerBookmarksAdapter;
  persistence;
  unloading = false;
  sessionCheckpointTimer;
  sessionCheckpointArmed = false;
  layoutInitializationInProgress = false;
  homeTakeoverArmed = false;
  replacingEmptyLeaf = false;
  surfingMigrationRunning = false;
  previousSessionCheckpoint = { capturedAt: 0, leaves: [] };
  getPublicApi() {
    return this.api;
  }
  isUnloading() {
    return this.unloading;
  }
  runtimeDiagnostics() {
    return {
      browserLeaves: this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).length,
      liveGuests: this.managedWebviewBackend.activeGuestCount(),
      auxiliaryWindows: this.windowOpenAdapter.activeAuxiliaryWindowCount(),
      permissionSessions: this.permissionAdapter.boundSessionCount()
    };
  }
  scheduleSessionCheckpoint(delayMs = 250) {
    if (this.unloading || !this.sessionCheckpointArmed) return;
    if (this.sessionCheckpointTimer !== void 0) {
      window.clearTimeout(this.sessionCheckpointTimer);
    }
    this.sessionCheckpointTimer = window.setTimeout(() => {
      this.sessionCheckpointTimer = void 0;
      if (this.unloading) return;
      this.captureSessionCheckpoint();
    }, delayMs);
  }
  async onload() {
    this.homeAdapter = new ObsidianHomeAdapter(this.app);
    this.bookmarksAdapter = new ObsidianBookmarksAdapter(this.app);
    this.webViewerBookmarksAdapter = new WebViewerBookmarksAdapter(this.app);
    this.surfingMigrationAdapter = new SurfingMigrationAdapter(this.app);
    this.registerDomEvent(window, "beforeunload", () => this.prepareForShutdown());
    this.register(() => this.prepareForShutdown());
    const persistenceScope = this.app.appId || this.app.vault.getName();
    this.persistence = new HybridBrowserPersistence(
      persistenceScope,
      {
        load: async () => await this.loadData(),
        save: async (value) => this.saveData(value)
      }
    );
    const raw = await this.persistence.load();
    const state = BrowserCore.normalize(raw);
    setLocaleResolver(import_obsidian16.getLanguage);
    setLanguage(state.settings.language);
    this.core = new BrowserCore(
      this.app,
      state,
      { save: async (next) => this.persistence.save(next) },
      persistenceScope
    );
    if ((raw?.version ?? 0) !== state.version) this.core.scheduleSave();
    this.previousSessionCheckpoint = cloneSessionCheckpoint(this.core.state.sessionCheckpoint);
    this.api = new BrowserPublicApi(
      {
        open: (url, options) => this.openFromApi(url, options),
        search: (query, options) => this.openFromApi(this.core.searchUrl(query), options),
        tabs: () => this.browserTabSnapshots(),
        activateTab: (id) => this.activateBrowserTab(id),
        closeTab: (id) => this.closeBrowserTab(id),
        containers: () => this.core.containers.list().map((container) => ({
          id: container.id,
          name: container.name,
          color: container.color,
          icon: container.icon
        })),
        capabilities: () => this.browserCapabilities(),
        bookmarks: (query) => this.browserBookmarkSnapshots(query),
        addBookmark: (input) => {
          const bookmark = this.core.bookmarks.addBookmark({
            title: input.title?.trim() || input.url,
            url: input.url,
            parentId: input.parentId,
            favorite: input.favorite,
            visualKind: input.visualKind,
            visualValue: input.visualValue,
            faviconUrl: input.faviconUrl
          });
          this.core.scheduleSave();
          this.refreshBrowserViews();
          return toBookmarkSnapshot(bookmark);
        },
        history: (query) => {
          const needle = query?.toLowerCase().trim();
          return this.core.history.allNodes().flatMap((node) => {
            if (node.kind !== "navigation") return [];
            if (!needle || node.title.toLowerCase().includes(needle) || node.url.toLowerCase().includes(needle)) {
              return [toHistorySnapshot(node)];
            }
            return [];
          });
        },
        restoreHistoryEntry: async (id, options) => {
          const node = this.core.state.history.nodes[id];
          if (!node || node.kind !== "navigation") return false;
          await this.restoreHistoryNode(node, options);
          return true;
        }
      },
      this.core.events
    );
    this.core.sweepRetention();
    this.registerInterval(window.setInterval(() => this.core.sweepRetention(), 3e5));
    this.registerView(BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, this));
    this.addSettingTab(new BrowserSettingTab(this.app, this));
    this.addRibbonIcon("globe", t("Open browser"), () => this.openBrowser());
    this.addCommand({
      id: "open-browser",
      name: t("Open browser"),
      callback: () => this.openBrowser()
    });
    this.addCommand({
      id: "open-history",
      name: t("Open browser history"),
      callback: () => this.openBrowser({ url: "browser://history" })
    });
    this.addCommand({
      id: "open-bookmarks",
      name: t("Open browser bookmarks"),
      callback: () => this.openBrowser({ url: "browser://bookmarks" })
    });
    this.addCommand({
      id: "import-obsidian-bookmarks",
      name: t("Import web bookmarks from Obsidian Bookmarks"),
      callback: () => void this.importObsidianBookmarks()
    });
    this.addCommand({
      id: "import-webviewer-bookmarks",
      name: t("Import bookmarks from Web viewer Bookmarks"),
      callback: () => void this.importWebViewerBookmarks()
    });
    this.addCommand({
      id: "migrate-from-surfing",
      name: t("Migrate browsing data from Surfing"),
      callback: () => void this.migrateFromSurfing()
    });
    this.addCommand({
      id: "reopen-closed-tab",
      name: t("Reopen last closed browser tab"),
      callback: () => {
        const closed = this.core.history.recentlyClosed(1)[0];
        if (closed) void this.restoreLeaf(closed.id);
        else new import_obsidian16.Notice(t("No recently closed browser tab."));
      }
    });
    this.addCommand({
      id: "search-browser-tabs",
      name: t("Search browser tabs"),
      callback: () => this.openBrowserTabSearch()
    });
    this.addCommand({
      id: "next-browser-tab",
      name: t("Next browser tab"),
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(1);
        return true;
      }
    });
    this.addCommand({
      id: "previous-browser-tab",
      name: t("Previous browser tab"),
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(-1);
        return true;
      }
    });
    this.addCommand({
      id: "close-browser-tab",
      name: t("Close current browser tab"),
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (!(leaf?.view instanceof BrowserView)) return false;
        if (!checking) leaf.detach();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-in",
      name: t("Browser zoom in"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomIn();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-out",
      name: t("Browser zoom out"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomOut();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-reset",
      name: t("Reset browser zoom for site"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.resetZoom();
        return true;
      }
    });
    this.addCommand({
      id: "browser-focus-address",
      name: t("Focus browser address bar"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusAddressBar();
        return true;
      }
    });
    this.addCommand({
      id: "browser-back",
      name: t("Browser back"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goBack();
        return true;
      }
    });
    this.addCommand({
      id: "browser-forward",
      name: t("Browser forward"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goForward();
        return true;
      }
    });
    this.addCommand({
      id: "browser-reload",
      name: t("Reload browser page"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.reload();
        return true;
      }
    });
    this.addCommand({
      id: "browser-bookmark-page",
      name: t("Bookmark current browser page"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.bookmarkCurrentPage();
        return true;
      }
    });
    this.addCommand({
      id: "browser-container-picker",
      name: t("Open browser container picker"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.openContainerPicker();
        return true;
      }
    });
    this.addCommand({
      id: "browser-search-history",
      name: t("Search browser history"),
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusHistorySearch();
        return true;
      }
    });
    this.addCommand({
      id: "restore-browser-session",
      name: t("Restore previous browser session"),
      callback: () => void this.restorePreviousSession(true)
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.sessionCheckpointArmed && this.app.workspace.layoutReady) {
          void this.initializeLayout();
        }
        if (this.ensureHomeTakeoverArmed()) void this.replaceMostRecentEmptyLeafWithHome();
        this.scheduleSessionCheckpoint();
        this.applyTabStyle();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.tabStripAdapter.revealActiveTab(leaf);
        if (this.ensureHomeTakeoverArmed() && leaf?.view.getViewType() === "empty") {
          void this.replaceEmptyLeafWithHome(leaf);
          return;
        }
        if (!(leaf?.view instanceof BrowserView)) return;
        this.core.history.touchLeaf(leaf.view.lifecycleIdentity(), {});
        if (leaf.view.currentInternalSurface() === "home") leaf.view.focusHomeSearch();
        this.core.scheduleSave();
      })
    );
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        this.prepareForShutdown();
        tasks.addPromise(this.core.flush());
      })
    );
    this.tabStripAdapter.bind(
      this,
      (strip) => {
        if (!this.core.settings().tabStripIntegrationEnabled) return false;
        const view = this.activeBrowserView();
        return Boolean(view && strip.closest(".workspace-tabs")?.contains(view.contentEl));
      },
      (event) => this.showTabStripMenu(event)
    );
    this.applyTabStyle();
    this.applyAccessibilityClasses();
    if (this.app.workspace.layoutReady) {
      this.homeTakeoverArmed = true;
      void this.initializeLayout();
    } else {
      this.app.workspace.onLayoutReady(() => {
        this.homeTakeoverArmed = true;
        void this.initializeLayout();
      });
    }
  }
  async initializeLayout() {
    if (this.sessionCheckpointArmed || this.layoutInitializationInProgress) return;
    this.layoutInitializationInProgress = true;
    try {
      const typedBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
      const usableBrowserLeaves = typedBrowserLeaves.filter((leaf) => leaf.view instanceof BrowserView);
      if (typedBrowserLeaves.length !== usableBrowserLeaves.length) return;
      if (usableBrowserLeaves.length === 0) {
        const startup = this.core.settings().startupBehavior;
        if (startup === "restore" && this.core.state.sessionCheckpoint.leaves.length > 0) {
          await this.restorePreviousSession(false);
        } else if (startup === "home") {
          await this.openBrowser({ url: "browser://home" });
        }
      }
      await this.replaceMostRecentEmptyLeafWithHome();
      this.sessionCheckpointArmed = true;
      this.captureSessionCheckpoint();
      this.revealActiveTab();
    } finally {
      this.layoutInitializationInProgress = false;
    }
  }
  ensureHomeTakeoverArmed() {
    if (!this.homeTakeoverArmed && this.app.workspace.layoutReady) {
      this.homeTakeoverArmed = true;
    }
    return this.homeTakeoverArmed;
  }
  prepareForShutdown() {
    if (this.unloading) return;
    this.unloading = true;
    if (this.sessionCheckpointTimer !== void 0) {
      window.clearTimeout(this.sessionCheckpointTimer);
      this.sessionCheckpointTimer = void 0;
    }
    const liveBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    if (liveBrowserLeaves.length > 0) this.captureSessionCheckpoint();
  }
  async replaceMostRecentEmptyLeafWithHome() {
    if (!this.core.settings().replaceEmptyTabsWithHome || this.replacingEmptyLeaf) return false;
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf ? this.replaceEmptyLeafWithHome(leaf) : false;
  }
  async replaceEmptyLeafWithHome(leaf) {
    if (!this.core.settings().replaceEmptyTabsWithHome || this.replacingEmptyLeaf || leaf.view.getViewType() !== "empty") return false;
    this.replacingEmptyLeaf = true;
    try {
      await leaf.setViewState({
        type: BROWSER_VIEW_TYPE,
        active: true,
        state: {
          url: "browser://home",
          containerId: this.core.settings().defaultContainerId
        }
      });
      await this.app.workspace.revealLeaf(leaf);
      return true;
    } finally {
      this.replacingEmptyLeaf = false;
    }
  }
  async onunload() {
    this.prepareForShutdown();
    const liveBrowserLeaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE);
    for (const leaf of liveBrowserLeaves) {
      if (!(leaf.view instanceof BrowserView)) continue;
      this.core.history.closeLeaf(leaf.view.lifecycleIdentity(), "shutdown");
    }
    this.core.sweepRetention();
    this.windowOpenAdapter.dispose();
    this.managedWebviewBackend.dispose();
    this.permissionAdapter.dispose();
    const remaining = this.runtimeDiagnostics();
    if (remaining.liveGuests !== 0 || remaining.auxiliaryWindows !== 0 || remaining.permissionSessions !== 0) {
      console.warn("Unified Browser Core: runtime resources remained after disposal.", remaining);
    }
    this.core.events.clear();
    await this.core.flush();
  }
  async openBrowser(request = {}) {
    const {
      url = "browser://home",
      containerId,
      restoredFromLeafId,
      state: initialState = {},
      reveal = true,
      placement = "tab"
    } = request;
    const leaf = this.app.workspace.getLeaf(placement);
    const explicitContainerId = containerId && this.core.containers.find(containerId) ? containerId : void 0;
    const resolvedContainer = explicitContainerId ? this.core.normalizeContainer(explicitContainerId) : this.core.resolveContainerForNavigation(url, this.core.defaultContainerForNewTab());
    const bypassOrigin = initialState.siteAssignmentBypassOrigin ?? (explicitContainerId ? this.core.containers.bypassOriginForExplicitContainer(url, resolvedContainer) : void 0);
    const bypassReason = bypassOrigin ? initialState.siteAssignmentBypassReason ?? "explicit" : void 0;
    await leaf.setViewState({
      type: BROWSER_VIEW_TYPE,
      active: reveal,
      state: {
        ...initialState,
        url,
        containerId: resolvedContainer,
        siteAssignmentBypassOrigin: bypassOrigin,
        siteAssignmentBypassReason: bypassReason,
        restoredFromLeafId
      }
    });
    if (reveal) this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  async openFromOpener(url, containerId, disposition) {
    await this.openBrowser({
      url,
      containerId,
      state: { siteAssignmentBypassReason: "opener" },
      reveal: disposition !== "background",
      placement: disposition === "new-window" ? "window" : "tab"
    });
  }
  async restoreLeaf(oldLeafId, options = {}) {
    const record = this.core.state.history.leaves[oldLeafId];
    if (!record?.lastUrl) {
      new import_obsidian16.Notice(t("This tab has no restorable URL."));
      return;
    }
    const pinned = options.pinned ?? record.pinned;
    const leaf = await this.openBrowser({
      url: record.lastUrl,
      containerId: options.containerId ?? record.containerId,
      restoredFromLeafId: oldLeafId,
      state: {
        pinned,
        manualRetention: record.manualRetention
      }
    });
    leaf.setPinned(pinned);
  }
  async restoreHistoryNode(node, options = {}) {
    const pinned = options.pinned ?? false;
    const leaf = await this.openBrowser({
      url: node.url,
      containerId: options.containerId ?? node.containerId,
      restoredFromLeafId: node.leafId,
      state: {
        pinned,
        restoreTargetUrl: node.url,
        restoreTargetIndex: node.sessionEntryIndex
      }
    });
    leaf.setPinned(pinned);
  }
  async requestPermission(origin, permission) {
    return promptPermission(this.app, origin, permission);
  }
  bindPermissions(webview, containerId) {
    return this.permissionAdapter.bind(
      webview,
      containerId,
      this.core.permissions,
      (origin, permission) => this.requestPermission(origin, permission),
      () => this.core.scheduleSave()
    );
  }
  async deleteContainer(containerId) {
    if (containerId === "default") return false;
    const container = this.core.containers.find(containerId);
    if (!container) return false;
    const hasLiveLeaf = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).some((leaf) => {
      return leaf.view instanceof BrowserView && leaf.view.getState().containerId === containerId;
    });
    if (hasLiveLeaf) {
      new import_obsidian16.Notice(t("Close or reopen tabs using this container before deleting it."));
      return false;
    }
    this.permissionAdapter.release(containerId);
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new import_obsidian16.Notice(t("Could not clear this container's browsing data, so the container was not deleted."));
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.formRecovery.clearContainer(containerId);
    const removed = this.core.containers.remove(containerId);
    if (removed) {
      this.core.scheduleSave();
      new import_obsidian16.Notice(t("Deleted container \u201C{v0}\u201D and cleared its browsing data.", { v0: container.name }));
    }
    return removed;
  }
  clearBrowserHistory() {
    const cleared = this.core.history.clearAll();
    const restoreCapsules = this.core.restore.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (!(leaf.view instanceof BrowserView)) continue;
      const state = leaf.view.getState();
      this.core.history.beginLeaf({
        leafId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        pinned: state.pinned ?? false,
        manualRetention: state.manualRetention ?? "default",
        url: state.url || leaf.view.currentUrl(),
        title: leaf.view.getDisplayText()
      });
      this.core.suppressRichRestoreForLeaf(state.lifecycleId || leaf.view.lifecycleIdentity());
    }
    this.captureSessionCheckpoint();
    this.core.scheduleSave();
    return { ...cleared, restoreCapsules };
  }
  clearRichRestoreData() {
    const count = this.core.restore.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (!(leaf.view instanceof BrowserView)) continue;
      this.core.suppressRichRestoreForLeaf(leaf.view.lifecycleIdentity());
    }
    this.core.scheduleSave();
    return count;
  }
  clearFormRecoveryData() {
    const count = this.core.formRecovery.clearAll();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) void leaf.view.resetFormRecoveryCaptureBaseline();
    }
    this.core.scheduleSave();
    return count;
  }
  clearPermissionDecisions() {
    const count = this.core.permissions.clearAll();
    this.core.scheduleSave();
    return count;
  }
  async clearContainerSession(containerId) {
    const container = this.core.containers.find(containerId);
    if (!container) return false;
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new import_obsidian16.Notice(t("Could not clear browsing data for \u201C{v0}\u201D.", { v0: container.name }));
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.scheduleSave();
    new import_obsidian16.Notice(t("Cleared browsing data and saved permissions for \u201C{v0}\u201D.", { v0: container.name }));
    return true;
  }
  captureSessionCheckpoint() {
    const leaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      const state = leaf.view.getState();
      if (!(leaf.view instanceof BrowserView)) {
        const previous = this.core.state.sessionCheckpoint.leaves.find((saved) => saved.sourceLifecycleId === state.lifecycleId);
        if (!state.lifecycleId || !state.url) return previous ? [previous] : [];
        return [{
          ...previous,
          ...state,
          sourceLifecycleId: state.lifecycleId,
          url: state.url,
          containerId: state.containerId || this.core.settings().defaultContainerId,
          pinned: state.pinned ?? false,
          manualRetention: state.manualRetention ?? "default"
        }];
      }
      return [{
        title: state.title,
        faviconDataUrl: state.faviconDataUrl,
        sourceLifecycleId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        url: state.url || leaf.view.currentUrl(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        siteAssignmentBypassOrigin: state.siteAssignmentBypassOrigin,
        siteAssignmentBypassReason: state.siteAssignmentBypassReason,
        pinned: state.pinned ?? false,
        manualRetention: state.manualRetention ?? "default",
        internalSurface: state.internalSurface,
        transientHistory: state.transientHistory,
        transientIndex: state.transientIndex
      }];
    });
    this.core.setSessionCheckpoint({ capturedAt: Date.now(), leaves });
  }
  async restorePreviousSession(notify) {
    const checkpoint = this.previousSessionCheckpoint;
    if (!checkpoint.leaves.length) {
      if (notify) new import_obsidian16.Notice(t("No previous browser session is available."));
      return;
    }
    const leavesToRestore = this.pendingPreviousSessionLeaves();
    if (!leavesToRestore.length) {
      if (notify) new import_obsidian16.Notice(t("The previous browser session is already restored."));
      return;
    }
    for (const saved of leavesToRestore) {
      const leaf = await this.openBrowser({
        url: saved.url,
        containerId: saved.containerId,
        restoredFromLeafId: saved.sourceLifecycleId,
        state: {
          title: saved.title,
          faviconDataUrl: saved.faviconDataUrl,
          pinned: saved.pinned,
          manualRetention: saved.manualRetention,
          siteAssignmentBypassOrigin: saved.siteAssignmentBypassOrigin,
          siteAssignmentBypassReason: saved.siteAssignmentBypassReason,
          internalSurface: saved.internalSurface,
          transientHistory: saved.transientHistory,
          transientIndex: saved.transientIndex
        }
      });
      leaf.setPinned(saved.pinned);
    }
    if (notify) new import_obsidian16.Notice(t("Restored {v0} browser tab(s).", { v0: leavesToRestore.length }));
  }
  pendingPreviousSessionLeaves() {
    const liveRepresentations = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      return [{
        lifecycleId: state.lifecycleId || leaf.view.lifecycleIdentity(),
        restoredFromLeafId: state.restoredFromLeafId
      }];
    });
    return pendingSessionLeaves(this.previousSessionCheckpoint, liveRepresentations);
  }
  applyTabStyle() {
    const settings = this.core.settings();
    const policy = resolveTabLayoutPolicy(settings.tabStyle);
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      const state = leaf.view.getState();
      if (!(leaf.view instanceof BrowserView)) {
        const saved = this.core.state.history.leaves[state.lifecycleId ?? state.restoredFromLeafId ?? ""];
        const savedEntry = state.transientHistory?.[state.transientIndex ?? state.transientHistory.length - 1];
        const title = state.title || (savedEntry?.kind === "web" ? savedEntry.title : void 0) || saved?.lastTitle || state.url || t("Browser");
        this.tabStripAdapter.refreshLeafHeader(leaf, false, title);
        const favicon = typeof state.faviconDataUrl === "string" && state.faviconDataUrl.length < 35e4 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(state.faviconDataUrl) ? state.faviconDataUrl : void 0;
        this.tabStripAdapter.applyLeafFavicon(leaf, favicon);
        leaf.tabHeaderEl?.addClass("ubc-browser-tab-pending");
      }
      const container = settings.containerMode !== "off" && state.containerId ? this.core.containers.find(state.containerId) : void 0;
      this.tabStripAdapter.applyLeafStyle(
        leaf,
        policy,
        settings.tabStripIntegrationEnabled,
        Boolean(state.pinned),
        container?.color
      );
    }
    this.tabStripAdapter.refreshAllStrips(this.app.workspace);
    this.revealActiveTab();
  }
  revealActiveTab() {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf) this.tabStripAdapter.revealActiveTab(leaf);
  }
  refreshLoadingShields() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshLoadingShield();
    }
  }
  applyAccessibilityClasses() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.applyAccessibility();
    }
  }
  refreshBrowserViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrowserView) {
        view.renderFavoritesBar();
        view.refreshRecoveryNotification();
      }
    }
  }
  refreshBrowserZoom() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshZoom();
    }
  }
  refreshContainerPresentation() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshContainerPresentation();
    }
  }
  refreshFormRecoveryInstrumentation() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) void leaf.view.syncFormRecoveryInstrumentation();
    }
  }
  openSettings() {
    if (!this.settingsAdapter.openPluginSettings(this.app, this.manifest.id)) {
      new import_obsidian16.Notice(t("Open Obsidian Settings \u2192 Community plugins \u2192 Unified Browser Core."));
    }
  }
  async importObsidianBookmarks(notify = true) {
    const snapshot = await this.bookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new import_obsidian16.Notice(t("Obsidian Bookmarks is unavailable or has no readable bookmark data."));
      return { available: false, added: 0, reused: 0, foldersCreated: 0, skippedNonWeb: 0 };
    }
    const imported = this.core.bookmarks.importWebBookmarks(snapshot.entries);
    if (imported.added || imported.foldersCreated) {
      this.core.scheduleSave();
      this.refreshBrowserViews();
    }
    if (notify) {
      const parts = [
        imported.added ? `Imported ${imported.added} web bookmark${imported.added === 1 ? "" : "s"}` : "No new web bookmarks",
        imported.reused ? `${imported.reused} already present` : "",
        imported.foldersCreated ? `${imported.foldersCreated} folder${imported.foldersCreated === 1 ? "" : "s"} created` : "",
        snapshot.skippedNonWeb ? `${snapshot.skippedNonWeb} non-web item${snapshot.skippedNonWeb === 1 ? "" : "s"} left in Obsidian Bookmarks` : ""
      ].filter(Boolean);
      new import_obsidian16.Notice(parts.join(" \xB7 "));
    }
    return { available: true, ...imported, skippedNonWeb: snapshot.skippedNonWeb };
  }
  refreshLanguage() {
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshLanguage();
    }
  }
  async importWebViewerBookmarks(notify = true) {
    const snapshot = await this.webViewerBookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new import_obsidian16.Notice(t("Web viewer Bookmarks has no readable data in this vault."));
      return { available: false, added: 0, reused: 0, skippedInvalid: 0 };
    }
    const imported = this.core.bookmarks.importWebBookmarks(snapshot.entries);
    if (imported.added) {
      this.core.scheduleSave();
      this.refreshBrowserViews();
    }
    if (notify) {
      const parts = [
        imported.added ? `Imported ${imported.added} bookmark${imported.added === 1 ? "" : "s"}` : "No new bookmarks",
        imported.reused ? `${imported.reused} already present` : "",
        snapshot.skippedInvalid ? `${snapshot.skippedInvalid} invalid item${snapshot.skippedInvalid === 1 ? "" : "s"} skipped` : ""
      ].filter(Boolean);
      new import_obsidian16.Notice(parts.join(" \xB7 "));
    }
    return { available: true, added: imported.added, reused: imported.reused, skippedInvalid: snapshot.skippedInvalid };
  }
  async migrateFromSurfing() {
    if (this.surfingMigrationRunning) return;
    this.surfingMigrationRunning = true;
    try {
      const previous = this.core.state.surfingMigration;
      if (previous?.completedAt) {
        new import_obsidian16.Notice(t("Surfing migration already completed. Backup: {v0}", { v0: previous.backupPath }));
        return;
      }
      const snapshot = previous ? null : await this.surfingMigrationAdapter.scan();
      if (snapshot && !snapshot.settingsFound && !snapshot.bookmarksFound && snapshot.tabs.length === 0) {
        new import_obsidian16.Notice(t("No Surfing data was found in this vault. Run migration before uninstalling Surfing."));
        return;
      }
      if (snapshot && (snapshot.settingsFound && !snapshot.settings || snapshot.bookmarksFound && !snapshot.bookmarksValid)) {
        new import_obsidian16.Notice(t("Surfing data could not be read safely. No changes were made."));
        return;
      }
      const tabs = previous?.tabs ?? snapshot?.tabs ?? [];
      const message = previous ? `Resume the interrupted Surfing migration? ${tabs.length - previous.completedTabKeys.length} tab(s) remain.` : `Adopt Surfing's persistent browsing profile, import ${snapshot.bookmarks.length} bookmark(s), apply compatible settings and open ${tabs.length} saved tab(s)? Browser Core will save a backup first. Surfing data will remain untouched.${snapshot.warnings.length ? ` Warnings: ${snapshot.warnings.join(" ")}` : ""}`;
      const confirmed = await confirmAction(this.app, t("Migrate from Surfing"), message, t("Migrate"));
      if (!confirmed) return;
      let record = previous;
      if (!record && snapshot) {
        const vault = this.app.vault;
        const configDir = vault.configDir || ".obsidian";
        const backupPath = `${configDir}/plugins/${this.manifest.id}/surfing-migration-backup-${Date.now()}.json`;
        await this.app.vault.adapter.write(backupPath, JSON.stringify({
          format: "ubc-surfing-migration-backup-v1",
          savedAt: Date.now(),
          ubcBeforeMigration: this.core.state,
          surfingSettings: snapshot.settings,
          surfingBookmarks: snapshot.bookmarksRaw,
          surfingTabs: snapshot.tabs,
          sourcePartition: snapshot.sourcePartition
        }, null, 2));
        const container = this.core.containers.list().find((candidate) => candidate.partition === snapshot.sourcePartition) ?? this.core.containers.create("Surfing profile", "#8a75d6", "globe");
        container.partition = snapshot.sourcePartition;
        const previousDefaultContainerId = this.core.settings().defaultContainerId;
        record = {
          sourcePartition: snapshot.sourcePartition,
          surfingContainerId: container.id,
          previousDefaultContainerId,
          backupPath,
          startedAt: Date.now(),
          tabs,
          completedTabKeys: [],
          historyLeafIds: {},
          initialImportComplete: false,
          bookmarksAdded: 0,
          bookmarksReused: 0,
          settingsImported: false
        };
        this.core.state.surfingMigration = record;
        await this.core.flush();
      }
      if (!record) throw new Error("Migration state was not initialized.");
      if (!record.initialImportComplete) {
        let settings = snapshot?.settings ?? null;
        let bookmarks = snapshot?.bookmarks ?? [];
        let folderPaths = snapshot?.folderPaths ?? [];
        if (!snapshot) {
          const backup = JSON.parse(await this.app.vault.adapter.read(record.backupPath));
          settings = backup.surfingSettings;
          const parsed = normalizeSurfingBookmarks(backup.surfingBookmarks);
          if (backup.surfingBookmarks != null && !parsed.valid) {
            throw new Error("The Surfing bookmark backup could not be read safely.");
          }
          bookmarks = parsed.entries;
          folderPaths = surfingFolderPaths(backup.surfingBookmarks);
        }
        const searchUrlTemplate = surfingSearchTemplate(settings);
        const bookmarkManager = settings?.bookmarkManager;
        this.core.updateSettings({
          defaultContainerId: record.surfingContainerId,
          homeSearchMode: "web",
          ...searchUrlTemplate ? { searchUrlTemplate } : {},
          ...bookmarkManager && typeof bookmarkManager === "object" && "openBookMark" in bookmarkManager && typeof bookmarkManager.openBookMark === "boolean" ? { showFavoritesBar: bookmarkManager.openBookMark } : {}
        });
        for (const path of folderPaths) this.core.bookmarks.ensureFolderPath(path);
        const imported = this.core.bookmarks.importWebBookmarks(bookmarks);
        record.bookmarksAdded = imported.added;
        record.bookmarksReused = imported.reused;
        record.settingsImported = Boolean(settings);
        record.initialImportComplete = true;
        await this.core.flush();
      }
      for (const tab of record.tabs) {
        if (record.completedTabKeys.includes(tab.sourceKey)) continue;
        let historyLeafId = record.historyLeafIds[tab.sourceKey];
        if (!historyLeafId) {
          historyLeafId = createId("surfing-history");
          this.core.history.beginLeaf({
            leafId: historyLeafId,
            containerId: record.surfingContainerId,
            url: tab.history[0]?.url ?? tab.url,
            title: tab.title
          });
          const importedNodes = [];
          for (const entry of tab.history) {
            if (entry.kind !== "web") continue;
            const node = this.core.history.addNavigation({
              leafId: historyLeafId,
              containerId: record.surfingContainerId,
              url: entry.url,
              title: entry.title
            });
            importedNodes.push(node.id);
          }
          const activeNodeId = importedNodes[tab.historyIndex];
          if (activeNodeId) {
            this.core.state.history.currentByLeaf[historyLeafId] = activeNodeId;
            this.core.history.touchLeaf(historyLeafId, { lastUrl: tab.url, lastTitle: tab.title });
          }
          this.core.history.closeLeaf(historyLeafId, "replaced");
          record.historyLeafIds[tab.sourceKey] = historyLeafId;
          await this.core.flush();
        }
        const alreadyOpen = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).some((candidate) => {
          const state = candidate.getViewState().state;
          return state?.restoredFromLeafId === historyLeafId && state.url === tab.url;
        });
        if (alreadyOpen) {
          record.completedTabKeys.push(tab.sourceKey);
          await this.core.flush();
          continue;
        }
        const leaf = await this.openBrowser({
          url: tab.url,
          containerId: record.surfingContainerId,
          restoredFromLeafId: historyLeafId,
          reveal: tab.active,
          state: { pinned: tab.pinned, transientHistory: tab.history, transientIndex: tab.historyIndex }
        });
        leaf.setPinned(tab.pinned);
        record.completedTabKeys.push(tab.sourceKey);
        await this.core.flush();
      }
      record.completedAt = Date.now();
      this.refreshBrowserViews();
      this.refreshContainerPresentation();
      if (this.sessionCheckpointArmed) this.captureSessionCheckpoint();
      await this.core.flush();
      new import_obsidian16.Notice(`Surfing migration complete: ${record.bookmarksAdded} bookmark(s) added, ${record.tabs.length} tab(s) opened. Backup: ${record.backupPath}`, 12e3);
    } catch (error) {
      console.error("Unified Browser Core: Surfing migration failed.", error);
      new import_obsidian16.Notice(t("Surfing migration stopped. Source data was not deleted; run the command again to resume."), 12e3);
    } finally {
      this.surfingMigrationRunning = false;
    }
  }
  async openFromApi(url, options = {}) {
    const disposition = options.disposition ?? "new-tab";
    if (disposition === "current") {
      const current = this.activeBrowserView();
      if (current && (!options.containerId || current.getState().containerId === options.containerId)) {
        current.navigate(url);
        return;
      }
    }
    await this.openBrowser({
      url,
      containerId: options.containerId,
      reveal: disposition !== "background",
      placement: disposition === "new-window" ? "window" : "tab"
    });
  }
  browserTabSnapshots() {
    const activeLeaf = this.app.workspace.activeLeaf;
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      const id = state.lifecycleId || leaf.view.lifecycleIdentity();
      return [{
        id,
        lifecycleId: id,
        title: leaf.view.getDisplayText(),
        url: leaf.view.currentUrl(),
        containerId: state.containerId || this.core.settings().defaultContainerId,
        pinned: state.pinned ?? false,
        active: leaf === activeLeaf
      }];
    });
  }
  browserBookmarkSnapshots(query) {
    const entries = query ? this.core.bookmarks.search(query) : this.core.bookmarks.allBookmarks();
    return entries.map(toBookmarkSnapshot);
  }
  async activateBrowserTab(id) {
    const leaf = this.browserLeafByLifecycleId(id);
    if (!leaf) return false;
    await this.app.workspace.revealLeaf(leaf);
    return true;
  }
  closeBrowserTab(id) {
    const leaf = this.browserLeafByLifecycleId(id);
    if (!leaf) return false;
    leaf.detach();
    return true;
  }
  browserLeafByLifecycleId(id) {
    return this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).find((leaf) => {
      return leaf.view instanceof BrowserView && leaf.view.lifecycleIdentity() === id;
    });
  }
  browserCapabilities() {
    return {
      apiVersion: 5,
      runtime: "managed-webview",
      isolatedContainers: true,
      siteContainerAssignments: true,
      graphHistory: true,
      richRestore: "best-effort",
      formRecovery: true,
      permissions: "best-effort",
      internalSurfaces: true,
      bookmarkVisuals: true,
      favorites: true
    };
  }
  cycleBrowserTab(delta) {
    const active = this.app.workspace.activeLeaf;
    const leaves = this.browserTabsInActiveGroup();
    if (leaves.length < 2) return;
    const index = active ? leaves.indexOf(active) : -1;
    if (index < 0) return;
    const target = leaves[(index + delta + leaves.length) % leaves.length];
    if (target) this.app.workspace.revealLeaf(target);
  }
  browserTabsInActiveGroup() {
    const active = this.app.workspace.activeLeaf;
    if (!(active?.view instanceof BrowserView)) return [];
    return this.tabStripAdapter.leavesInSameGroup(active).filter((leaf) => leaf.view instanceof BrowserView);
  }
  openBrowserTabSearch() {
    new TabSearchModal(this.app, this).open();
  }
  openQuickSwitcher() {
    if (!this.commandAdapter.openQuickSwitcher(this.app)) {
      new import_obsidian16.Notice(t("Obsidian Quick Switcher is not available."));
    }
  }
  showTabStripMenu(event) {
    const menu = new import_obsidian16.Menu();
    menu.addItem((item) => item.setTitle(t("New browser tab")).setIcon("plus").onClick(() => void this.openBrowser()));
    for (const container of this.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle("New tab in " + container.name).setIcon("box").onClick(() => void this.openBrowser({ url: "browser://home", containerId: container.id }))
      );
    }
    const closed = this.core.history.recentlyClosed(1)[0];
    menu.addItem(
      (item) => item.setTitle(t("Reopen closed tab")).setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.restoreLeaf(closed.id);
      })
    );
    menu.addItem((item) => item.setTitle(t("Search browser tabs")).setIcon("search").onClick(() => this.openBrowserTabSearch()));
    menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => this.openQuickSwitcher()));
    const active = this.activeBrowserView();
    menu.addItem(
      (item) => item.setTitle(t("Bookmark all open browser tabs")).setIcon("book-marked").setDisabled(!active).onClick(() => active?.bookmarkAllOpenTabs())
    );
    menu.addItem(
      (item) => item.setTitle(t("Restore previous browser session")).setDisabled(this.pendingPreviousSessionLeaves().length === 0).onClick(() => void this.restorePreviousSession(true))
    );
    menu.addSeparator();
    for (const style of ["firefox", "chrome"]) {
      menu.addItem(
        (item) => item.setTitle("Tab style: " + (style === "firefox" ? "Firefox" : "Chrome")).setChecked(this.core.settings().tabStyle === style).onClick(() => {
          this.core.updateSettings({ tabStyle: style });
          this.applyTabStyle();
        })
      );
    }
    menu.showAtMouseEvent(event);
  }
  activeBrowserView() {
    const leaf = this.app.workspace.activeLeaf;
    return leaf?.view instanceof BrowserView ? leaf.view : void 0;
  }
};
function toBookmarkSnapshot(bookmark) {
  return {
    id: bookmark.id,
    parentId: bookmark.parentId,
    title: bookmark.title,
    url: bookmark.url,
    favorite: bookmark.favorite,
    visualKind: bookmark.visualKind,
    visualValue: bookmark.visualValue,
    faviconUrl: bookmark.faviconUrl
  };
}
function toHistorySnapshot(node) {
  return {
    id: node.id,
    tabId: node.leafId,
    containerId: node.containerId,
    timestamp: node.timestamp,
    title: node.title,
    url: node.url
  };
}
