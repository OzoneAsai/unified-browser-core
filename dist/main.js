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
var import_obsidian15 = require("obsidian");

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
  const frameName = details.frameName?.trim();
  if (frameName && !["_blank", "_self", "_top", "_parent"].includes(frameName.toLowerCase())) return "auxiliary";
  if (details.features?.trim()) return "auxiliary";
  return "core-tab";
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
  create(partition) {
    const webview = document.createElement("webview");
    webview.addClass("ubc-webview");
    webview.partition = partition;
    webview.setAttribute("allowpopups", "");
    webview.setAttribute(
      "webpreferences",
      "contextIsolation=yes,nodeIntegration=no,sandbox=yes"
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
  dispose() {
    for (const webview of [...this.liveGuests]) this.destroy(webview);
  }
  activeGuestCount() {
    return this.liveGuests.size;
  }
};

// src/adapters/obsidian-tab-strip.ts
var ObsidianTabStripAdapter = class {
  leavesInSameGroup(leaf) {
    const parent = leaf.parent;
    return Array.isArray(parent.children) ? parent.children.filter(Boolean) : [leaf];
  }
  bind(plugin, shouldHandle, onContextMenu) {
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
    this.refreshStripStyle(strip);
  }
  clearLeafStyle(leaf) {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const strip = header.parentElement;
    header.removeClass(
      "ubc-browser-tab",
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
    window.requestAnimationFrame(() => {
      this.refreshStripStyle(strip);
    });
  }
  refreshLeafHeader(leaf, activeInWindow = false) {
    const compatLeaf = leaf;
    const title = leaf.view.getDisplayText();
    const viewCompat = leaf.view;
    const viewTitleEl = viewCompat.titleEl ?? leaf.view.containerEl.querySelector(".view-header-title");
    if (viewTitleEl && viewTitleEl.innerText !== title) viewTitleEl.innerText = title;
    compatLeaf.updateHeader?.();
    if (compatLeaf.tabHeaderInnerTitleEl && compatLeaf.tabHeaderInnerTitleEl.innerText !== title) {
      compatLeaf.tabHeaderInnerTitleEl.innerText = title;
    }
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
    if (!headers.length || !browserHeaders.length) return;
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
    for (const header of headers) header.addClass("ubc-browser-tab-layout");
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
      createdAt: Date.now(),
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
      let parentId = null;
      for (const rawTitle of entry.folderPath) {
        const title = rawTitle.trim();
        if (!title) continue;
        const existing2 = this.children(parentId).find(
          (child) => child.kind === "folder" && child.title === title
        );
        if (existing2) {
          parentId = existing2.id;
          continue;
        }
        const folder = this.addFolder(title, parentId);
        parentId = folder.id;
        foldersCreated += 1;
      }
      const existing = this.findByUrl(entry.url);
      if (existing) {
        reused += 1;
        continue;
      }
      this.addBookmark({
        title: entry.title,
        url: entry.url,
        parentId,
        favorite: entry.favorite,
        visualKind: entry.visualKind,
        visualValue: entry.visualValue
      });
      added += 1;
    }
    return { added, reused, foldersCreated };
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
    return Object.values(this.state.bookmarks).filter((bookmark) => bookmark.title.toLowerCase().includes(needle) || bookmark.url.toLowerCase().includes(needle)).sort((a, b) => b.createdAt - a.createdAt);
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
  defaultZoomFactor: 1,
  defaultContainerId: "default",
  containerMode: "automatic",
  showFavoritesBar: true
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
      version: 5,
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
      sessionCheckpoint: raw?.sessionCheckpoint ?? { capturedAt: 0, leaves: [] }
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
    return this.state.settings.containerMode === "off" ? this.containers.ensureDefault().id : this.normalizeContainer(this.state.settings.defaultContainerId);
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
    const cancel = actions.createEl("button", { text: "Cancel" });
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
  if (known) return known;
  const words = permission.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim();
  if (!words) return "Site permission";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function permissionDecisionLabel(decision) {
  if (decision === "allow") return "Allow";
  if (decision === "block") return "Block";
  return "Ask next time";
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
    new import_obsidian3.Setting(containerEl).setName("Unified Browser Core").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Tab style").setDesc("Firefox keeps a readable minimum tab width and overflows horizontally. Chrome compresses tabs more aggressively.").addDropdown(
      (dropdown) => dropdown.addOption("firefox", "Firefox").addOption("chrome", "Chrome").setValue(this.plugin.core.settings().tabStyle).onChange((value) => {
        this.plugin.core.updateSettings({ tabStyle: value });
        this.plugin.applyTabStyle();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Use Browser Core tab layout").setDesc("Apply the selected browser tab style only to panes that contain Browser Core tabs.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().tabStripIntegrationEnabled).onChange((value) => {
        this.plugin.core.updateSettings({ tabStripIntegrationEnabled: value });
        this.plugin.applyTabStyle();
      })
    );
    const currentSearchTemplate = this.plugin.core.settings().searchUrlTemplate;
    const currentSearchPreset = searchPresetForTemplate(currentSearchTemplate);
    let customSearchSetting;
    const searchEngineSetting = new import_obsidian3.Setting(containerEl).setName("Web search engine").setDesc("Used when Browser Core treats text as a web search rather than an address.");
    searchEngineSetting.addDropdown((dropdown) => {
      for (const preset of SEARCH_PRESETS) dropdown.addOption(preset.id, preset.name);
      dropdown.addOption("custom", "Custom");
      dropdown.setValue(currentSearchPreset?.id ?? "custom").onChange((value) => {
        const preset = SEARCH_PRESETS.find((candidate) => candidate.id === value);
        if (preset) this.plugin.core.updateSettings({ searchUrlTemplate: preset.template });
        if (customSearchSetting) {
          customSearchSetting.settingEl.style.display = value === "custom" ? "" : "none";
        }
      });
    });
    customSearchSetting = new import_obsidian3.Setting(containerEl).setName("Custom search URL").setDesc("Use {query} where the encoded search text should be inserted.").addText(
      (text) => text.setPlaceholder("https://search.example/?q={query}").setValue(currentSearchTemplate).onChange((value) => {
        const template = value.trim();
        if (template.includes("{query}")) this.plugin.core.updateSettings({ searchUrlTemplate: template });
      })
    );
    customSearchSetting.settingEl.style.display = currentSearchPreset ? "none" : "";
    new import_obsidian3.Setting(containerEl).setName("Home").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Replace new empty tabs with Home").setDesc("A newly created empty Obsidian tab becomes the Browser Core Home surface.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().replaceEmptyTabsWithHome).onChange((value) => {
        this.plugin.core.updateSettings({ replaceEmptyTabsWithHome: value });
        if (value) void this.plugin.replaceMostRecentEmptyLeafWithHome();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Default Home search").setDesc("Vault searches files in this vault. Web searches the web or opens an address.").addDropdown(
      (dropdown) => dropdown.addOption("vault", "Vault files").addOption("web", "Web").setValue(this.plugin.core.settings().homeSearchMode).onChange((value) => {
        if (value === "vault" || value === "web") {
          this.plugin.core.updateSettings({ homeSearchMode: value });
          this.plugin.refreshBrowserViews();
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Show bookmarked Vault files on Home").setDesc("Reads file bookmarks from Obsidian's built-in Bookmarks plugin without mixing them with web bookmarks.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showVaultBookmarksOnHome).onChange((value) => {
        this.plugin.core.updateSettings({ showVaultBookmarksOnHome: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Show recent Vault files on Home").setDesc("Uses Obsidian's recent-file list; Browser Core does not maintain a duplicate recent-file database.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showRecentVaultFilesOnHome).onChange((value) => {
        this.plugin.core.updateSettings({ showRecentVaultFilesOnHome: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Browser startup").setDesc("Choose what happens when Obsidian starts and no browser tabs are already open.").addDropdown(
      (dropdown) => dropdown.addOption("restore", "Restore previous browser session").addOption("home", "Open Home").addOption("none", "Do nothing").setValue(this.plugin.core.settings().startupBehavior).onChange((value) => {
        if (value === "restore" || value === "home" || value === "none") {
          this.plugin.core.updateSettings({ startupBehavior: value });
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("History & recovery").setHeading();
    new import_obsidian3.Setting(containerEl).setName("History day starts at").setDesc("History day boundaries default to 04:00 so late-night work stays together.").addText((text) => {
      text.inputEl.type = "time";
      text.setValue(formatDayStart(this.plugin.core.settings().historyDayStartMinutes));
      text.onChange((value) => {
        const minutes = parseDayStart(value);
        if (minutes !== void 0) this.plugin.core.updateSettings({ historyDayStartMinutes: minutes });
      });
    });
    new import_obsidian3.Setting(containerEl).setName("History retention (days)").setDesc("0 keeps browsing history until you delete it. Protected tab histories are not removed automatically.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().historyRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ historyRetentionDays: days });
      })
    );
    const advancedStorage = containerEl.createEl("details", { cls: "ubc-settings-advanced" });
    advancedStorage.createEl("summary", { text: "Advanced history and recovery storage" });
    const advancedStorageEl = advancedStorage.createDiv({ cls: "ubc-settings-advanced-content" });
    new import_obsidian3.Setting(advancedStorageEl).setName("Automatic history size limit").setDesc("0 disables size-based cleanup. A positive value allows the oldest closed, unprotected tab histories to be removed when stored history grows past this limit.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().historyMaxNodes)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && (count === 0 || count >= 1e3)) {
          this.plugin.core.updateSettings({ historyMaxNodes: Math.floor(count) });
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Detailed tab recovery retention (days)").setDesc("How long Browser Core should keep extra state that can restore recently closed tabs more accurately.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().restoreRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ restoreRetentionDays: days });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName("Detailed recovery storage limit (MB)").setDesc("When this budget is exceeded, older unprotected recovery data may fall back to URL-only reopening.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().restoreStorageLimitMb)).onChange((value) => {
        const mb = Number(value);
        if (Number.isFinite(mb) && mb >= 16) this.plugin.core.updateSettings({ restoreStorageLimitMb: mb });
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Form recovery").setDesc("Allow form recovery as a feature. Capture remains opt-in per site, and password/payment credentials are excluded.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().formRecoveryEnabled).onChange((value) => {
        this.plugin.core.updateSettings({ formRecoveryEnabled: value });
        this.plugin.refreshFormRecoveryInstrumentation();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Form recovery retention (days)").setDesc("How long saved non-credential form values are retained.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryRetentionDays)).onChange((value) => {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ formRecoveryRetentionDays: days });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName("Saved form versions per page").setDesc("How many recent recovery versions to keep for one page. Multi-step forms can use values from several versions.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryMaxSnapshotsPerUrl)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxSnapshotsPerUrl: Math.floor(count) });
      })
    );
    new import_obsidian3.Setting(advancedStorageEl).setName("Pages with saved form recovery").setDesc("Maximum number of distinct pages that may keep form recovery data.").addText(
      (text) => text.setValue(String(this.plugin.core.settings().formRecoveryMaxUrls)).onChange((value) => {
        const count = Number(value);
        if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxUrls: Math.floor(count) });
      })
    ).addExtraButton(
      (button) => button.setIcon("trash").setTooltip("Clear all saved form recovery data").onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          "Clear form recovery data",
          "Delete all saved Browser Core form recovery data? Sites that opted in will stay enabled.",
          "Clear form data"
        );
        if (!confirmed) return;
        this.plugin.clearFormRecoveryData();
      })
    );
    const recoveryPolicies = this.plugin.core.formRecovery.policies();
    if (recoveryPolicies.length) {
      new import_obsidian3.Setting(containerEl).setName("Form recovery by site").setHeading();
      for (const policy of recoveryPolicies) {
        new import_obsidian3.Setting(containerEl).setName(`${this.plugin.core.containers.nameFor(policy.containerId)} \xB7 ${policy.origin}`).setDesc(
          policy.disabled ? "Disabled for this site" : `${policy.excludedFieldKeys.length} excluded field(s)`
        ).addExtraButton(
          (button) => button.setIcon("rotate-ccw").setTooltip("Reset form recovery for this site").onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Reset form recovery for site",
              `Reset form recovery for ${policy.origin}? This also deletes saved form recovery data for this site.`,
              "Reset site"
            );
            if (!confirmed) return;
            this.plugin.core.formRecovery.resetPolicy(policy.containerId, policy.origin);
            this.plugin.core.scheduleSave();
            this.display();
          })
        );
      }
    }
    new import_obsidian3.Setting(containerEl).setName("Browsing data").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Clear browsing history").setDesc("Deletes browsing history and detailed recovery data for closed tabs. Open tabs stay open.").addButton(
      (button) => button.setButtonText("Clear history").setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          "Clear browser history",
          "Delete browsing history and detailed closed-tab recovery data? Open tabs, bookmarks, containers, cookies and form recovery remain.",
          "Clear history"
        );
        if (!confirmed) return;
        this.plugin.clearBrowserHistory();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Clear detailed tab recovery").setDesc("Keeps browsing history, but removes extra state used to restore recently closed tabs more accurately. Open tabs start collecting detailed recovery again after they are reopened.").addButton(
      (button) => button.setButtonText("Clear recovery data").setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          "Clear detailed tab recovery",
          "Old tabs will still reopen from durable URLs, but high-fidelity closed-tab restoration will be lost.",
          "Clear recovery data"
        );
        if (!confirmed) return;
        this.plugin.clearRichRestoreData();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Clear form recovery data").setDesc("Deletes all saved non-credential form values without changing which sites have form recovery enabled.").addButton(
      (button) => button.setButtonText("Clear form data").setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          "Clear form recovery data",
          "Delete all saved Browser Core form recovery data?",
          "Clear form data"
        );
        if (!confirmed) return;
        this.plugin.clearFormRecoveryData();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Reset site permissions").setDesc("Returns saved site permissions to Ask next time. Container cookies and site storage are not changed.").addButton(
      (button) => button.setButtonText("Reset permissions").setWarning().onClick(async () => {
        const confirmed = await confirmAction(
          this.app,
          "Reset site permissions",
          "Reset all saved site permissions to Ask next time?",
          "Reset permissions"
        );
        if (!confirmed) return;
        this.plugin.clearPermissionDecisions();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Appearance").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Reduced motion").setDesc("Avoid large transitions, slides and parallax in Browser Core UI.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().reducedMotion).onChange((value) => {
        this.plugin.core.updateSettings({ reducedMotion: value });
        this.plugin.applyAccessibilityClasses();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Default web content zoom").setDesc("Used by sites without a site-specific zoom override.").addSlider(
      (slider) => slider.setLimits(50, 200, 10).setDynamicTooltip().setValue(Math.round(this.plugin.core.settings().defaultZoomFactor * 100)).onChange((value) => {
        this.plugin.core.updateSettings({ defaultZoomFactor: value / 100 });
        this.plugin.refreshBrowserZoom();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Favorites bar").setDesc("Show only bookmarks marked as favorites beneath the browser toolbar.").addToggle(
      (toggle) => toggle.setValue(this.plugin.core.settings().showFavoritesBar).onChange((value) => {
        this.plugin.core.updateSettings({ showFavoritesBar: value });
        this.plugin.refreshBrowserViews();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Containers").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Container use").setDesc("Off uses the default browser session only. Manual keeps containers available without automatic site routing. Automatic also applies site default rules.").addDropdown(
      (dropdown) => dropdown.addOption("off", "Off").addOption("manual", "Manual").addOption("automatic", "Automatic").setValue(this.plugin.core.settings().containerMode).onChange((value) => {
        this.plugin.core.updateSettings({ containerMode: value });
        this.plugin.refreshContainerPresentation();
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Default container").setDesc("Used for new browser tabs when containers are enabled. Automatic mode may replace it with a site's default container.").addDropdown((dropdown) => {
      for (const container of this.plugin.core.containers.list()) {
        dropdown.addOption(container.id, container.name);
      }
      dropdown.setValue(this.plugin.core.settings().defaultContainerId).setDisabled(this.plugin.core.settings().containerMode === "off").onChange((value) => this.plugin.core.updateSettings({ defaultContainerId: value }));
    });
    for (const container of this.plugin.core.containers.list()) {
      const row = new import_obsidian3.Setting(containerEl).setName(container.name).setDesc("Separate persistent login and site data").addText(
        (text) => text.setPlaceholder("Container name").setValue(container.name).onChange((value) => {
          const next = value.trim();
          if (!next) return;
          container.name = next;
          this.plugin.core.scheduleSave();
          this.plugin.refreshContainerPresentation();
        })
      ).addDropdown(
        (dropdown) => dropdown.addOption("box", "Box").addOption("user-round", "Personal").addOption("briefcase", "Work").addOption("search", "Search").addOption("graduation-cap", "Study").addOption("building-2", "Organization").addOption("shield", "Protected").addOption("heart", "Favorite").setValue(container.icon || "box").onChange((value) => {
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
        button.setIcon("eraser").setTooltip("Clear browsing data and saved permissions");
        button.onClick(async () => {
          const confirmed = await confirmAction(
            this.app,
            "Clear " + container.name + " browsing data",
            "Clear this container's cookies, site storage, cache, sign-in cache, and saved site permissions? Open pages may need to be reloaded.",
            "Clear browsing data"
          );
          if (!confirmed) return;
          const cleared = await this.plugin.clearContainerSession(container.id);
          if (!cleared) return;
          this.display();
        });
      }).addExtraButton((button) => {
        button.setIcon("trash").setTooltip("Delete container");
        button.setDisabled(container.id === "default");
        button.onClick(async () => {
          const confirmed = await confirmAction(
            this.app,
            "Delete container",
            `Delete \u201C${container.name}\u201D? Its cookies, site storage, cache, saved permissions, form recovery data, and site default rules will be cleared. Browsing history will remain.`,
            "Delete container"
          );
          if (!confirmed) return;
          if (await this.plugin.deleteContainer(container.id)) this.display();
        });
      });
      row.settingEl.dataset.containerId = container.id;
    }
    new import_obsidian3.Setting(containerEl).setName("Add container").setDesc("Creates a separate persistent login and site data.").addButton(
      (button) => button.setButtonText("Add").onClick(() => {
        this.plugin.core.containers.create("Container");
        this.plugin.core.scheduleSave();
        this.display();
      })
    );
    const assignments = this.plugin.core.containers.assignments();
    if (assignments.length) {
      new import_obsidian3.Setting(containerEl).setName("Site default containers").setDesc(this.plugin.core.settings().containerMode === "automatic" ? "Applied automatically when an independent navigation opens a matching site." : "Saved for later, but currently paused because automatic container routing is off.").setHeading();
      for (const rule of assignments) {
        new import_obsidian3.Setting(containerEl).setName(rule.originPattern).setDesc(this.plugin.core.containers.nameFor(rule.containerId)).addExtraButton(
          (button) => button.setIcon("x").setTooltip("Forget site default container").onClick(() => {
            this.plugin.core.containers.unassignOrigin(rule.originPattern);
            this.plugin.core.scheduleSave();
            this.display();
          })
        );
      }
    }
    const permissions = this.plugin.core.permissions.list();
    if (permissions.length) {
      new import_obsidian3.Setting(containerEl).setName("Site permissions").setHeading();
      for (const record of permissions) {
        new import_obsidian3.Setting(containerEl).setName(permissionLabel(record.permission)).setDesc(`${record.origin} \xB7 ${this.plugin.core.containers.nameFor(record.containerId)} \xB7 ${permissionDecisionLabel(record.decision)}`).addDropdown(
          (dropdown) => dropdown.addOption("ask", "Ask next time").addOption("allow", "Allow").addOption("block", "Block").setValue(record.decision).onChange((value) => {
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

// src/ui/browser-view.ts
var import_obsidian12 = require("obsidian");

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
    this.contentEl.createEl("h2", { text: this.heading });
    const titleField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    titleField.createSpan({ cls: "ubc-prompt-label", text: "Title" });
    const title = titleField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", placeholder: "Title", "aria-label": "Bookmark title" }
    });
    title.value = this.initialTitle;
    const urlField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    urlField.createSpan({ cls: "ubc-prompt-label", text: "URL" });
    const url = urlField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "url", placeholder: "https://\u2026", "aria-label": "Bookmark URL" }
    });
    url.value = this.initialUrl;
    const favoriteField = this.contentEl.createEl("label", { cls: "ubc-prompt-check" });
    const favorite = favoriteField.createEl("input", { attr: { type: "checkbox" } });
    favorite.checked = Boolean(this.options.favorite);
    favoriteField.createSpan({ text: "Show in favorites bar" });
    const appearanceField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    appearanceField.createSpan({ cls: "ubc-prompt-label", text: "Bookmark image" });
    const visualKind = appearanceField.createEl("select", { attr: { "aria-label": "Bookmark image type" } });
    visualKind.createEl("option", { text: "Website favicon", value: "favicon" });
    visualKind.createEl("option", { text: "Custom image", value: "image" });
    visualKind.createEl("option", { text: "Custom text", value: "text" });
    visualKind.createEl("option", { text: "Lucide icon", value: "icon" });
    visualKind.value = this.options.visualKind ?? "favicon";
    const visualValueField = this.contentEl.createEl("label", { cls: "ubc-prompt-field" });
    visualValueField.createSpan({ cls: "ubc-prompt-label", text: "Custom value" });
    const visualValue = visualValueField.createEl("input", {
      cls: "ubc-prompt-input",
      attr: { type: "text", "aria-label": "Custom bookmark image or text" }
    });
    visualValue.value = this.options.visualValue ?? "";
    const previewField = this.contentEl.createDiv({ cls: "ubc-bookmark-editor-preview-row" });
    previewField.createSpan({ cls: "ubc-prompt-label", text: "Preview" });
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
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(void 0));
    const save = actions.createEl("button", { text: "Save" });
    const submit = () => {
      const nextUrl = url.value.trim();
      if (!nextUrl) return;
      const kind = visualKind.value;
      this.finish({
        title: title.value.trim() || nextUrl,
        url: nextUrl,
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
    this.setPlaceholder("Choose bookmark folder");
  }
  chosen = false;
  getItems() {
    const choices = [{ id: null, label: "Bookmarks root" }];
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
    if (!this.chosen) this.resolveChoice(void 0);
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
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(void 0));
    const save = actions.createEl("button", { text: "Save" });
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
  const add = (title, action, options = {}) => entries.push({ kind: "item", title, action, ...options });
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
        add("Open link in " + container.name, () => void plugin.openBrowser({ url: link, containerId: container.id }), { icon: "box" });
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
    add("Search \u201C" + shown + "\u201D", () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
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
      add("Search \u201C" + shown + "\u201D", () => void plugin.openBrowser({ url: plugin.core.searchUrl(selection) }), { icon: "search" });
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
    add(currentPageBookmarked ? "Remove bookmark" : "Bookmark this page", () => view.bookmarkCurrentPage(), {
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

// src/ui/context-menus.ts
function showPageMenu(plugin, view, event) {
  const menu = new import_obsidian9.Menu();
  menu.addItem(
    (item) => item.setTitle("Back").setIcon("arrow-left").setDisabled(!view.canGoBack()).onClick(() => view.goBack())
  );
  menu.addItem(
    (item) => item.setTitle("Forward").setIcon("arrow-right").setDisabled(!view.canGoForward()).onClick(() => view.goForward())
  );
  menu.addItem((item) => item.setTitle("Reload").setIcon("rotate-cw").onClick(() => view.reload()));
  menu.addItem((item) => item.setTitle("Stop loading").setIcon("square").onClick(() => view.stopLoading()));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Open home").setIcon("home").onClick(() => view.showInternal("home")));
  menu.addItem((item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => plugin.openBrowserTabSearch()));
  menu.addItem((item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => plugin.openQuickSwitcher()));
  menu.addItem(
    (item) => item.setTitle(view.currentPageBookmarked() ? "Remove bookmark" : "Bookmark this page").setIcon(view.currentPageBookmarked() ? "bookmark-check" : "bookmark").onClick(() => view.bookmarkCurrentPage())
  );
  menu.addItem((item) => item.setTitle("Copy page URL").setIcon("copy").onClick(async () => {
    await navigator.clipboard.writeText(view.currentUrl());
    new import_obsidian9.Notice("URL copied.");
  }));
  menu.addItem(
    (item) => item.setTitle("View page in history").setIcon("history").onClick(() => view.showHistoryQuery(view.currentUrl()))
  );
  if (view.hasRecoverableFormValues()) {
    menu.addItem(
      (item) => item.setTitle("Restore saved form values").setIcon("form-input").onClick(() => view.restoreFormValues())
    );
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Zoom in").setIcon("zoom-in").onClick(() => view.zoomIn()));
  menu.addItem((item) => item.setTitle("Zoom out").setIcon("zoom-out").onClick(() => view.zoomOut()));
  menu.addItem((item) => item.setTitle("Reset site zoom").onClick(() => view.resetZoom()));
  menu.addItem((item) => item.setTitle("Inspect page").setIcon("code").onClick(() => view.inspectPage()));
  if (plugin.core.settings().containerMode !== "off") {
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Container\u2026").setIcon("boxes").onClick(() => view.openContainerPicker())
    );
  }
  menu.showAtMouseEvent(event);
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
  menu.showAtPosition(position);
}
function showBookmarkMenu(plugin, view, bookmark, event) {
  const menu = new import_obsidian9.Menu();
  menu.addItem((item) => item.setTitle("Open").setIcon("external-link").onClick(() => view.navigate(resolveBookmarkUrl(bookmark.url, plugin.app))));
  menu.addItem((item) => item.setTitle("Open in new tab").setIcon("plus").onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app) })));
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle(`Open in ${container.name}`).setIcon("box").onClick(() => plugin.openBrowser({ url: resolveBookmarkUrl(bookmark.url, plugin.app), containerId: container.id }))
      );
    }
  }
  menu.addItem((item) => item.setTitle("Copy URL").setIcon("copy").onClick(() => navigator.clipboard.writeText(bookmark.url)));
  menu.addSeparator();
  menu.addItem(
    (item) => item.setTitle(bookmark.favorite ? "Remove from favorites" : "Add to favorites").setIcon(bookmark.favorite ? "star-off" : "star").onClick(() => {
      plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })
  );
  menu.addItem((item) => item.setTitle("Edit").setIcon("pencil").onClick(async () => {
    const draft = await editBookmark(plugin.app, bookmark.title, bookmark.url, "Edit bookmark", {
      favorite: bookmark.favorite,
      visualKind: bookmark.visualKind,
      visualValue: bookmark.visualValue
    });
    if (!draft) return;
    if (!plugin.core.bookmarks.updateBookmark(bookmark.id, draft)) return;
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Move to folder").setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks);
    if (parentId === void 0) return;
    plugin.core.bookmarks.moveBookmark(bookmark.id, parentId);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Show in history").setIcon("history").onClick(() => view.showHistoryQuery(bookmark.url)));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Delete").setIcon("trash").onClick(() => {
    void (async () => {
      const confirmed = await confirmAction(
        plugin.app,
        "Delete bookmark",
        `Delete \u201C${bookmark.title || bookmark.url}\u201D from your bookmarks?`,
        "Delete bookmark"
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteBookmark(bookmark.id);
      plugin.core.scheduleSave();
      view.renderFavoritesBar();
      if (view.currentInternalSurface() === "bookmarks") view.showInternal("bookmarks");
    })();
  }));
  menu.showAtMouseEvent(event);
}
function showBookmarkFolderMenu(plugin, view, folder, event) {
  const menu = new import_obsidian9.Menu();
  const bookmarks = plugin.core.bookmarks.descendantBookmarks(folder.id);
  menu.addItem(
    (item) => item.setTitle("Open all").setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks, void 0, true))
  );
  menu.addItem(
    (item) => item.setTitle("Open all in new tabs").setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks))
  );
  if (plugin.core.settings().containerMode !== "off") {
    for (const container of plugin.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle("Open all in " + container.name).setIcon("box").setDisabled(bookmarks.length === 0).onClick(() => view.openBookmarkSet(bookmarks, container.id))
      );
    }
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("New bookmark").setIcon("bookmark-plus").onClick(async () => {
    const draft = await editBookmark(plugin.app, "", "", "New bookmark");
    if (!draft) return;
    plugin.core.bookmarks.addBookmark({ ...draft, parentId: folder.id });
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("New folder").setIcon("folder-plus").onClick(async () => {
    const title = await promptText(plugin.app, "New bookmark folder", "", "Folder name");
    if (title === void 0) return;
    plugin.core.bookmarks.addFolder(title, folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(async () => {
    const title = await promptText(plugin.app, "Rename bookmark folder", folder.title, "Folder name");
    if (title === void 0) return;
    plugin.core.bookmarks.renameFolder(folder.id, title);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Move").setIcon("folder-input").onClick(async () => {
    const parentId = await pickBookmarkFolder(plugin.app, plugin.core.bookmarks, { excludeFolderId: folder.id });
    if (parentId === void 0) return;
    if (!plugin.core.bookmarks.moveFolder(folder.id, parentId)) {
      new import_obsidian9.Notice("That move would create an invalid bookmark-folder cycle.");
      return;
    }
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Sort contents").setIcon("arrow-down-a-z").onClick(() => {
    plugin.core.bookmarks.sortChildren(folder.id);
    plugin.core.scheduleSave();
    view.refreshBookmarks();
  }));
  menu.addItem((item) => item.setTitle("Delete folder").setIcon("trash").onClick(() => {
    void (async () => {
      const descendants = plugin.core.bookmarks.descendantBookmarks(folder.id);
      const confirmed = await confirmAction(
        plugin.app,
        "Delete bookmark folder",
        descendants.length ? `Delete \u201C${folder.title}\u201D and its ${descendants.length} bookmark${descendants.length === 1 ? "" : "s"}?` : `Delete the empty folder \u201C${folder.title}\u201D?`,
        "Delete folder"
      );
      if (!confirmed) return;
      plugin.core.bookmarks.deleteFolder(folder.id);
      plugin.core.scheduleSave();
      view.refreshBookmarks();
    })();
  }));
  menu.showAtMouseEvent(event);
}
function showFavoritesBarMenu(plugin, view, event) {
  const menu = new import_obsidian9.Menu();
  if (!view.currentUrl().startsWith("browser://")) {
    menu.addItem((item) => item.setTitle("Add current page to favorites").setIcon("star").onClick(() => view.favoriteCurrentPage()));
  }
  menu.addItem((item) => item.setTitle("Open bookmarks").setIcon("book-open").onClick(() => view.showInternal("bookmarks")));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("Hide favorites bar").onClick(() => {
    plugin.core.updateSettings({ showFavoritesBar: false });
    plugin.refreshBrowserViews();
  }));
  menu.showAtMouseEvent(event);
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
    this.contentEl.createEl("h2", { text: "Recovery details" });
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
      text: "Browser Core does not save a full live copy of the page. Some page state can only be restored by the browser engine, while saved form values and the website's own drafts are recovered separately."
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-modal-actions" });
    actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
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
    this.contentEl.createEl("h2", { text: "Saved form values" });
    this.contentEl.createEl("p", {
      text: "These values were saved for this page. Browser Core restores only fields it can match confidently; ambiguous fields remain unchanged."
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
    const close = actions.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
    const restore = actions.createEl("button", { text: "Restore matching fields", cls: "mod-cta" });
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
    text: "Text field",
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

// src/ui/browser-view.ts
var BROWSER_VIEW_TYPE = "unified-browser-core-view";
var BrowserView = class _BrowserView extends import_obsidian12.ItemView {
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
  permissionButtonEl;
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
        this.transientHistory.length === 0
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
    webview.setZoomFactor?.(this.plugin.core.zoom.factorForUrl(this.currentUrlValue));
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
      new import_obsidian12.Notice("There are no web pages to bookmark.");
      return;
    }
    const newViews = webViews.filter((view) => !this.plugin.core.bookmarks.isBookmarked(view.currentUrl()));
    if (!newViews.length) {
      new import_obsidian12.Notice("All open web pages are already bookmarked.");
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
    new import_obsidian12.Notice("Bookmarked " + newViews.length + " open browser tab(s)." + (newViews.length < webViews.length ? " Existing bookmarks were skipped." : ""));
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
  refreshPermissionIndicator() {
    this.updatePermissionIndicator();
  }
  refreshContainerPresentation() {
    this.updateContainerIndicator();
    this.applyTabStyle();
  }
  enableFormRecoveryForSite() {
    if (!this.plugin.core.formRecovery.enableSite(this.containerId, this.currentUrlValue)) {
      new import_obsidian12.Notice("Form recovery is only available for web pages.");
      return;
    }
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new import_obsidian12.Notice("Form recovery enabled for this site.");
  }
  showRecoveryCandidates() {
    const fields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    if (!fields.length) {
      new import_obsidian12.Notice("No saved form values are available for this page.");
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
      new import_obsidian12.Notice("Form recovery is only available for web pages.");
      return;
    }
    this.formRecoveryWatchEnabled = false;
    this.plugin.core.scheduleSave();
    void this.syncFormRecoveryInstrumentation();
    new import_obsidian12.Notice("Form recovery disabled and stored form values cleared for this site.");
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
      new import_obsidian12.Notice("Could not identify the focused form field.");
      return;
    }
    this.plugin.core.scheduleSave();
    new import_obsidian12.Notice("This form field is excluded from recovery on this site.");
  }
  async restoreFocusedFormValue() {
    const saved = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!saved.length || !webview?.executeJavaScript) {
      new import_obsidian12.Notice("No saved form value is available for this page.");
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
    new import_obsidian12.Notice(restored ? "Restored the previous value for this field." : "No matching saved value was found for this field.");
  }
  async restoreFormValues(options = {}) {
    const recoveryFields = this.plugin.core.formRecovery.recoveryFieldsForDocument(this.containerId, this.currentUrlValue);
    const webview = this.readyWebview();
    if (!recoveryFields.length || !webview?.executeJavaScript) {
      if (!options.silent) new import_obsidian12.Notice("No saved form values for this page.");
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
      new import_obsidian12.Notice(
        restored > 0 ? `Restored ${restored} form field(s).${watchNextSteps ? " Matching fields in later form steps will also be restored when they appear." : ""}` : "No matching fields were found for the saved form values."
      );
    }
  }
  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Reload").setIcon("rotate-cw").onClick(() => this.reload())
    );
    const pinned = this.pinned;
    menu.addItem(
      (item) => item.setTitle(pinned ? "Unpin browser tab" : "Pin browser tab").setIcon("pin").onClick(() => {
        this.leaf.setPinned(!pinned);
        this.plugin.core.history.touchLeaf(this.leafId(), { pinned: !pinned });
        this.plugin.core.scheduleSave();
      })
    );
    menu.addItem(
      (item) => item.setTitle(this.manualRetention === "preserve" ? "Use normal recovery retention" : "Keep recovery data").setIcon("archive-restore").onClick(() => {
        this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
        this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
        this.plugin.core.scheduleSave();
        this.plugin.scheduleSessionCheckpoint();
      })
    );
    menu.addItem(
      (item) => item.setTitle("Duplicate browser tab").setIcon("copy").onClick(() => this.plugin.openBrowser({ url: this.currentUrlValue, containerId: this.containerId }))
    );
    menu.addItem(
      (item) => item.setTitle("Move browser tab to new window").setIcon("picture-in-picture").onClick(() => {
        try {
          this.plugin.app.workspace.moveLeafToPopout(this.leaf);
        } catch {
          new import_obsidian12.Notice("This Obsidian build cannot move the tab to a new window.");
        }
      })
    );
    for (const container of this.plugin.core.containers.list()) {
      if (container.id === this.containerId) continue;
      menu.addItem(
        (item) => item.setTitle(`Reopen in ${container.name}`).setIcon("box").onClick(() => this.reopenInContainer(container.id))
      );
    }
    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem(
        (item) => item.setTitle("Bookmark current page").setIcon("bookmark").onClick(() => this.bookmarkCurrentPage())
      );
      menu.addItem(
        (item) => item.setTitle("Copy page URL").setIcon("copy").onClick(() => void navigator.clipboard.writeText(this.currentUrlValue))
      );
    }
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => this.plugin.openBrowserTabSearch())
    );
    menu.addItem(
      (item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => this.plugin.openQuickSwitcher())
    );
    menu.addSeparator();
    const siblings = this.plugin.tabStripAdapter.leavesInSameGroup(this.leaf).filter((leaf) => leaf.view instanceof _BrowserView);
    const selfIndex = siblings.indexOf(this.leaf);
    menu.addItem(
      (item) => item.setTitle("Close browser tabs to the left").setIcon("panel-left-close").setDisabled(selfIndex <= 0).onClick(() => {
        for (const leaf of siblings.slice(0, selfIndex)) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle("Close browser tabs to the right").setIcon("panel-right-close").setDisabled(selfIndex < 0 || selfIndex >= siblings.length - 1).onClick(() => {
        for (const leaf of siblings.slice(selfIndex + 1)) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle("Close other browser tabs").setIcon("x").onClick(() => {
        for (const leaf of siblings) if (leaf !== this.leaf) leaf.detach();
      })
    );
    menu.addItem(
      (item) => item.setTitle("Close unpinned browser tabs").setIcon("x-circle").onClick(() => {
        for (const leaf of siblings) {
          if (leaf.view instanceof _BrowserView && !leaf.view.getState().pinned) leaf.detach();
        }
      })
    );
    menu.addItem(
      (item) => item.setTitle("Close browser tab").setIcon("x").onClick(() => this.leaf.detach())
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
    this.backButtonEl = this.addToolbarButton("arrow-left", "Back", () => this.goBack());
    this.backButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(-1, event);
    });
    this.forwardButtonEl = this.addToolbarButton("arrow-right", "Forward", () => this.goForward());
    this.forwardButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showNavigationHistoryMenu(1, event);
    });
    this.reloadButtonEl = this.addToolbarButton("rotate-cw", "Reload", () => {
      if (this.rootEl.hasClass("is-loading")) this.stopLoading();
      else this.reload();
    });
    this.reloadButtonEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new import_obsidian12.Menu();
      menu.addItem((item) => item.setTitle("Reload").setIcon("rotate-cw").onClick(() => this.reload()));
      menu.addItem((item) => item.setTitle("Hard reload").onClick(() => this.hardReload()));
      menu.addItem((item) => item.setTitle("Stop loading").onClick(() => this.stopLoading()));
      menu.showAtMouseEvent(event);
    });
    this.addressEl = this.toolbarEl.createEl("input", {
      cls: "ubc-address",
      attr: { type: "text", spellcheck: "false", "aria-label": "Address and search" }
    });
    this.addressEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
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
      text: "Ready",
      attr: { "aria-live": "polite", "aria-atomic": "true", title: "Navigation status" }
    });
    this.bookmarkButtonEl = this.addToolbarButton("bookmark", "Bookmark page", () => this.bookmarkCurrentPage());
    this.containerButtonEl = this.addToolbarButton("box", "Container", (event) => this.showContainerMenu(event));
    this.containerButtonEl.addClass("ubc-container-button");
    this.updateContainerIndicator();
    this.permissionButtonEl = this.addToolbarButton("shield-check", "Site permissions", (event) => this.showPermissionMenu(event));
    this.permissionButtonEl.addClass("ubc-permission-button");
    this.updatePermissionIndicator();
    this.addToolbarButton("ellipsis", "Browser menu", (event) => this.showToolbarMoreMenu(event));
    this.favoritesBarEl = this.rootEl.createDiv({ cls: "ubc-favorites-bar" });
    this.favoritesBarEl.addEventListener("contextmenu", (event) => {
      if (event.target !== this.favoritesBarEl) return;
      event.preventDefault();
      showFavoritesBarMenu(this.plugin, this, event);
    });
    this.recoveryBannerEl = this.rootEl.createDiv({ cls: "ubc-recovery-banner is-hidden", attr: { role: "status" } });
    this.browserContentEl = this.rootEl.createDiv({ cls: "ubc-content" });
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
    (0, import_obsidian12.setIcon)(button, icon);
    button.addEventListener("click", callback);
    return button;
  }
  applyZoom(factor) {
    this.readyWebview()?.setZoomFactor?.(factor);
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
    if (this.statusEl) {
      this.statusEl.textContent = label;
      this.statusEl.dataset.status = status;
      this.statusEl.title = label;
    }
    if (this.reloadButtonEl) {
      const loading = status === "waiting" || status === "loading";
      (0, import_obsidian12.setIcon)(this.reloadButtonEl, loading ? "x" : "rotate-cw");
      const actionLabel = loading ? "Stop loading" : "Reload";
      this.reloadButtonEl.setAttribute("aria-label", actionLabel);
      this.reloadButtonEl.title = actionLabel;
    }
  }
  showToolbarMoreMenu(event) {
    const menu = new import_obsidian12.Menu();
    menu.addItem((item) => item.setTitle("Home").setIcon("home").onClick(() => this.showInternal("home")));
    menu.addItem((item) => item.setTitle("History").setIcon("history").onClick(() => this.showInternal("history")));
    menu.addItem((item) => item.setTitle("Bookmarks").setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
    menu.addItem((item) => item.setTitle("Search tabs").setIcon("search").onClick(() => this.plugin.openBrowserTabSearch()));
    const closed = this.plugin.core.history.recentlyClosed(1)[0];
    menu.addItem(
      (item) => item.setTitle("Reopen closed tab").setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.plugin.restoreLeaf(closed.id);
      })
    );
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Site permissions\u2026").setIcon("shield-check").onClick(() => this.showPermissionMenu(event))
    );
    menu.addItem((item) => item.setTitle("Zoom in").setIcon("zoom-in").onClick(() => this.zoomIn()));
    menu.addItem((item) => item.setTitle("Zoom out").setIcon("zoom-out").onClick(() => this.zoomOut()));
    menu.addItem((item) => item.setTitle("Reset site zoom").onClick(() => this.resetZoom()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Settings").setIcon("settings").onClick(() => this.plugin.openSettings()));
    menu.addItem((item) => item.setTitle("Inspect page").setIcon("code").onClick(() => this.inspectPage()));
    menu.showAtMouseEvent(event);
  }
  renderFavoritesBar() {
    if (!this.favoritesBarEl) return;
    this.updateBookmarkButton();
    this.favoritesBarEl.empty();
    const visible = this.plugin.core.settings().showFavoritesBar;
    const favorites = this.plugin.core.bookmarks.favorites();
    this.favoritesBarEl.toggleClass("is-hidden", !visible || favorites.length === 0);
    if (!visible || !favorites.length) return;
    for (const item of favorites) {
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
  showInternal(surface = "home", recordTransient = true) {
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
    this.updatePermissionIndicator();
    this.webLayerEl.addClass("is-hidden");
    this.hideLoadingShield();
    this.internalLayerEl.removeClass("is-hidden");
    this.internalLayerEl.empty();
    if (resolvedSurface === "history") this.renderHistory();
    else if (resolvedSurface === "bookmarks") this.renderBookmarks();
    else this.renderHome();
    this.currentTitle = resolvedSurface === "history" ? "History" : resolvedSurface === "bookmarks" ? "Bookmarks" : "Home";
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
    this.rootEl.removeClass("is-loading");
    this.hideLoadingShield();
    this.setNavigationStatus("stopped");
  }
  bookmarkCurrentPage() {
    if (!this.currentUrlValue || this.currentUrlValue.startsWith("browser://")) return;
    const result = this.plugin.core.bookmarks.toggleBookmark({
      title: this.currentTitle || this.currentUrlValue,
      url: this.currentUrlValue,
      faviconUrl: this.faviconSourceUrl ?? fallbackFaviconUrl(this.currentUrlValue)
    });
    this.plugin.core.scheduleSave();
    this.refreshBookmarks();
    new import_obsidian12.Notice(result.bookmarked ? "Bookmarked." : "Bookmark removed.");
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
    new import_obsidian12.Notice("Added to favorites.");
  }
  updateBookmarkButton() {
    if (!this.bookmarkButtonEl) return;
    const bookmark = !this.currentUrlValue.startsWith("browser://") ? this.plugin.core.bookmarks.findByUrl(this.currentUrlValue) : void 0;
    (0, import_obsidian12.setIcon)(this.bookmarkButtonEl, bookmark ? "bookmark-check" : "bookmark");
    const label = bookmark ? "Remove bookmark" : "Bookmark page";
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
        this.plugin.core.containers.get(this.containerId).partition
      );
      this.webview = webview2;
      this.webviewDomReady = false;
      this.bindWebview(webview2);
      this.webLayerEl.appendChild(webview2);
      if (!this.richRestoreAttempted && this.restoredFromLeafId) {
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
      this.updatePermissionIndicator();
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
      this.rootEl.addClass("is-loading");
      this.showLoadingShield();
      this.setNavigationStatus("loading");
    });
    webview.addEventListener("did-stop-loading", () => {
      if (this.ignoreBootstrapAboutBlank && this.safeWebviewUrl(webview) === "about:blank") return;
      this.rootEl.removeClass("is-loading");
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
  async initializeAttachedWebview(webview) {
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
    if (!this.popupDisposer) {
      this.popupDisposer = this.plugin.windowOpenAdapter.bind(webview, (url, disposition) => {
        void this.plugin.openFromOpener(url, this.containerId, disposition);
      });
    }
    if (finalAttempt && !this.popupDisposer) {
      webview.removeAttribute("allowpopups");
    }
    this.plugin.bindPermissions(webview, this.containerId);
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
    this.updatePermissionIndicator();
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
    webview.setZoomFactor?.(this.plugin.core.zoom.factorForUrl(this.currentUrlValue));
    if (!this.faviconDataUrl) void this.captureFavicon(webview, []);
    if (this.formRecoveryEnabledForSite()) {
      await this.installFormRecoveryInstrumentation(webview);
    }
    if (this.hasRecoverableFormValues()) {
      if (this.formRecoveryWatchEnabled) {
        await this.restoreFormValues({ silent: true, watchNextSteps: true });
      } else {
        new import_obsidian12.Notice("Saved form values are available for this page.");
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
    this.recoveryBannerEl.empty();
    this.recoveryBannerEl.removeClass("is-hidden", "is-success", "is-warning");
    this.recoveryBannerEl.addClass(tone === "success" ? "is-success" : "is-warning");
    this.recoveryBannerEl.createSpan({ cls: "ubc-recovery-message", text: message });
    const actions = this.recoveryBannerEl.createDiv({ cls: "ubc-recovery-actions" });
    if (tone === "warning") {
      actions.createEl("button", { text: "Retry restore" }).addEventListener("click", () => void this.retryRichRestore());
      actions.createEl("button", { text: "Reload normally" }).addEventListener("click", () => {
        this.hideRecoveryBanner();
        const webview = this.webview;
        if (!webview) return;
        if (this.readyWebview() && webview.loadURL) void webview.loadURL(this.currentUrlValue);
        else webview.src = this.currentUrlValue;
      });
      if (this.hasRecoverableFormValues()) {
        actions.createEl("button", { text: "Restore form values" }).addEventListener("click", () => void this.restoreFormValues());
      }
    }
    actions.createEl("button", { text: "Recovery details" }).addEventListener("click", () => this.openRecoveryDetails());
    const retention = actions.createEl("button", {
      text: this.manualRetention === "preserve" ? "Use normal recovery retention" : "Keep recovery data"
    });
    retention.addEventListener("click", () => {
      this.manualRetention = this.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.history.touchLeaf(this.leafId(), { manualRetention: this.manualRetention });
      this.plugin.core.scheduleSave();
      this.plugin.scheduleSessionCheckpoint();
      const preserving = this.manualRetention === "preserve";
      retention.setText(preserving ? "Use normal recovery retention" : "Keep recovery data");
      new import_obsidian12.Notice(
        preserving ? "Detailed recovery data for this tab will be kept until you remove it." : "Detailed recovery data for this tab will use normal retention again."
      );
    });
    actions.createEl("button", { text: "Dismiss", attr: { "aria-label": "Dismiss recovery message" } }).addEventListener("click", () => this.hideRecoveryBanner());
  }
  hideRecoveryBanner() {
    this.recoveryBannerEl?.addClass("is-hidden");
  }
  async retryRichRestore() {
    const webview = this.readyWebview();
    if (!webview || !this.restoredFromLeafId) return;
    const capsule = this.plugin.core.restore.get(this.restoredFromLeafId);
    if (!capsule || !await this.navigationHistoryAdapter.restore(webview, capsule)) {
      new import_obsidian12.Notice("Detailed tab recovery is not currently available; the page can still be reopened normally.");
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
    if (this.checkpointTimer !== void 0) {
      window.clearInterval(this.checkpointTimer);
      this.checkpointTimer = void 0;
    }
    if (!this.webview) return;
    this.webviewDomReady = false;
    this.popupDisposer?.();
    this.popupDisposer = void 0;
    this.contextMenuDisposer?.();
    this.contextMenuDisposer = void 0;
    this.plugin.managedWebviewBackend.destroy(this.webview);
    this.webview = null;
    this.hideLoadingShield();
  }
  showLoadingShield() {
    if (this.webviewDomReady) return;
    this.loadingShieldEl?.removeClass("is-hidden");
  }
  hideLoadingShield() {
    this.loadingShieldEl?.addClass("is-hidden");
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
      const menu = new import_obsidian12.Menu();
      menu.addItem((item) => item.setTitle("New browser tab").setIcon("plus").onClick(() => void this.plugin.openBrowser()));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem((item) => item.setTitle("New tab in " + container.name).setIcon("box").onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: container.id })));
      }
      const closed = this.plugin.core.history.recentlyClosed(1)[0];
      menu.addItem((item) => item.setTitle("Reopen closed tab").setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.plugin.restoreLeaf(closed.id);
      }));
      menu.addItem(
        (item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => this.plugin.openBrowserTabSearch())
      );
      menu.addItem(
        (item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => this.plugin.openQuickSwitcher())
      );
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Show history").setIcon("history").onClick(() => this.showInternal("history")));
      menu.addItem((item) => item.setTitle("Show bookmarks").setIcon("book-open").onClick(() => this.showInternal("bookmarks")));
      menu.showAtMouseEvent(event);
    });
    page.createEl("h1", { text: "Home" });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: "Search your vault, browse the web, or continue where you left off."
    });
    const searchMode = { value: this.plugin.core.settings().homeSearchMode };
    const modePicker = page.createDiv({ cls: "ubc-home-search-modes", attr: { role: "group", "aria-label": "Home search mode" } });
    const vaultMode = modePicker.createEl("button", { text: "Vault", attr: { type: "button" } });
    const webMode = modePicker.createEl("button", { text: "Web", attr: { type: "button" } });
    const search = page.createEl("input", {
      cls: "ubc-home-search",
      attr: { "aria-label": "Home search" }
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
        text: currentVaultResults.length ? String(currentVaultResults.length) + " vault result" + (currentVaultResults.length === 1 ? "" : "s") : "No vault files found"
      });
      if (!currentVaultResults.length) {
        heading.createSpan({ text: "Try another name or switch to Web.", cls: "ubc-card-subtitle" });
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
      search.placeholder = mode === "vault" ? "Search files in your vault" : "Search the web or enter an address";
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
        homeSections.createEl("h2", { text: "Bookmarked files" });
        this.renderVaultFileCards(homeSections, bookmarked);
      }
    }
    if (this.plugin.core.settings().showRecentVaultFilesOnHome) {
      const files = this.plugin.homeAdapter.recentFiles(8);
      if (files.length) {
        homeSections.createEl("h2", { text: "Recent files" });
        this.renderVaultFileCards(homeSections, files);
      }
    }
    const webBookmarks = this.plugin.core.bookmarks.allBookmarks().slice(0, 8);
    if (webBookmarks.length) {
      homeSections.createEl("h2", { text: "Web bookmarks" });
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
      homeSections.createEl("h2", { text: "Recently closed browser tabs" });
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
          const menu = new import_obsidian12.Menu();
          menu.addItem((item) => item.setTitle("Restore").setIcon("rotate-ccw").onClick(() => this.plugin.restoreLeaf(leaf.id)));
          for (const container of this.plugin.core.containers.list()) {
            menu.addItem(
              (item) => item.setTitle("Restore in " + container.name).setIcon("box").onClick(() => this.plugin.restoreLeaf(leaf.id, { containerId: container.id }))
            );
          }
          if (leaf.lastUrl && !leaf.lastUrl.startsWith("browser://")) {
            menu.addItem((item) => item.setTitle("Open history").setIcon("history").onClick(() => this.showHistoryQuery(leaf.lastUrl || "")));
          }
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("Remove from history").setIcon("trash").onClick(() => {
            void (async () => {
              const confirmed = await confirmAction(
                this.plugin.app,
                "Remove closed tab from history",
                "Remove this closed tab's browsing history and detailed recovery data?",
                "Remove"
              );
              if (!confirmed) return;
              this.plugin.core.redactLeafHistory(leaf.id);
              this.plugin.core.history.forgetLeafRecord(leaf.id);
              this.plugin.core.scheduleSave();
              this.showInternal("home", false);
            })();
          }));
          menu.showAtMouseEvent(event);
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
        const menu = new import_obsidian12.Menu();
        menu.addItem(
          (item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openVaultHomeFile(file.path))
        );
        menu.addItem(
          (item) => item.setTitle("Open in new tab").setIcon("plus").onClick(() => void this.openVaultHomeFile(file.path, true))
        );
        menu.addItem(
          (item) => item.setTitle("Copy file path").setIcon("copy").onClick(() => void navigator.clipboard.writeText(file.path))
        );
        menu.showAtMouseEvent(event);
      });
    }
  }
  async openVaultHomeFile(path, newTab = false) {
    if (!newTab) this.closeReasonOverride = "view-replaced";
    try {
      const opened = await this.plugin.homeAdapter.openFile(this.leaf, path, newTab);
      if (!opened) {
        if (!newTab) this.closeReasonOverride = void 0;
        new import_obsidian12.Notice("That file is no longer available.");
      }
    } catch (error) {
      if (!newTab) this.closeReasonOverride = void 0;
      console.error("Unified Browser Core: failed to open Home file", error);
      new import_obsidian12.Notice("Could not open that file.");
    }
  }
  renderBookmarks() {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-bookmarks" });
    const heading = page.createDiv({ cls: "ubc-surface-heading" });
    heading.createEl("h1", { text: "Bookmarks" });
    const actions = heading.createDiv({ cls: "ubc-surface-actions" });
    const addBookmark = actions.createEl("button", { text: "New bookmark" });
    addBookmark.addEventListener("click", () => {
      void (async () => {
        const draft = await editBookmark(this.plugin.app, "", "", "New bookmark");
        if (!draft) return;
        this.plugin.core.bookmarks.addBookmark(draft);
        this.plugin.core.scheduleSave();
        this.showInternal("bookmarks", false);
      })();
    });
    const addFolder = actions.createEl("button", { text: "New folder" });
    addFolder.addEventListener("click", () => {
      void (async () => {
        const title = await promptText(this.plugin.app, "New bookmark folder", "", "Folder name");
        if (title === void 0) return;
        this.plugin.core.bookmarks.addFolder(title);
        this.plugin.core.scheduleSave();
        this.showInternal("bookmarks", false);
      })();
    });
    const importObsidian = actions.createEl("button", { text: "Import Obsidian Bookmarks" });
    importObsidian.addEventListener("click", () => {
      void (async () => {
        await this.plugin.importObsidianBookmarks();
        this.showInternal("bookmarks", false);
      })();
    });
    const importWebViewer = actions.createEl("button", { text: "Import Web viewer Bookmarks" });
    importWebViewer.addEventListener("click", () => {
      void (async () => {
        await this.plugin.importWebViewerBookmarks();
        this.showInternal("bookmarks", false);
      })();
    });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: "Organize saved pages into folders, or search by title, URL, and folder."
    });
    const controls = page.createDiv({ cls: "ubc-bookmark-controls" });
    const search = controls.createEl("input", {
      cls: "ubc-bookmark-search",
      attr: {
        type: "search",
        placeholder: "Search bookmarks",
        "aria-label": "Search bookmarks"
      }
    });
    search.value = this.bookmarkSearchQuery;
    const summary = page.createDiv({ cls: "ubc-bookmark-summary", attr: { "aria-live": "polite" } });
    const list = page.createDiv({ cls: "ubc-bookmark-manager" });
    const render = () => {
      list.empty();
      const needle = this.bookmarkSearchQuery.toLowerCase().trim();
      const allBookmarks = this.plugin.core.bookmarks.allBookmarks();
      const favoriteCount = this.plugin.core.bookmarks.favorites().length;
      const folderCount = this.plugin.core.bookmarks.folders().length;
      if (needle) {
        const matches = allBookmarks.filter((bookmark) => {
          const path = bookmark.parentId ? this.plugin.core.bookmarks.folderPath(bookmark.parentId) : "";
          return [bookmark.title, bookmark.url, path].some((value) => value.toLowerCase().includes(needle));
        });
        summary.setText(
          matches.length ? `${matches.length} matching bookmark${matches.length === 1 ? "" : "s"}` : "No bookmarks match this search."
        );
        if (!matches.length) {
          const empty = list.createDiv({ cls: "ubc-empty-state" });
          empty.createEl("strong", { text: "No matching bookmarks" });
          empty.createEl("p", { text: "Try another title, URL, or folder name." });
          return;
        }
        for (const bookmark of matches) this.renderBookmarkSearchResult(list, bookmark);
        return;
      }
      summary.setText(
        allBookmarks.length || folderCount ? `${allBookmarks.length} bookmark${allBookmarks.length === 1 ? "" : "s"} \xB7 ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"} \xB7 ${folderCount} folder${folderCount === 1 ? "" : "s"}` : "No bookmarks yet."
      );
      if (!this.plugin.core.bookmarks.children(null).length) {
        const empty = list.createDiv({ cls: "ubc-empty-state" });
        empty.createEl("strong", { text: "No bookmarks yet" });
        empty.createEl("p", { text: "Save a page or create a folder to start building your bookmark library." });
        const emptyActions = empty.createDiv({ cls: "ubc-empty-actions" });
        const firstBookmark = emptyActions.createEl("button", { text: "New bookmark" });
        firstBookmark.addEventListener("click", () => addBookmark.click());
        const firstFolder = emptyActions.createEl("button", { text: "New folder" });
        firstFolder.addEventListener("click", () => addFolder.click());
        return;
      }
      this.renderBookmarkFolder(list, null, 0, render);
    };
    search.addEventListener("input", () => {
      this.bookmarkSearchQuery = search.value;
      render();
    });
    render();
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
        (0, import_obsidian12.setIcon)(toggle, collapsed ? "chevron-right" : "chevron-down");
        const title = row.createEl("button", {
          cls: "ubc-bookmark-folder-title",
          text: item.title,
          attr: { type: "button" }
        });
        const count = this.plugin.core.bookmarks.descendantBookmarks(item.id).length;
        row.createSpan({
          cls: "ubc-bookmark-count",
          text: String(count),
          attr: { "aria-label": `${count} bookmark${count === 1 ? "" : "s"} in ${item.title}` }
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
        "aria-label": bookmark.favorite ? "Remove from favorites" : "Add to favorites",
        title: bookmark.favorite ? "Remove from favorites" : "Add to favorites"
      }
    });
    (0, import_obsidian12.setIcon)(button, "star");
    button.toggleClass("is-active", bookmark.favorite);
    button.addEventListener("click", () => {
      this.plugin.core.bookmarks.setFavorite(bookmark.id, !bookmark.favorite);
      this.plugin.core.scheduleSave();
      this.refreshBookmarks();
    });
  }
  renderHistory() {
    const page = this.internalLayerEl.createDiv({ cls: "ubc-surface ubc-history" });
    const heading = page.createDiv({ cls: "ubc-surface-heading" });
    heading.createEl("h1", { text: "History" });
    page.createEl("p", {
      cls: "ubc-surface-description",
      text: "Browse visits by day, tab, and alternate path. Filtering only changes what is shown."
    });
    const filters = page.createDiv({ cls: "ubc-history-filters" });
    const search = filters.createEl("input", {
      attr: {
        placeholder: "Search title, URL, domain, or tab",
        "aria-label": "Search history"
      }
    });
    this.historySearchEl = search;
    const dayFilter = filters.createEl("input", {
      attr: { type: "date", "aria-label": "Filter history by day" }
    });
    const containerFilter = filters.createEl("select", {
      attr: { "aria-label": "Filter history by container" }
    });
    containerFilter.createEl("option", { text: "All containers", value: "" });
    for (const container of this.plugin.core.containers.list()) {
      containerFilter.createEl("option", { text: container.name, value: container.id });
    }
    const clearFilters = filters.createEl("button", { text: "Clear filters" });
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
        navigationCount ? `${navigationCount} visit${navigationCount === 1 ? "" : "s"} across ${days.length} day${days.length === 1 ? "" : "s"}${tombstoneCount ? ` \xB7 ${tombstoneCount} deleted entr${tombstoneCount === 1 ? "y" : "ies"} retained` : ""}${filtersActive ? " \xB7 filtered" : ""}` : tombstoneCount ? `${tombstoneCount} deleted histor${tombstoneCount === 1 ? "y entry" : "y entries"} retained to preserve navigation paths${filtersActive ? " \xB7 filtered" : ""}` : filtersActive ? "No history matches these filters." : "No browser history yet."
      );
      clearFilters.toggleClass("is-hidden", !filtersActive);
      if (!days.length) {
        const empty = timeline.createDiv({ cls: "ubc-history-empty" });
        empty.createEl("strong", { text: filtersActive ? "No matching visits" : "No history yet" });
        empty.createEl("p", {
          text: filtersActive ? "Try clearing one or more filters." : "Visited web pages will appear here without creating artificial gaps for idle time."
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
              const restore = leafHeader.createEl("button", { text: "Restore" });
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
    const menu = new import_obsidian12.Menu();
    const navigationNodes = dayNodes.filter((node) => node.kind === "navigation");
    const branchIds = [...new Set(navigationNodes.map((node) => node.branchId))];
    menu.addItem((item) => item.setTitle("Expand all alternate paths").onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.add(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle("Collapse all alternate paths").onClick(() => {
      for (const branchId of branchIds) this.expandedHistoryBranches.delete(branchId);
      refresh();
    }));
    menu.addItem((item) => item.setTitle("Open all tabs from this day").setIcon("copy-plus").onClick(() => {
      const latestByLeaf = /* @__PURE__ */ new Map();
      for (const node of navigationNodes) {
        const current = latestByLeaf.get(node.leafId);
        if (!current || node.timestamp > current.timestamp) latestByLeaf.set(node.leafId, node);
      }
      for (const node of latestByLeaf.values()) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle("Search within this day").setIcon("search").onClick(filterDay));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Delete this day's history").setIcon("trash").onClick(() => {
      void (async () => {
        if (!await confirmAction(this.plugin.app, "Delete history day", `Delete web history recorded in ${day}?`, "Delete history")) return;
        this.plugin.core.redactHistoryNodes(navigationNodes.map((node) => node.id));
        refresh();
      })();
    }));
    menu.showAtMouseEvent(event);
  }
  showHistoryLeafMenu(leafId, leafNodes, event, refresh) {
    const record = this.plugin.core.state.history.leaves[leafId];
    const navigationNodes = leafNodes.filter((node) => node.kind === "navigation");
    const mainBranch = this.plugin.core.history.currentBranchForLeaf(leafId) ?? navigationNodes.at(-1)?.branchId;
    const mainNodes = mainBranch ? this.plugin.core.history.navigationNodesForBranch(mainBranch) : navigationNodes;
    const menu = new import_obsidian12.Menu();
    if (record?.lastUrl) {
      menu.addItem((item) => item.setTitle("Restore tab").setIcon("rotate-ccw").onClick(() => void this.plugin.restoreLeaf(leafId)));
      const originalContainerExists = Boolean(this.plugin.core.containers.find(record.containerId));
      menu.addItem(
        (item) => item.setTitle(originalContainerExists ? "Restore in original container" : "Original container deleted").setIcon("box").setDisabled(!originalContainerExists).onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: record.containerId }))
      );
      for (const container of this.plugin.core.containers.list()) {
        if (container.id === record.containerId) continue;
        menu.addItem((item) => item.setTitle("Restore in " + container.name).setIcon("box").onClick(() => void this.plugin.restoreLeaf(leafId, { containerId: container.id })));
      }
      menu.addItem((item) => item.setTitle("Pin restored tab").setIcon("pin").onClick(() => void this.plugin.restoreLeaf(leafId, { pinned: true })));
    }
    menu.addItem((item) => item.setTitle("Open current path in new tabs").setDisabled(mainNodes.length === 0).onClick(() => {
      for (const node of mainNodes) void this.plugin.openBrowser({ url: node.url, containerId: node.containerId });
    }));
    menu.addItem((item) => item.setTitle(record?.manualRetention === "preserve" ? "Use normal recovery retention" : "Keep recovery data").onClick(() => {
      if (!record) return;
      record.manualRetention = record.manualRetention === "preserve" ? "default" : "preserve";
      this.plugin.core.scheduleSave();
      refresh();
    }));
    menu.addItem((item) => item.setTitle("Copy tab history").setIcon("copy").onClick(() => {
      const text = navigationNodes.map((node) => `${new Date(node.timestamp).toLocaleString()}	${node.title}	${node.url}`).join("\n");
      void navigator.clipboard.writeText(text);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Delete tab history").setIcon("trash").onClick(() => {
      void (async () => {
        if (!await confirmAction(this.plugin.app, "Delete tab history", "Delete this tab's browsing history and detailed recovery data?", "Delete history")) return;
        this.plugin.core.redactLeafHistory(leafId);
        refresh();
      })();
    }));
    menu.showAtMouseEvent(event);
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
        row.createSpan({ text: "Deleted history entry" });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const check = this.plugin.core.history.canRemoveTombstone(node.id);
          const menu = new import_obsidian12.Menu();
          menu.addItem(
            (item) => item.setTitle("Remove deleted entry marker").setIcon("trash").setDisabled(!check.ok).onClick(() => {
              const result = this.plugin.core.history.removeTombstone(node.id);
              if (!result.ok) {
                new import_obsidian12.Notice(result.reason || "This deleted entry marker cannot be removed.");
                return;
              }
              this.plugin.core.scheduleSave();
              this.showInternal("history");
            })
          );
          if (!check.ok && check.reason) {
            menu.addItem((item) => item.setTitle(check.reason || "").setDisabled(true));
          }
          menu.showAtMouseEvent(event);
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
          text: `Alternate path \xB7 ${count} visit${count === 1 ? "" : "s"}`
        });
        expand.addEventListener("click", () => {
          this.expandedHistoryBranches.add(node.branchId);
          this.showInternal("history");
        });
        summary.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const branchNodes = this.plugin.core.history.navigationNodesForBranch(node.branchId);
          const latest = branchNodes.at(-1);
          const menu = new import_obsidian12.Menu();
          menu.addItem((item) => item.setTitle("Show alternate path").onClick(() => {
            this.expandedHistoryBranches.add(node.branchId);
            this.showInternal("history");
          }));
          menu.addItem(
            (item) => item.setTitle("Restore latest page from this path").setIcon("rotate-ccw").setDisabled(!latest).onClick(() => {
              if (latest) void this.plugin.restoreHistoryNode(latest);
            })
          );
          menu.addItem((item) => item.setTitle("Open this path in new tabs").setDisabled(branchNodes.length === 0).onClick(() => {
            for (const branchNode of branchNodes) void this.plugin.openBrowser({ url: branchNode.url, containerId: branchNode.containerId });
          }));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("Delete alternate path").setIcon("trash").onClick(() => {
            void (async () => {
              if (!await confirmAction(this.plugin.app, "Delete alternate history path", `Delete ${branchNodes.length} visit(s) from this path?`, "Delete path")) return;
              this.plugin.core.redactHistoryBranch(node.branchId);
              this.expandedHistoryBranches.delete(node.branchId);
              this.showInternal("history");
            })();
          }));
          menu.showAtMouseEvent(event);
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
          text: "Reveal",
          attr: { "aria-label": "Reveal this visit in its alternate path" }
        });
        reveal.addEventListener("click", () => this.revealHistoryNode(node));
      }
      const residuals = this.plugin.core.history.residualsOf(node.id);
      if (residuals.length) {
        const badge = row.createEl("button", {
          cls: "ubc-residual-badge",
          text: `+${residuals.length}`,
          attr: {
            "aria-label": `Show ${residuals.length} reload, redirect, or navigation event${residuals.length === 1 ? "" : "s"}`
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
        const menu = new import_obsidian12.Menu();
        menu.addItem((item) => item.setTitle("Open").onClick(() => this.navigate(node.url)));
        menu.addItem((item) => item.setTitle("Open in new tab").onClick(() => this.plugin.openBrowser({ url: node.url, containerId: node.containerId })));
        for (const container of this.plugin.core.containers.list()) {
          menu.addItem(
            (item) => item.setTitle("Open in " + container.name).setIcon("box").onClick(() => this.plugin.openBrowser({ url: node.url, containerId: container.id }))
          );
        }
        menu.addItem(
          (item) => item.setTitle("Restore from here").onClick(() => this.plugin.restoreHistoryNode(node))
        );
        menu.addItem(
          (item) => item.setTitle("Show in full history").setIcon("locate").onClick(() => this.revealHistoryNode(node))
        );
        menu.addItem((item) => item.setTitle("Bookmark").onClick(() => {
          this.plugin.core.bookmarks.addBookmark({ title: node.title, url: node.url });
          this.plugin.core.scheduleSave();
          this.renderFavoritesBar();
        }));
        menu.addItem(
          (item) => item.setTitle("Copy URL").setIcon("copy").onClick(() => void navigator.clipboard.writeText(node.url))
        );
        menu.addItem(
          (item) => item.setTitle("Copy title").setIcon("copy").onClick(() => void navigator.clipboard.writeText(node.title || node.url))
        );
        if (residuals.length) {
          menu.addItem(
            (item) => item.setTitle(this.expandedResidualParents.has(node.id) ? "Hide redirects and reloads" : "Show redirects and reloads").onClick(() => {
              if (this.expandedResidualParents.has(node.id)) this.expandedResidualParents.delete(node.id);
              else this.expandedResidualParents.add(node.id);
              this.showInternal("history");
            })
          );
        }
        if (node.branchId !== lastBranch) {
          menu.addItem((item) => item.setTitle("Collapse alternate path").onClick(() => {
            this.expandedHistoryBranches.delete(node.branchId);
            this.showInternal("history");
          }));
        }
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(node.manualRetention === "preserve" ? "Use normal recovery retention" : "Keep recovery data").onClick(() => {
          node.manualRetention = node.manualRetention === "preserve" ? "default" : "preserve";
          this.plugin.core.scheduleSave();
        }));
        menu.addItem((item) => item.setTitle("Delete history entry").setIcon("trash").onClick(() => {
          void (async () => {
            const confirmed = await confirmAction(
              this.plugin.app,
              "Delete history entry",
              `Delete \u201C${node.title || node.url}\u201D from browser history?`,
              "Delete history"
            );
            if (!confirmed) return;
            this.plugin.core.redactHistoryNode(node.id);
            this.showInternal("history");
          })();
        }));
        menu.showAtMouseEvent(event);
      });
      if (this.expandedResidualParents.has(node.id)) {
        for (const residual of residuals) {
          const detail = parent.createDiv({ cls: "ubc-history-residual-detail" });
          detail.createSpan({ cls: "ubc-residual-kind", text: residualLabel(residual.residualKind) });
          const text = residual.residualKind === "redirect" ? `${residual.fromUrl || "unknown"} \u2192 ${residual.toUrl || "unknown"}` : residual.detail || residual.toUrl || residual.fromUrl || "Recorded browser event";
          detail.createSpan({ text });
          detail.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const menu = new import_obsidian12.Menu();
            menu.addItem((item) => item.setTitle("Copy event details").setIcon("copy").onClick(() => {
              void navigator.clipboard.writeText(JSON.stringify(residual, null, 2));
            }));
            if (residual.residualKind === "redirect" && residual.fromUrl) {
              menu.addItem((item) => item.setTitle("Open redirect source").onClick(() => this.navigate(residual.fromUrl)));
            }
            if (residual.residualKind === "redirect" && residual.toUrl) {
              menu.addItem((item) => item.setTitle("Open redirect destination").onClick(() => this.navigate(residual.toUrl)));
            }
            menu.addItem((item) => item.setTitle("Hide redirects and reloads").onClick(() => {
              this.expandedResidualParents.delete(node.id);
              this.showInternal("history");
            }));
            menu.showAtMouseEvent(event);
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
    const menu = new import_obsidian12.Menu();
    menu.addItem(
      (item) => item.setTitle("Open new tab in this container").setIcon("plus").onClick(() => void this.plugin.openBrowser({ url: "browser://home", containerId: this.containerId }))
    );
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Reopen current page in").setIcon("repeat-2").setDisabled(true));
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
        (item) => item.setTitle("Automatic site defaults are off").setIcon("route-off").setDisabled(true)
      );
      menu.addItem((item) => item.setTitle("Manage containers").setIcon("settings").onClick(() => this.plugin.openSettings()));
      menu.showAtPosition(position);
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
            routing.bypassingAssignment ? routing.bypassReason === "opener" ? `Sign-in flow stays in this container \xB7 site default is ${assignedName}` : `Opened here explicitly \xB7 site default is ${assignedName}` : `Site default \xB7 ${assignedName}`
          ).setIcon(routing.bypassingAssignment ? "shuffle" : "route").setDisabled(true)
        );
        if (routing.bypassingAssignment) {
          menu.addItem(
            (item) => item.setTitle(`Return to site default \xB7 ${assignedName}`).setIcon("undo-2").onClick(() => this.reopenInContainer(assignment.containerId))
          );
        }
      } else {
        menu.addItem(
          (item) => item.setTitle("No default container for this site").setIcon("route-off").setDisabled(true)
        );
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Site default container").setIcon("route").setDisabled(true));
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem(
          (item) => item.setTitle(`Always open ${routing.hostname} in ${container.name}`).setIcon(container.icon || "box").setChecked(routing.assignedContainerId === container.id).onClick(() => this.assignCurrentSiteToContainer(routing.hostname, container.id))
        );
      }
      if (assignment) {
        menu.addItem((item) => item.setTitle("Forget site default container").onClick(() => {
          this.plugin.core.containers.unassignOrigin(assignment.originPattern);
          this.siteAssignmentBypassOrigin = void 0;
          this.siteAssignmentBypassReason = void 0;
          this.plugin.core.scheduleSave();
          this.plugin.scheduleSessionCheckpoint();
          this.updateContainerIndicator();
          new import_obsidian12.Notice("Forgot the site default container for " + assignment.originPattern);
        }));
      }
    } else {
      menu.addItem((item) => item.setTitle("Site defaults are only available for web pages").setDisabled(true));
    }
    menu.addItem((item) => item.setTitle("Manage containers").setIcon("settings").onClick(() => this.plugin.openSettings()));
    menu.showAtPosition(position);
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
    new import_obsidian12.Notice(`Always open ${hostname} in ${this.plugin.core.containers.nameFor(containerId)}.`);
  }
  updateContainerIndicator() {
    if (!this.containerButtonEl) return;
    const mode = this.plugin.core.settings().containerMode;
    this.containerButtonEl.toggleClass("is-hidden", mode === "off");
    if (mode === "off") return;
    const container = this.plugin.core.containers.get(this.containerId);
    (0, import_obsidian12.setIcon)(this.containerButtonEl, container.icon || "box");
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
  updatePermissionIndicator() {
    if (!this.permissionButtonEl) return;
    const origin = this.currentOrigin();
    const records = origin ? this.plugin.core.permissions.listForOrigin(this.containerId, origin) : [];
    this.permissionButtonEl.toggleClass("has-permissions", records.length > 0);
    const summary = records.length ? records.map((record) => `${permissionLabel(record.permission)}: ${permissionDecisionLabel(record.decision)}`).join(", ") : "No saved site permissions";
    this.permissionButtonEl.setAttribute("aria-label", `Site permissions: ${summary}`);
    this.permissionButtonEl.title = summary;
  }
  showPermissionMenu(event) {
    const menu = new import_obsidian12.Menu();
    const origin = this.currentOrigin();
    if (!origin) {
      menu.addItem((item) => item.setTitle("Site permissions are only available for web pages").setDisabled(true));
      menu.addItem((item) => item.setTitle("Open Browser Core settings").onClick(() => this.plugin.openSettings()));
      menu.showAtMouseEvent(event);
      return;
    }
    const records = this.plugin.core.permissions.listForOrigin(this.containerId, origin);
    if (!records.length) {
      menu.addItem((item) => item.setTitle("No saved permissions for this site").setDisabled(true));
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
              this.updatePermissionIndicator();
            })
          );
        }
        menu.addSeparator();
      }
    }
    menu.addItem(
      (item) => item.setTitle("Reset site permissions").setIcon("rotate-ccw").setDisabled(records.length === 0).onClick(() => {
        this.plugin.core.permissions.resetOrigin(this.containerId, origin);
        this.plugin.core.scheduleSave();
        this.updatePermissionIndicator();
      })
    );
    menu.addItem((item) => item.setTitle("Open Browser Core settings").setIcon("settings").onClick(() => this.plugin.openSettings()));
    menu.showAtMouseEvent(event);
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
    const menu = new import_obsidian12.Menu();
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
      (item) => item.setTitle("Show full tab history").setIcon("history").onClick(() => this.showInternal("history"))
    );
    menu.addItem(
      (item) => item.setTitle("Show alternate paths").setIcon("git-branch").onClick(() => {
        for (const node of this.plugin.core.history.nodesForLeaf(this.leafId())) {
          if (node.kind === "navigation") this.expandedHistoryBranches.add(node.branchId);
        }
        this.showInternal("history");
      })
    );
    menu.showAtMouseEvent(event);
  }
  addFallbackWebNavigationItems(menu, direction) {
    const webview = this.readyWebview();
    if (!webview) {
      menu.addItem(
        (item) => item.setTitle(direction < 0 ? "No back history" : "No forward history").setDisabled(true)
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
        (item) => item.setTitle(direction < 0 ? "No back history" : "No forward history").setDisabled(true)
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
    const menu = new import_obsidian12.Menu();
    const start = this.addressEl.selectionStart ?? 0;
    const end = this.addressEl.selectionEnd ?? start;
    const selectionStart = Math.min(start, end);
    const selectionEnd = Math.max(start, end);
    const rawSelected = this.addressEl.value.slice(selectionStart, selectionEnd);
    const selected = rawSelected.trim();
    const hasSelection = selectionEnd > selectionStart;
    menu.addItem(
      (item) => item.setTitle("Cut").setDisabled(!hasSelection).onClick(async () => {
        if (!hasSelection) return;
        await navigator.clipboard.writeText(rawSelected);
        this.replaceAddressSelection("");
      })
    );
    menu.addItem(
      (item) => item.setTitle("Copy").setDisabled(!hasSelection).onClick(() => {
        if (!hasSelection) return;
        void navigator.clipboard.writeText(rawSelected);
      })
    );
    menu.addItem(
      (item) => item.setTitle("Paste").onClick(async () => {
        const value = await navigator.clipboard.readText();
        this.replaceAddressSelection(value);
      })
    );
    menu.addItem(
      (item) => item.setTitle("Paste and go").onClick(async () => {
        const value = await navigator.clipboard.readText();
        if (value) this.navigate(this.normalizeAddress(value));
      })
    );
    menu.addItem(
      (item) => item.setTitle("Delete").setDisabled(!hasSelection).onClick(() => this.replaceAddressSelection(""))
    );
    menu.addItem(
      (item) => item.setTitle("Select all").onClick(() => {
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
      (item) => item.setTitle("Copy URL").setIcon("copy").onClick(() => void navigator.clipboard.writeText(this.currentUrlValue))
    );
    menu.addItem(
      (item) => item.setTitle("Copy page title and URL").onClick(
        () => void navigator.clipboard.writeText(this.currentTitle + "\n" + this.currentUrlValue)
      )
    );
    if (!this.currentUrlValue.startsWith("browser://")) {
      menu.addItem(
        (item) => item.setTitle("Bookmark page").setIcon("bookmark").onClick(() => this.bookmarkCurrentPage())
      );
      for (const container of this.plugin.core.containers.list()) {
        menu.addItem(
          (item) => item.setTitle("Open current URL in " + container.name).setIcon("box").onClick(() => {
            void this.plugin.openBrowser({ url: this.currentUrlValue, containerId: container.id });
          })
        );
      }
      menu.addItem(
        (item) => item.setTitle("History for this site").setIcon("history").onClick(() => {
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
      (item) => item.setTitle("Clear").setIcon("x").onClick(() => {
        this.addressEl.value = "";
        this.addressEl.focus();
      })
    );
    menu.showAtMouseEvent(event);
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

// src/ui/permission-prompt.ts
var import_obsidian13 = require("obsidian");
function promptPermission(app, origin, permission) {
  return new Promise((resolve) => {
    new PermissionPromptModal(app, origin, permission, resolve).open();
  });
}
var PermissionPromptModal = class extends import_obsidian13.Modal {
  constructor(app, origin, permission, resolve) {
    super(app);
    this.origin = origin;
    this.permission = permission;
    this.resolve = resolve;
  }
  settled = false;
  onOpen() {
    this.contentEl.createEl("h2", { text: "Site permission" });
    this.contentEl.createEl("p", {
      text: `${this.origin} is requesting \u201C${permissionLabel(this.permission)}\u201D.`
    });
    this.contentEl.createEl("p", {
      text: "Allow and Block are remembered for this site in the current container. Not now denies this request without saving a decision."
    });
    const actions = this.contentEl.createDiv({ cls: "ubc-permission-actions" });
    const notNow = actions.createEl("button", { text: "Not now" });
    notNow.addEventListener("click", () => this.finish("ask"));
    actions.createEl("button", { text: "Block" }).addEventListener("click", () => this.finish("block"));
    const allow = actions.createEl("button", { text: "Allow", cls: "mod-cta" });
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
var import_obsidian14 = require("obsidian");
var TabSearchModal = class extends import_obsidian14.FuzzySuggestModal {
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
    text.createEl("strong", { text: "Looking for a Vault file?" });
    text.createSpan({ text: "Use Obsidian's Quick Switcher for notes and files." });
    const button = bridge.createEl("button", {
      text: "Quick Switcher",
      attr: { type: "button", "aria-label": "Open Obsidian Quick Switcher" }
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
      text: match.item.url.startsWith("browser://") ? "Browser Core page" : match.item.url
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
      const menu = new import_obsidian14.Menu();
      menu.addItem((item) => item.setTitle("Switch to tab").setIcon("mouse-pointer-click").onClick(() => this.plugin.app.workspace.revealLeaf(leaf)));
      menu.addItem((item) => item.setTitle(match.item.pinned ? "Unpin" : "Pin").setIcon("pin").onClick(() => leaf.setPinned(!match.item.pinned)));
      menu.addItem((item) => item.setTitle("Move to new window").setIcon("picture-in-picture").onClick(() => {
        try {
          this.plugin.app.workspace.moveLeafToPopout(leaf);
        } catch {
          new import_obsidian14.Notice("This Obsidian build cannot move the tab to a new window.");
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
          menu.addItem((item) => item.setTitle(bookmark ? "Remove bookmark" : "Bookmark").setIcon(bookmark ? "bookmark-check" : "bookmark").onClick(() => {
            this.plugin.core.bookmarks.toggleBookmark({ title, url });
            this.plugin.core.scheduleSave();
            this.plugin.refreshBrowserViews();
          }));
          menu.addItem((item) => item.setTitle("Copy URL").setIcon("copy").onClick(() => {
            void navigator.clipboard.writeText(url);
          }));
        }
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => {
        this.close();
        const hostWindow = this.modalEl.ownerDocument.defaultView ?? window;
        hostWindow.requestAnimationFrame(() => this.plugin.openQuickSwitcher());
      }));
      menu.addItem((item) => item.setTitle("Close tab").setIcon("x").onClick(() => leaf.detach()));
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
var UnifiedBrowserCorePlugin = class extends import_obsidian15.Plugin {
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
  webViewerBookmarksAdapter;
  persistence;
  unloading = false;
  sessionCheckpointTimer;
  sessionCheckpointArmed = false;
  layoutInitializationInProgress = false;
  homeTakeoverArmed = false;
  replacingEmptyLeaf = false;
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
    this.addRibbonIcon("globe", "Open browser", () => this.openBrowser());
    this.addCommand({
      id: "open-browser",
      name: "Open browser",
      callback: () => this.openBrowser()
    });
    this.addCommand({
      id: "open-history",
      name: "Open browser history",
      callback: () => this.openBrowser({ url: "browser://history" })
    });
    this.addCommand({
      id: "open-bookmarks",
      name: "Open browser bookmarks",
      callback: () => this.openBrowser({ url: "browser://bookmarks" })
    });
    this.addCommand({
      id: "import-obsidian-bookmarks",
      name: "Import web bookmarks from Obsidian Bookmarks",
      callback: () => void this.importObsidianBookmarks()
    });
    this.addCommand({
      id: "import-webviewer-bookmarks",
      name: "Import bookmarks from Web viewer Bookmarks",
      callback: () => void this.importWebViewerBookmarks()
    });
    this.addCommand({
      id: "reopen-closed-tab",
      name: "Reopen last closed browser tab",
      callback: () => {
        const closed = this.core.history.recentlyClosed(1)[0];
        if (closed) void this.restoreLeaf(closed.id);
        else new import_obsidian15.Notice("No recently closed browser tab.");
      }
    });
    this.addCommand({
      id: "search-browser-tabs",
      name: "Search browser tabs",
      callback: () => this.openBrowserTabSearch()
    });
    this.addCommand({
      id: "next-browser-tab",
      name: "Next browser tab",
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(1);
        return true;
      }
    });
    this.addCommand({
      id: "previous-browser-tab",
      name: "Previous browser tab",
      checkCallback: (checking) => {
        if (this.browserTabsInActiveGroup().length < 2) return false;
        if (!checking) this.cycleBrowserTab(-1);
        return true;
      }
    });
    this.addCommand({
      id: "close-browser-tab",
      name: "Close current browser tab",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (!(leaf?.view instanceof BrowserView)) return false;
        if (!checking) leaf.detach();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-in",
      name: "Browser zoom in",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomIn();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-out",
      name: "Browser zoom out",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.zoomOut();
        return true;
      }
    });
    this.addCommand({
      id: "browser-zoom-reset",
      name: "Reset browser zoom for site",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.resetZoom();
        return true;
      }
    });
    this.addCommand({
      id: "browser-focus-address",
      name: "Focus browser address bar",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusAddressBar();
        return true;
      }
    });
    this.addCommand({
      id: "browser-back",
      name: "Browser back",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goBack();
        return true;
      }
    });
    this.addCommand({
      id: "browser-forward",
      name: "Browser forward",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.goForward();
        return true;
      }
    });
    this.addCommand({
      id: "browser-reload",
      name: "Reload browser page",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.reload();
        return true;
      }
    });
    this.addCommand({
      id: "browser-bookmark-page",
      name: "Bookmark current browser page",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.bookmarkCurrentPage();
        return true;
      }
    });
    this.addCommand({
      id: "browser-container-picker",
      name: "Open browser container picker",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.openContainerPicker();
        return true;
      }
    });
    this.addCommand({
      id: "browser-search-history",
      name: "Search browser history",
      checkCallback: (checking) => {
        const view = this.activeBrowserView();
        if (!view) return false;
        if (!checking) view.focusHistorySearch();
        return true;
      }
    });
    this.addCommand({
      id: "restore-browser-session",
      name: "Restore previous browser session",
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
      new import_obsidian15.Notice("This tab has no restorable URL.");
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
      () => {
        this.core.scheduleSave();
        for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
          if (!(leaf.view instanceof BrowserView)) continue;
          if (leaf.view.getState().containerId !== containerId) continue;
          leaf.view.refreshPermissionIndicator();
        }
      }
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
      new import_obsidian15.Notice("Close or reopen tabs using this container before deleting it.");
      return false;
    }
    this.permissionAdapter.release(containerId);
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new import_obsidian15.Notice("Could not clear this container's browsing data, so the container was not deleted.");
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.formRecovery.clearContainer(containerId);
    const removed = this.core.containers.remove(containerId);
    if (removed) {
      this.core.scheduleSave();
      new import_obsidian15.Notice(`Deleted container \u201C${container.name}\u201D and cleared its browsing data.`);
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
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (leaf.view instanceof BrowserView) leaf.view.refreshPermissionIndicator();
    }
    return count;
  }
  async clearContainerSession(containerId) {
    const container = this.core.containers.find(containerId);
    if (!container) return false;
    const cleared = await this.sessionDataAdapter.clearPartition(container.partition);
    if (!cleared) {
      new import_obsidian15.Notice(`Could not clear browsing data for \u201C${container.name}\u201D.`);
      return false;
    }
    this.core.permissions.resetContainer(containerId);
    this.core.scheduleSave();
    for (const leaf of this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE)) {
      if (!(leaf.view instanceof BrowserView)) continue;
      if (leaf.view.getState().containerId === containerId) leaf.view.refreshPermissionIndicator();
    }
    new import_obsidian15.Notice(`Cleared browsing data and saved permissions for \u201C${container.name}\u201D.`);
    return true;
  }
  captureSessionCheckpoint() {
    const leaves = this.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      return [{
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
      if (notify) new import_obsidian15.Notice("No previous browser session is available.");
      return;
    }
    const leavesToRestore = this.pendingPreviousSessionLeaves();
    if (!leavesToRestore.length) {
      if (notify) new import_obsidian15.Notice("The previous browser session is already restored.");
      return;
    }
    for (const saved of leavesToRestore) {
      const leaf = await this.openBrowser({
        url: saved.url,
        containerId: saved.containerId,
        restoredFromLeafId: saved.sourceLifecycleId,
        state: {
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
    if (notify) new import_obsidian15.Notice(`Restored ${leavesToRestore.length} browser tab(s).`);
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
      const container = settings.containerMode !== "off" && state.containerId ? this.core.containers.find(state.containerId) : void 0;
      this.tabStripAdapter.applyLeafStyle(
        leaf,
        policy,
        settings.tabStripIntegrationEnabled,
        Boolean(state.pinned),
        container?.color
      );
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
      if (view instanceof BrowserView) view.renderFavoritesBar();
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
      new import_obsidian15.Notice("Open Obsidian Settings \u2192 Community plugins \u2192 Unified Browser Core.");
    }
  }
  async importObsidianBookmarks(notify = true) {
    const snapshot = await this.bookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new import_obsidian15.Notice("Obsidian Bookmarks is unavailable or has no readable bookmark data.");
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
      new import_obsidian15.Notice(parts.join(" \xB7 "));
    }
    return { available: true, ...imported, skippedNonWeb: snapshot.skippedNonWeb };
  }
  async importWebViewerBookmarks(notify = true) {
    const snapshot = await this.webViewerBookmarksAdapter.scan();
    if (!snapshot.available) {
      if (notify) new import_obsidian15.Notice("Web viewer Bookmarks has no readable data in this vault.");
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
      new import_obsidian15.Notice(parts.join(" \xB7 "));
    }
    return { available: true, added: imported.added, reused: imported.reused, skippedInvalid: snapshot.skippedInvalid };
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
      new import_obsidian15.Notice("Obsidian Quick Switcher is not available.");
    }
  }
  showTabStripMenu(event) {
    const menu = new import_obsidian15.Menu();
    menu.addItem((item) => item.setTitle("New browser tab").setIcon("plus").onClick(() => void this.openBrowser()));
    for (const container of this.core.containers.list()) {
      menu.addItem(
        (item) => item.setTitle("New tab in " + container.name).setIcon("box").onClick(() => void this.openBrowser({ url: "browser://home", containerId: container.id }))
      );
    }
    const closed = this.core.history.recentlyClosed(1)[0];
    menu.addItem(
      (item) => item.setTitle("Reopen closed tab").setIcon("rotate-ccw").setDisabled(!closed).onClick(() => {
        if (closed) void this.restoreLeaf(closed.id);
      })
    );
    menu.addItem((item) => item.setTitle("Search browser tabs").setIcon("search").onClick(() => this.openBrowserTabSearch()));
    menu.addItem((item) => item.setTitle("Open Quick Switcher").setIcon("file-search-2").onClick(() => this.openQuickSwitcher()));
    const active = this.activeBrowserView();
    menu.addItem(
      (item) => item.setTitle("Bookmark all open browser tabs").setIcon("book-marked").setDisabled(!active).onClick(() => active?.bookmarkAllOpenTabs())
    );
    menu.addItem(
      (item) => item.setTitle("Restore previous browser session").setDisabled(this.pendingPreviousSessionLeaves().length === 0).onClick(() => void this.restorePreviousSession(true))
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
