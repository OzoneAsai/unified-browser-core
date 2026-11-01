/** Home Tab-compatible search modes, independent of Obsidian's UI. */
export type HomeSearchFilter =
  | { kind: "type"; value: string }
  | { kind: "extension"; value: string }
  | { kind: "omnisearch"; value: "omnisearch" }
  | { kind: "web"; value: "web" };

export const HOME_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  markdown: ["md"],
  image: ["png", "jpg", "jpeg", "svg", "gif", "bmp", "webp", "avif"],
  video: ["mp4", "webm", "ogv", "mov", "mkv"],
  audio: ["mp3", "wav", "m4a", "ogg", "3gp", "flac"],
  pdf: ["pdf"],
  canvas: ["canvas"],
};

const extensionSet = new Set(Object.values(HOME_TYPE_EXTENSIONS).flat());
const aliases: Record<string, string> = { md: "md", jpg: "jpg", jpeg: "jpeg", omni: "omnisearch", omnisearch: "omnisearch", surfing: "web", web: "web", internet: "web" };

export function parseHomeFilter(text: string): HomeSearchFilter | undefined {
  const key = text.trim().toLocaleLowerCase();
  const normalized = aliases[key] || key;
  if (normalized === "omnisearch") return { kind: "omnisearch", value: "omnisearch" };
  if (normalized === "web") return { kind: "web", value: "web" };
  if (Object.hasOwn(HOME_TYPE_EXTENSIONS, normalized)) return { kind: "type", value: normalized };
  if (extensionSet.has(normalized)) return { kind: "extension", value: normalized };
  return undefined;
}

export function matchesHomeFilter(extension: string, filter?: HomeSearchFilter): boolean {
  if (!filter || filter.kind === "omnisearch" || filter.kind === "web") return true;
  const value = extension.toLocaleLowerCase();
  return filter.kind === "extension"
    ? value === filter.value
    : HOME_TYPE_EXTENSIONS[filter.value]?.includes(value) ?? false;
}

/** Never allow an untrusted search string to escape the selected Vault folder. */
export function safeHomeNoteName(text: string): string | undefined {
  const name = text.trim().replace(/\.md$/i, "");
  if (!name || name === "." || name === ".." || /[\\/\u0000-\u001f:*?"<>|]/u.test(name)) return undefined;
  return name;
}
