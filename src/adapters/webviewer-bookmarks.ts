import type { App } from "obsidian";
import type { ImportedWebBookmark } from "../bookmarks/bookmark-store";

export interface WebViewerBookmarkImportSnapshot {
  available: boolean;
  entries: ImportedWebBookmark[];
  skippedInvalid: number;
}

export class WebViewerBookmarksAdapter {
  constructor(private readonly app: App) {}

  async scan(): Promise<WebViewerBookmarkImportSnapshot> {
    const vault = this.app.vault as typeof this.app.vault & { configDir?: string };
    const path = `${vault.configDir || ".obsidian"}/plugins/webviewer-bookmarks/data.json`;
    try {
      if (!(await vault.adapter.exists(path))) return unavailable();
      return normalizeWebViewerBookmarks(JSON.parse(await vault.adapter.read(path)));
    } catch {
      return unavailable();
    }
  }
}

export function normalizeWebViewerBookmarks(data: unknown): WebViewerBookmarkImportSnapshot {
  if (!data || typeof data !== "object" || !("bookmarks" in data) || !Array.isArray(data.bookmarks)) {
    return unavailable();
  }

  const entries: ImportedWebBookmark[] = [];
  let skippedInvalid = 0;
  for (const item of data.bookmarks) {
    if (!item || typeof item !== "object" || typeof item.url !== "string") {
      skippedInvalid++;
      continue;
    }
    const url = item.url.trim();
    let parsed: URL;
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
      visualValue: typeof item.lucide === "string" && item.lucide.trim() ? item.lucide.trim() : "bookmark",
    });
  }
  return { available: true, entries, skippedInvalid };
}

function unavailable(): WebViewerBookmarkImportSnapshot {
  return { available: false, entries: [], skippedInvalid: 0 };
}
