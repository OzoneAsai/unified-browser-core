import { MarkdownView, type App } from "obsidian";

export function resolveBookmarkUrl(url: string, app: App): string {
  if (!/{{\s*selection\s*}}/.test(url)) return url;
  const selection = app.workspace.getActiveViewOfType(MarkdownView)?.editor?.getSelection().trim() || "";
  return url.replace(/{{\s*selection\s*}}/g, encodeURIComponent(selection));
}
