import type { Menu, MenuItem } from "obsidian";

/** The same command list works with submenu-capable and legacy Obsidian builds. */
export function addHierarchicalMenuSection(
  menu: Menu,
  title: string,
  icon: string,
  appendCommands: (target: Menu) => void,
): void {
  let submenu: Menu | undefined;
  menu.addItem((entry) => {
    entry.setTitle(title).setIcon(icon);
    const withSubmenu = entry as MenuItem & { setSubmenu?: () => Menu };
    if (typeof withSubmenu.setSubmenu === "function") {
      submenu = withSubmenu.setSubmenu();
    } else {
      entry.setIsLabel(true);
    }
  });
  if (!submenu) menu.addSeparator();
  appendCommands(submenu ?? menu);
}
