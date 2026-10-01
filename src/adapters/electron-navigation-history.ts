import type { RestoreCapsule } from "../core/model";
import type { WebviewElement } from "../ui/webview-types";
import { resolveGuestWebContents } from "./electron-compat";

type NavigationHistoryLike = {
  getAllEntries?: () => Array<Record<string, unknown>>;
  getActiveIndex?: () => number;
  clear?: () => void;
  goToIndex?: (index: number) => void;
  restore?: (state: { entries: Array<Record<string, unknown>>; index: number }) => Promise<void> | void;
};

type WebContentsLike = { navigationHistory?: NavigationHistoryLike };

export class ElectronNavigationHistoryAdapter {
  capture(webview: WebviewElement, leafId: string): RestoreCapsule | undefined {
    const history = this.resolve(webview)?.navigationHistory;
    if (!history?.getAllEntries || !history.getActiveIndex) return undefined;
    try {
      const entries = JSON.parse(JSON.stringify(history.getAllEntries())) as Array<Record<string, unknown>>;
      return {
        leafId,
        capturedAt: Date.now(),
        entries,
        index: history.getActiveIndex(),
      };
    } catch {
      return undefined;
    }
  }

  async restore(
    webview: WebviewElement,
    capsule: RestoreCapsule,
    index = capsule.index,
  ): Promise<boolean> {
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

  entryMatches(capsule: RestoreCapsule, index: number, url: string): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= capsule.entries.length) return false;
    const entryUrl = capsule.entries[index]?.url;
    return typeof entryUrl === "string" && entryUrl === url;
  }

  activeIndex(webview: WebviewElement): number | undefined {
    try {
      return this.resolve(webview)?.navigationHistory?.getActiveIndex?.();
    } catch {
      return undefined;
    }
  }

  entries(webview: WebviewElement): Array<Record<string, unknown>> {
    try {
      return this.resolve(webview)?.navigationHistory?.getAllEntries?.() ?? [];
    } catch {
      return [];
    }
  }

  clear(webview: WebviewElement): boolean {
    try {
      const history = this.resolve(webview)?.navigationHistory;
      if (!history?.clear) return false;
      history.clear();
      return true;
    } catch {
      return false;
    }
  }

  goToIndex(webview: WebviewElement, index: number): boolean {
    try {
      const history = this.resolve(webview)?.navigationHistory;
      if (!history?.goToIndex) return false;
      history.goToIndex(index);
      return true;
    } catch {
      return false;
    }
  }

  private resolve(webview: WebviewElement): WebContentsLike | undefined {
    return resolveGuestWebContents<WebContentsLike>(webview);
  }
}
