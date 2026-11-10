/** Only browser URLs enter UBC. Wikilinks, email, Obsidian URI retain native owners. */
export function parseObsidianWebLink(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch { return null; }
}
