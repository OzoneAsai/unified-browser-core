import type { Menu } from "obsidian";

const openMenus = new Map<Document, Set<Menu>>();
const installedDocuments = new WeakSet<Document>();
const trackedMenus = new WeakSet<Menu>();

/** Keep transient browser menus dismissible from both the host UI and guest page. */
export function showDismissibleMenu(menu: Menu, show: () => void, doc: Document = document): void {
  dismissOpenMenus(doc);
  trackDismissibleMenu(menu, doc);
  show();
}

/** Track menus created by Obsidian itself, such as the pane header menu. */
export function trackDismissibleMenu(menu: Menu, doc: Document = document): void {
  if (trackedMenus.has(menu)) return;
  trackedMenus.add(menu);
  let menus = openMenus.get(doc);
  if (!menus) {
    menus = new Set<Menu>();
    openMenus.set(doc, menus);
  }
  menus.add(menu);
  menu.onHide(() => {
    menus?.delete(menu);
    if (menus?.size === 0) openMenus.delete(doc);
  });
  if (!installedDocuments.has(doc)) {
    installedDocuments.add(doc);
    doc.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu")) return;
      dismissOpenMenus(doc);
    }, true);
  }
}

export function dismissOpenMenus(doc: Document = document): void {
  for (const menu of [...(openMenus.get(doc) ?? [])]) menu.hide();
}
