import type { WebContentMenuEntry } from "../ui/web-content-menu-model";
import type { WebviewContextMenuParams, WebviewElement } from "../ui/webview-types";
import { resolveElectronRemote, resolveGuestWebContents } from "./electron-compat";

type ContextMenuEventLike = {
  preventDefault?: () => void;
};

type ContextMenuListener = (
  event: ContextMenuEventLike,
  params: WebviewContextMenuParams,
) => void;

type ConsoleMessageListener = (
  event: unknown,
  level: number,
  message: string,
  line: number,
  sourceId: string,
) => void;

type WebContentsLike = {
  on?: {
    (event: "context-menu", listener: ContextMenuListener): void;
    (event: "console-message", listener: ConsoleMessageListener): void;
  };
  removeListener?: {
    (event: "context-menu", listener: ContextMenuListener): void;
    (event: "console-message", listener: ConsoleMessageListener): void;
  };
  listeners?: (event: "context-menu") => ContextMenuListener[];
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

const EDITABLE_CONTEXT_MARKER = "__UBC_EDITABLE_CONTEXT__";

type NativeMenuLike = {
  append: (item: unknown) => void;
  popup: (target?: unknown) => void;
};

type NativeMenuCtor = new () => NativeMenuLike;
type NativeMenuItemCtor = new (options: {
  label?: string;
  type?: "separator";
  enabled?: boolean;
  click?: () => void;
}) => unknown;

type RemoteLike = {
  Menu?: NativeMenuCtor;
  MenuItem?: NativeMenuItemCtor;
};

/**
 * Browser Core owns the context menu of a managed Chromium guest.
 *
 * Obsidian/Electron can attach host context-menu listeners to every guest.
 * Leaving those active means both Browser Core and the host popup native menus
 * for the same event; the host's compact Copy menu can then replace ours even
 * after preventDefault(). Snapshot those listeners while the managed guest is
 * owned by Browser Core, install one Browser Core listener, and restore the
 * displaced listeners when the binding is disposed.
 */
export class ElectronContextMenuAdapter {
  bind(
    webview: WebviewElement,
    buildEntries: (params: WebviewContextMenuParams) => WebContentMenuEntry[],
  ): (() => void) | undefined {
    const contents = resolveGuestWebContents<WebContentsLike>(webview);
    const remote = resolveElectronRemote<RemoteLike>();
    if (
      !contents?.on ||
      !contents.removeListener ||
      !contents.listeners ||
      !remote?.Menu ||
      !remote.MenuItem
    ) return undefined;

    const MenuCtor = remote.Menu;
    const MenuItemCtor = remote.MenuItem;
    const displacedListeners = contents.listeners("context-menu").slice();
    for (const displaced of displacedListeners) {
      contents.removeListener("context-menu", displaced);
    }

    // macOS Chromium may surface its own compact Look up / Copy menu whenever
    // selection is still active as a right-click begins. Capture that selection
    // before Chromium's default right-mousedown behavior, collapse it just for
    // native menu creation, and let the host restore it after Browser Core owns
    // the popup. Links are handled as links and never inherit the transient
    // selection Chromium creates for their label.
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
    `, false).catch(() => undefined);

    // Keep the latest native menu strongly referenced while the guest binding
    // is alive. @electron/remote wrappers can otherwise be released while a
    // native popup is still active.
    let activeMenu: NativeMenuLike | undefined;

    const restorePendingSelection = () => {
      if (!contents.executeJavaScript) return;
      window.setTimeout(() => {
        void contents.executeJavaScript?.(
          "window.__ubcRestoreBrowserCoreContextSelection?.();",
          false,
        ).catch(() => undefined);
      }, 0);
    };

    const popupFor = (params: WebviewContextMenuParams) => {
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
          click: entry.action,
        }));
      }
      menu.popup(contents);
      restorePendingSelection();
    };

    const consoleListener: ConsoleMessageListener = (_event, _level, message) => {
      if (!message.startsWith(EDITABLE_CONTEXT_MARKER)) return;
      try {
        const params = JSON.parse(message.slice(EDITABLE_CONTEXT_MARKER.length)) as WebviewContextMenuParams;
        popupFor(params);
      } catch {
        restorePendingSelection();
      }
    };

    const listener: ContextMenuListener = (event, params) => {
      event.preventDefault?.();

      if (params.linkURL?.trim()) {
        // Link semantics win over Chromium's transient link-text selection.
        popupFor(params.selectionText?.trim() ? { ...params, selectionText: "" } : params);
        return;
      }

      if (!contents.executeJavaScript) {
        popupFor(params);
        return;
      }

      void contents.executeJavaScript(
        "window.__ubcBrowserCorePendingContextSelection?.text || '';",
        false,
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
      activeMenu = undefined;
      for (const displaced of displacedListeners) {
        contents.on?.("context-menu", displaced);
      }
    };
  }
}
