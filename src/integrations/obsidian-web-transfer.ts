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
  const chars = Array.from(content);
  const encoded = chars.length > 250
    ? `${encodeURIComponent(chars.slice(0, 140).join(""))},${encodeURIComponent(chars.slice(-90).join(""))}`
    : encodeURIComponent(content);
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

export function videoTimestampLink(url: string, time: number): { url: string; label: string } | null {
  if (!Number.isFinite(time) || time < 0) return null;
  let page: URL;
  try { page = new URL(url); } catch { return null; }
  if (!/^https?:$/u.test(page.protocol)) return null;
  const seconds = Math.floor(time);
  // YouTube and Bilibili explicitly support a query-time deep link. Other
  // HTTP(S) media pages can use the standardized #t= media fragment.
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)bilibili\.com$/iu.test(page.hostname)) {
    page.searchParams.set("t", String(seconds));
  } else {
    page.hash = `t=${seconds}`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const label = hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
  return { url: page.href, label };
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
