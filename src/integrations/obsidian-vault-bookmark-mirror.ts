import { Notice, TFile, TFolder, parseYaml, type App, type Plugin } from "obsidian";
import type { BrowserCore } from "../core/browser-core";
import type { BookmarkEntry } from "../core/model";

/**
 * A user-controlled, two-way Obsidian Vault projection of Browser Core
 * bookmarks.  Only files bearing a UBC bookmark ID in the dedicated folder
 * are managed.  Surfing's own `surfing-bookmarks` directory is never altered.
 */
export const BOOKMARK_VAULT_FOLDER = "UBC Bookmarks";

export interface MirroredBookmarkData {
  id: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  favorite: boolean;
}

export function parseMirroredBookmark(markdown: string): MirroredBookmarkData | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) return null;
  let raw: unknown;
  try { raw = parseYaml(match[1] ?? ""); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fm = raw as Record<string, unknown>;
  if (typeof fm.ubc_bookmark_id !== "string" || !/^[a-zA-Z0-9_-]{1,180}$/u.test(fm.ubc_bookmark_id)) return null;
  if (typeof fm.url !== "string") return null;
  try {
    const parsed = new URL(fm.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch { return null; }
  return {
    id: fm.ubc_bookmark_id,
    url: fm.url,
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fm.url,
    description: typeof fm.description === "string" ? fm.description : "",
    tags: Array.isArray(fm.tags) ? fm.tags.filter((s): s is string => typeof s === "string") : [],
    favorite: fm.favorite === true,
  };
}

export function serializeMirroredBookmark(bookmark: BookmarkEntry): string {
  return [
    "---",
    `ubc_bookmark_id: ${JSON.stringify(bookmark.id)}`,
    `url: ${JSON.stringify(bookmark.url)}`,
    `title: ${JSON.stringify(bookmark.title)}`,
    `description: ${JSON.stringify(bookmark.description ?? "")}`,
    `tags: ${JSON.stringify(bookmark.tags ?? [])}`,
    `favorite: ${bookmark.favorite ? "true" : "false"}`,
    "---",
    "",
    `[Open web page](<${bookmark.url.replaceAll(">", "%3E")}>)`,
    "",
  ].join("\n");
}

export class ObsidianVaultBookmarkMirror {
  private files = new Map<string, TFile>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private applyingFromVault = false;
  private readonly unregisters: Array<() => void> = [];

  constructor(private readonly app: App, private readonly core: BrowserCore,
    private readonly refreshViews: () => void, private readonly host: Plugin) {
    const onChange = (file: { path: string }) => {
      if (this.matches(file.path)) this.enqueue(() => this.reconcile());
    };
    host.registerEvent(app.vault.on("create", onChange));
    host.registerEvent(app.vault.on("modify", onChange));
    host.registerEvent(app.vault.on("delete", onChange));
    host.registerEvent(app.vault.on("rename", (file, previous) => {
      if (this.matches(file.path) || this.matches(previous)) this.enqueue(() => this.reconcile());
    }));
    this.unregisters.push(core.events.on("bookmark-changed", (event) => {
      if (this.applyingFromVault || !this.enabled) return;
      if (event.kind !== "bookmark") return;
      this.enqueue(async () => {
        if (event.action === "deleted") await this.removePublished(event.id);
        else if (event.entry) await this.publish(event.entry);
      });
    }));
    host.register(() => this.dispose());
  }

  get enabled(): boolean { return this.core.state.vaultBookmarkMirror.enabled; }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    this.core.state.vaultBookmarkMirror.enabled = enabled;
    this.core.scheduleSave();
    if (enabled) await this.enqueue(() => this.reconcile());
  }

  async initialize(): Promise<void> {
    if (this.enabled) await this.enqueue(() => this.reconcile());
  }

  /** Await all event-scheduled mirror writes, useful during controlled reload. */
  async flush(): Promise<void> {
    // Vault events can enqueue another reconciliation *while* a write is in
    // flight. Wait for the fixed point, not only the promise that existed at
    // the time flush() was called.
    let observed: Promise<void>;
    do {
      observed = this.queue;
      await observed;
    } while (observed !== this.queue);
  }

  private matches(path: string): boolean {
    return path === BOOKMARK_VAULT_FOLDER || path.startsWith(BOOKMARK_VAULT_FOLDER + "/");
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => this.disposed || !this.enabled ? undefined : task());
    this.queue = run.catch(error => console.warn("Unified Browser Core: Vault bookmark mirror", error));
    return run;
  }

  private async readManagedFiles(): Promise<{ records: Map<string, { file: TFile; data: MirroredBookmarkData }>; unreadable: boolean }> {
    const folder = this.app.vault.getAbstractFileByPath(BOOKMARK_VAULT_FOLDER);
    const result = new Map<string, { file: TFile; data: MirroredBookmarkData }>();
    if (!(folder instanceof TFolder)) return { records: result, unreadable: false };
    let unreadable = false;
    for (const item of folder.children) {
      if (!(item instanceof TFile) || item.extension !== "md") continue;
      const data = parseMirroredBookmark(await this.app.vault.cachedRead(item));
      if (data && !result.has(data.id)) result.set(data.id, { file: item, data });
      else unreadable = true;
    }
    return { records: result, unreadable };
  }

  /** One serial reconciliation. A deletion is authoritative *only* for an ID
   * previously published by this mirror; unrelated bookmarks are preserved. */
  private async reconcile(): Promise<void> {
    const tracked = this.core.state.vaultBookmarkMirror.publishedIds;
    const root = this.app.vault.getAbstractFileByPath(BOOKMARK_VAULT_FOLDER);
    if (!root && tracked.length) {
      // A whole directory can momentarily vanish during external sync. Do
      // not interpret that transient as a request to delete every bookmark.
      this.core.state.vaultBookmarkMirror.enabled = false;
      this.core.scheduleSave();
      new Notice("UBC Vault bookmark folder vanished; sync paused to protect bookmarks.");
      return;
    }
    const { records, unreadable } = await this.readManagedFiles();
    const activeIds = new Set(records.keys());
    this.applyingFromVault = true;
    try {
      for (const id of tracked) {
        if (activeIds.has(id)) continue;
        // A malformed YAML note is not a deletion. Preserve all possible
        // mappings until the user corrects the file or removes it explicitly.
        if (unreadable) continue;
        if (this.core.bookmarks.getBookmark(id)) this.core.bookmarks.deleteBookmark(id);
      }
      for (const [id, { file, data }] of records) {
        const current = this.core.bookmarks.getBookmark(id);
        if (!current) {
          // Do not silently assign the old ID to a different URL. The note
          // stays untouched and a new in-core bookmark is only imported when
          // it does not conflict with an existing URL.
          const linked = this.core.bookmarks.findByUrl(data.url);
          if (!linked) this.core.bookmarks.addBookmark({ id, title: data.title, url: data.url,
            description: data.description, tags: data.tags, favorite: data.favorite });
          if (linked && linked.id !== id) console.info("Unified Browser Core: Vault bookmark URL already exists with another ID", file.path);
          if (this.core.bookmarks.getBookmark(id)) this.files.set(id, file);
          continue;
        }
        if (current.url !== data.url || current.title !== data.title ||
          (current.description ?? "") !== data.description ||
          JSON.stringify(current.tags ?? []) !== JSON.stringify(data.tags)) {
          this.core.bookmarks.updateBookmark(id, { url: data.url, title: data.title,
            description: data.description, tags: data.tags });
        }
        if (current.favorite !== data.favorite) this.core.bookmarks.setFavorite(id, data.favorite);
        this.files.set(id, file);
      }
    } finally { this.applyingFromVault = false; }

    // A note that was created manually with an obsolete ID does not
    // overwrite the user's file or duplicate another valid bookmark.
    const nextTracked = new Set(tracked.filter(id => activeIds.has(id) || unreadable));
    for (const bookmark of this.core.bookmarks.allBookmarks()) {
      if (records.has(bookmark.id)) { nextTracked.add(bookmark.id); continue; }
      const file = await this.publish(bookmark);
      if (file) nextTracked.add(bookmark.id);
    }
    this.core.state.vaultBookmarkMirror.publishedIds = [...nextTracked];
    this.core.scheduleSave();
    this.refreshViews();
  }

  private async publish(bookmark: BookmarkEntry): Promise<TFile | null> {
    if (!this.enabled || !/^https?:\/\//i.test(bookmark.url)) return null;
    const directory = this.app.vault.getAbstractFileByPath(BOOKMARK_VAULT_FOLDER);
    if (!directory) await this.app.vault.createFolder(BOOKMARK_VAULT_FOLDER);
    if (directory && !(directory instanceof TFolder)) throw new Error("Bookmark mirror folder is not a folder");
    let existing = this.files.get(bookmark.id);
    if (!existing?.parent) {
      for (const item of (this.app.vault.getAbstractFileByPath(BOOKMARK_VAULT_FOLDER) as TFolder).children) {
        if (!(item instanceof TFile) || item.extension !== "md") continue;
        if (parseMirroredBookmark(await this.app.vault.cachedRead(item))?.id === bookmark.id) { existing = item; break; }
      }
    }
    if (existing) {
      this.files.set(bookmark.id, existing);
      const current = parseMirroredBookmark(await this.app.vault.cachedRead(existing));
      if (current && current.url === bookmark.url && current.title === bookmark.title &&
        current.description === (bookmark.description ?? "") && current.favorite === bookmark.favorite &&
        JSON.stringify(current.tags) === JSON.stringify(bookmark.tags ?? [])) return existing;
      await this.app.fileManager.processFrontMatter(existing, frontmatter => {
        frontmatter.ubc_bookmark_id = bookmark.id;
        frontmatter.url = bookmark.url;
        frontmatter.title = bookmark.title;
        frontmatter.description = bookmark.description ?? "";
        frontmatter.tags = bookmark.tags ?? [];
        frontmatter.favorite = bookmark.favorite;
      });
      return existing;
    }
    const name = encodeURIComponent(bookmark.id);
    const path = `${BOOKMARK_VAULT_FOLDER}/${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      console.warn("Unified Browser Core: refused to overwrite unrelated Vault note", path);
      return null;
    }
    const file = await this.app.vault.create(path, serializeMirroredBookmark(bookmark));
    this.files.set(bookmark.id, file);
    const state = this.core.state.vaultBookmarkMirror;
    if (!state.publishedIds.includes(bookmark.id)) {
      state.publishedIds.push(bookmark.id);
      this.core.scheduleSave();
    }
    return file;
  }

  private async removePublished(id: string): Promise<void> {
    const state = this.core.state.vaultBookmarkMirror;
    if (!state.publishedIds.includes(id)) return;
    let file = this.files.get(id);
    if (!file?.parent) {
      const { records } = await this.readManagedFiles();
      file = records.get(id)?.file;
    }
    if (file) await this.app.vault.trash(file, false);
    this.files.delete(id);
    state.publishedIds = state.publishedIds.filter(value => value !== id);
    this.core.scheduleSave();
  }

  dispose(): void {
    this.disposed = true;
    this.unregisters.forEach(dispose => dispose());
    this.unregisters.length = 0;
    this.files.clear();
  }
}
