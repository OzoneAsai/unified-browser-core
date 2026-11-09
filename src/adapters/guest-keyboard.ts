import { resolveGuestWebContents } from "./electron-compat";
import type { WebviewElement } from "../ui/webview-types";

export type GuestKeyInput = {
  type?: string;
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

type GuestKeyContents = {
  on: (event: "before-input-event", listener: (event: { preventDefault?: () => void }, input: GuestKeyInput) => void) => void;
  removeListener: (event: "before-input-event", listener: (event: { preventDefault?: () => void }, input: GuestKeyInput) => void) => void;
};

export type GuestBrowserShortcut = "find" | "find-next" | "find-previous" | "address";

/** A selective browser shortcut policy. Normal typing and IME always stay in the guest. */
export function guestBrowserShortcut(input: GuestKeyInput, findOpen: boolean): GuestBrowserShortcut | null {
  if (input.type !== "keyDown") return null;
  const key = input.key?.toLowerCase();
  if ((input.meta || input.control) && !input.alt) {
    if (key === "f") return "find";
    if (key === "l") return "address";
    if (key === "g" && findOpen) return input.shift ? "find-previous" : "find-next";
  }
  if (!input.control && !input.meta && !input.alt && key === "f3" && findOpen) {
    return input.shift ? "find-previous" : "find-next";
  }
  return null;
}

/** One listener per guest, not per navigation: no accumulating duplicates. */
export function bindGuestBrowserShortcuts(
  webview: WebviewElement,
  findOpen: () => boolean,
  active: () => boolean,
  handle: (shortcut: GuestBrowserShortcut) => void,
): (() => void) | undefined {
  const contents = resolveGuestWebContents<GuestKeyContents>(webview);
  if (!contents?.on || !contents.removeListener) return undefined;
  const listener = (event: { preventDefault?: () => void }, input: GuestKeyInput) => {
    if (!active()) return;
    const shortcut = guestBrowserShortcut(input, findOpen());
    if (!shortcut) return;
    event.preventDefault?.();
    handle(shortcut);
  };
  contents.on("before-input-event", listener);
  return () => {
    try { contents.removeListener("before-input-event", listener); } catch { /* guest already detached */ }
  };
}
