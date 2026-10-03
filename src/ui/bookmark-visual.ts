import { setIcon, TFile, type App } from "obsidian";
import type { BookmarkEntry } from "../core/model";

export function renderBookmarkVisual(
  parent: HTMLElement,
  bookmark: BookmarkEntry,
  className = "ubc-bookmark-visual",
  app?: App,
): HTMLElement {
  const host = parent.createSpan({ cls: className, attr: { "aria-hidden": "true" } });
  const fallback = () => {
    host.empty();
    setIcon(host, "bookmark");
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
    setIcon(host, bookmark.visualValue?.trim() || "bookmark");
    if (!host.firstElementChild) fallback();
    return host;
  }

  const source = bookmark.visualKind === "image"
    ? resolveCustomImage(bookmark.visualValue, app)
    : bookmark.faviconUrl?.trim() || fallbackFaviconUrl(bookmark.url);
  if (!source) {
    fallback();
    return host;
  }

  const image = host.createEl("img", {
    cls: "ubc-bookmark-visual-image",
    attr: { src: source, alt: "" },
  });
  image.addEventListener("error", fallback, { once: true });
  return host;
}

function resolveCustomImage(value: string | undefined, app?: App): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  if (/^(?:https?:|data:image\/|app:|file:)/i.test(source)) return source;
  const file = app?.vault.getAbstractFileByPath(source);
  return file instanceof TFile ? app!.vault.getResourcePath(file) : source;
}

export function fallbackFaviconUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return new URL("/favicon.ico", parsed.origin).href;
  } catch {
    return undefined;
  }
}
