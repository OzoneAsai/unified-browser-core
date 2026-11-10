/** Pure Web ↔ Vault interchange. No WebView or Obsidian global assumptions. */
export interface WebSelection {
  text: string;
  url: string;
  title: string;
}

export function webTextFragmentUrl(url: string, selected: string): string | null {
  const content = selected.replace(/\s+/g, " ").trim();
  if (!content) return null;
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  // Text fragments are separate from the regular page anchor. RFC3986 URI
  // encoding avoids double escaping UTF-8 Japanese/Chinese/emoji selections.
  const selection = content.length > 250 ? `${content.slice(0, 140)},${content.slice(-90)}` : content;
  const encoded = selection.split(",").map(part => encodeURIComponent(part)).join(",");
  const existing = target.hash.replace(/^#/, "").replace(/:~:text=.*$/u, "");
  target.hash = `${existing}:~:text=${encoded}`;
  return target.href;
}

export function formatBrowserTabsMarkdown(tabs: ReadonlyArray<{ title: string; url: string }>): string {
  return tabs.filter(item => /^https?:\/\//i.test(item.url)).map(item => {
    const name = (item.title || item.url).replace(/[\[\]\\]/g, "\\$&").replace(/[\r\n]+/g, " ");
    return `- [${name}](<${item.url.replaceAll(">", "%3E")}>)`;
  }).join("\n");
}

export function selectionNoteContent(selection: WebSelection): { baseName: string; markdown: string } {
  const title = selection.title.trim() || "Web selection";
  const baseName = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 100).trim() || "Web selection";
  const text = selection.text.trim();
  if (!text || !/^https?:\/\//i.test(selection.url)) throw new Error("Expected selected web text and an HTTP(S) source");
  // JSON double-quoted strings are valid YAML scalars; no HTML evaluation.
  const frontmatter = `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(selection.url)}\n---\n\n`;
  const quote = text.split(/\r?\n/).map(line => line ? `> ${line}` : ">").join("\n");
  return { baseName, markdown: `${frontmatter}${quote}\n\n[Source](${selection.url})\n` };
}
