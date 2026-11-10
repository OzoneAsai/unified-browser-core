import { resolveGuestWebContents } from "./electron-compat";
import type { WebviewElement } from "../ui/webview-types";

type TargetUrlContents = {
  on: (event: "update-target-url", listener: (_event: unknown, url: string) => void) => void;
  removeListener: (event: "update-target-url", listener: (_event: unknown, url: string) => void) => void;
};

/** Native Chromium link-hover signal: no page-script injection and no polling. */
export function bindGuestLinkHover(webview: WebviewElement, show: (url: string) => void): (() => void) | undefined {
  const contents = resolveGuestWebContents<TargetUrlContents>(webview);
  if (!contents?.on || !contents.removeListener) return undefined;
  const listener = (_event: unknown, url: string) => {
    show(typeof url === "string" ? url.slice(0, 2048) : "");
  };
  contents.on("update-target-url", listener);
  return () => {
    try { contents.removeListener("update-target-url", listener); } catch { /* detached guest */ }
    show("");
  };
}
