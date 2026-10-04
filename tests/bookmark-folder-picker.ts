import assert from "node:assert/strict";
import { pickBookmarkFolder } from "../src/ui/folder-picker-modal";
import { BookmarkStore } from "../src/bookmarks/bookmark-store";
import { BrowserCore } from "../src/core/browser-core";

type HostPicker = { onClose(): void; onChooseItem(item: { id: string | null; label: string }): void; getItems(): Array<{ id: string | null; label: string }> };
const host = globalThis as typeof globalThis & { lastFolderPicker: HostPicker };
const store = new BookmarkStore(BrowserCore.normalize(null).bookmarks);
const folder = store.addFolder("Research");
const chosen = pickBookmarkFolder({} as any, store);
// Reproduce Obsidian's close-before-selection ordering.
host.lastFolderPicker.onClose();
host.lastFolderPicker.onChooseItem({ id: folder.id, label: "Research" });
assert.equal(await chosen, folder.id);
const root = pickBookmarkFolder({} as any, store);
host.lastFolderPicker.onClose();
host.lastFolderPicker.onChooseItem({ id: null, label: "Bookmarks root" });
assert.equal(await root, null, "root selection must not become cancellation");
const cancelled = pickBookmarkFolder({} as any, store);
host.lastFolderPicker.onClose();
assert.equal(await cancelled, undefined);
console.log("bookmark folder selection lifecycle passed");
