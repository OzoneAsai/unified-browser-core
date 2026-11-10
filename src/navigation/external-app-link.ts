// Web pages belong in Browser Core; registered application protocols do not.
// Match Surfing's distinction so obsidian:// and mailto: still reach their
// applications rather than being interpreted as browser searches.
const BROWSER_SCHEMES = new Set([
  "http", "https", "file", "about", "data", "blob", "javascript",
  "vbscript", "chrome", "chrome-extension", "chrome-error", "view-source", "devtools",
]);

export function isExternalAppLink(url: string): boolean {
  const value = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
  if (!scheme || /^\d/.test(value.slice(scheme.length + 1))) return false;
  return !BROWSER_SCHEMES.has(scheme.toLowerCase());
}
