import { resolveGuestWebContents } from "./electron-compat";
import type { WebviewElement } from "../ui/webview-types";

type Contents = {
  on(event: string, listener: (_event: unknown, input: { type?: string }) => void): void;
  removeListener(event: string, listener: (_event: unknown, input: { type?: string }) => void): void;
};

/** Observe guest input without cancelling or consuming the user's action. */
export function observeGuestInteraction(webview: WebviewElement, dismiss: () => void): (() => void) | undefined {
  const contents = resolveGuestWebContents<Contents>(webview);
  if (!contents?.on || !contents.removeListener) return undefined;
  const interact = (_event: unknown, input: { type?: string }) => {
    if (["mouseDown", "mouseWheel", "touchStart", "gestureScrollBegin", "keyDown", "rawKeyDown"].includes(input.type ?? "")) dismiss();
  };
  for (const event of ["before-mouse-event", "before-input-event", "input-event"]) contents.on(event, interact);
  return () => {
    for (const event of ["before-mouse-event", "before-input-event", "input-event"]) {
      try { contents.removeListener(event, interact); } catch { /* Detached guest. */ }
    }
  };
}
