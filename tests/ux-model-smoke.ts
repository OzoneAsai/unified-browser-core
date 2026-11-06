import { strict as assert } from "node:assert";
import type { BookmarkEntry, BookmarkFolder } from "../src/core/model";
import { bookmarksForPresentation, partitionBookmarkChildren } from "../src/bookmarks/bookmark-presentation";
import { addHierarchicalMenuSection } from "../src/ui/menu-groups";

const bookmark = (id: string, favorite: boolean, order: number, favoriteOrder?: number) =>
  ({ id, title: id, url: `https://example.org/${id}`, kind: "bookmark", order, favorite, favoriteOrder }) as BookmarkEntry;
const folder = (id: string) => ({ id, title: id, kind: "folder" }) as BookmarkFolder;

const items = [bookmark("unselected", false, 0), bookmark("later", true, 2, 7), bookmark("earlier", true, 1, 1)];
const snapshot = items.map((item) => item.id);
assert.deepEqual(bookmarksForPresentation(items, "selected").map((item) => item.id), ["earlier", "later"]);
assert.deepEqual(bookmarksForPresentation(items, "manage").map((item) => item.id), ["earlier", "later", "unselected"]);
assert.deepEqual(bookmarksForPresentation(items, "type").map((item) => item.id), snapshot);
assert.deepEqual(items.map((item) => item.id), snapshot, "presentation must not mutate persisted ordering");

const children = [folder("empty1"), folder("populated"), folder("empty2"), bookmark("loose", false, 3)];
const partition = partitionBookmarkChildren(children, (id) => id === "populated" ? 3 : 0);
assert.deepEqual(partition.main.map((item) => item.id), ["populated", "loose"]);
assert.deepEqual(partition.empty.map((item) => item.id), ["empty1", "empty2"]);
assert.deepEqual(children.map((item) => item.id), ["empty1", "populated", "empty2", "loose"], "folder grouping does not reorder core data");

class FakeMenu {
  readonly entries: { label?: string; icon?: string; isLabel?: boolean; submenu?: FakeMenu; separator?: boolean }[] = [];
  constructor(private readonly supportsSubmenu: boolean) {}
  addItem(setup: (entry: unknown) => void): void {
    const record: (typeof this.entries)[number] = {};
    this.entries.push(record);
    const menu = this;
    const entry = {
      setTitle(label: string) { record.label = label; return this; },
      setIcon(icon: string) { record.icon = icon; return this; },
      setIsLabel(value: boolean) { record.isLabel = value; return this; },
      ...(this.supportsSubmenu ? {
        setSubmenu() { record.submenu = new FakeMenu(menu.supportsSubmenu); return record.submenu; },
      } : {}),
    };
    setup(entry);
  }
  addSeparator(): void { this.entries.push({ separator: true }); }
}
for (const supportsSubmenu of [true, false]) {
  const menu = new FakeMenu(supportsSubmenu);
  addHierarchicalMenuSection(menu as never, "Page tools", "sliders-horizontal", (target) => {
    (target as unknown as FakeMenu).addItem((entry: unknown) => {
      (entry as {setTitle(v: string): void}).setTitle("Zoom in");
    });
  });
  assert.equal(menu.entries[0]?.label, "Page tools");
  if (supportsSubmenu) {
    assert.equal(menu.entries.length, 1);
    assert.equal(menu.entries[0]?.submenu?.entries[0]?.label, "Zoom in");
  } else {
    assert.equal(menu.entries[0]?.isLabel, true);
    assert.equal(menu.entries[1]?.separator, true);
    assert.equal(menu.entries[2]?.label, "Zoom in", "fallback must keep all commands accessible");
  }
}
console.log("UX presentation and menu compatibility tests passed");
