import assert from "node:assert/strict";
import { BookmarkStore } from "../src/bookmarks/bookmark-store";
import { BrowserEventBus } from "../src/core/events";
import { BOOKMARK_VAULT_FOLDER, ObsidianVaultBookmarkMirror, parseMirroredBookmark } from "../src/integrations/obsidian-vault-bookmark-mirror";
import { TFile, TFolder } from "obsidian";

// Test with a Vault and file manager that preserve the same read/write
// boundaries as Obsidian. The Obsidian module's YAML parser is replaced by a
// strict test parser (JSON scalars & arrays are also valid YAML values).
function parseYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([\w_-]+): (.*)$/u.exec(line);
    if (!match) continue;
    try { result[match[1]!] = JSON.parse(match[2]!); }
    catch { result[match[1]!] = match[2]; }
  }
  return result;
}

class FakeVault {
  private files = new Map<string, { file: TFile; contents: string }>();
  private listeners = new Map<string, Set<(...args: never[]) => void>>();
  readonly folder = new (TFolder as unknown as new (path: string) => TFolder)(BOOKMARK_VAULT_FOLDER);
  getAbstractFileByPath(path: string) {
    if (path === BOOKMARK_VAULT_FOLDER) return this.folder;
    return this.files.get(path)?.file ?? null;
  }
  on(name: string, handler: (...args: never[]) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(handler);this.listeners.set(name,set);
    return { name, handler };
  }
  private emit(name: string, ...args: unknown[]) {
    for (const callback of this.listeners.get(name) ?? []) callback(...args as never[]);
  }
  async createFolder(path: string) { if (path !== BOOKMARK_VAULT_FOLDER) throw new Error("Unexpected folder"); }
  async create(path: string, contents: string) {
    assert.ok(!this.files.has(path), `Refusing overwrite ${path}`);
    const file = new (TFile as unknown as new (path: string, parent: TFolder) => TFile)(path, this.folder);
    this.files.set(path, { file, contents });this.folder.children.push(file);
    this.emit("create", file);return file;
  }
  async cachedRead(file: TFile) { return this.files.get(file.path)!.contents; }
  async modify(file: TFile, content: string) {
    this.files.get(file.path)!.contents = content;
    this.emit("modify", file);
  }
  async trash(file: TFile, _system: boolean) {
    this.files.delete(file.path);this.folder.children = this.folder.children.filter(item => item !== file);
    file.parent = null;this.emit("delete", file);
  }
  async rename(file: TFile, nextPath: string) {
    const prior = file.path;const data = this.files.get(prior)!;
    this.files.delete(prior);file.path = nextPath;this.files.set(nextPath,data);
    this.emit("rename", file, prior);
  }
  contents(file: TFile) { return this.files.get(file.path)?.contents ?? ""; }
}

const bus = new BrowserEventBus();
const state = { bookmarks: {}, folders: {} };
const bookmarks = new BookmarkStore(state, event => bus.emit("bookmark-changed", event));
const mirrorState = { enabled: false, publishedIds: [] as string[] };
const core = { bookmarks, events: bus, state: { vaultBookmarkMirror: mirrorState }, scheduleSave: () => undefined };
const vault = new FakeVault();
const app = {
  vault,
  fileManager: { processFrontMatter: async (file: TFile, update: (fm: Record<string, unknown>) => void) => {
    const contents = vault.contents(file);
    const found = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents)!;
    const metadata = parseYaml(found[1]!);
    update(metadata);
    const serialized = `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${contents.slice(found[0].length)}`;
    await vault.modify(file, serialized);
  } },
};
const host = { registerEvent: (_ref: unknown) => undefined, register: (_dispose: () => void) => undefined };
const createMirror = () => new ObsidianVaultBookmarkMirror(app as never, core as never, () => undefined, host as never);
const initial = bookmarks.addBookmark({ title: "Example", url: "https://example.org/one" });
const mirror = createMirror();
await mirror.setEnabled(true);await mirror.flush();
assert.equal(mirrorState.publishedIds.includes(initial.id), true);
assert.equal(vault.folder.children.length, 1);
const file = vault.folder.children[0] as TFile;
assert.equal(parseMirroredBookmark(vault.contents(file))?.url, "https://example.org/one");

// User edits a frontmatter note: existing bookmark is updated, not duplicated.
await vault.modify(file,vault.contents(file).replace('title: "Example"','title: "From the Vault"'));
await mirror.flush();
assert.equal(bookmarks.getBookmark(initial.id)?.title, "From the Vault");
assert.equal(bookmarks.allBookmarks().length, 1);

// Renames preserve identity and avoid writing a new duplicate file.
await vault.rename(file, `${BOOKMARK_VAULT_FOLDER}/renamed-by-user.md`);
await mirror.flush();
assert.equal(vault.folder.children.length, 1);
bookmarks.updateBookmark(initial.id, { title: "Back from UBC" });
await mirror.flush();
assert.equal(parseMirroredBookmark(vault.contents(file))?.title, "Back from UBC");
assert.equal(vault.folder.children.length, 1);

// Vault note deletion is authoritative only for this explicitly mirrored ID.
await vault.trash(file, true);await mirror.flush();
assert.equal(bookmarks.getBookmark(initial.id), undefined);
assert.equal(vault.folder.children.length, 0);
assert.equal(mirrorState.publishedIds.includes(initial.id), false);

// UBC bookmark deletion must not resurrect itself from its own async Vault event.
const second = bookmarks.addBookmark({ title: "Second", url: "https://example.org/two" });
await mirror.flush();
assert.equal(vault.folder.children.length, 1);
bookmarks.deleteBookmark(second.id);await mirror.flush();
assert.equal(vault.folder.children.length, 0);

// Disabling sync leaves files untouched and does not continue propagating.
const third = bookmarks.addBookmark({ title: "Third", url: "https://example.org/three" });
await mirror.flush();
const thirdFile = vault.folder.children[0] as TFile;
await mirror.setEnabled(false);
await vault.modify(thirdFile, vault.contents(thirdFile).replace('title: "Third"','title: "Edited offline"'));
await mirror.flush();
assert.equal(bookmarks.getBookmark(third.id)?.title, "Third");
await mirror.setEnabled(true);await mirror.flush();
assert.equal(bookmarks.getBookmark(third.id)?.title, "Edited offline");
const soundNote = vault.contents(thirdFile);
const malformedNote = soundNote.replace(/^url:.*$/mu, "url: ");
await vault.modify(thirdFile, malformedNote);await mirror.flush();
assert.ok(bookmarks.getBookmark(third.id), "Malformed YAML must not be interpreted as deletion");
assert.equal(vault.contents(thirdFile), malformedNote, "Broken frontmatter must not be overwritten automatically");
await vault.modify(thirdFile, soundNote);await mirror.flush();
mirror.dispose();
console.log("Vault mirror: create/rename/edit/delete/reload/disable and idempotency passed");
