import type { BrowserTabSnapshot } from "../api/browser-api";
import type { BrowserTabTreeState } from "../core/model";

/** Stable order and grouping without changing Obsidian's physical tabs. */
export function orderedTabTree(tabs: BrowserTabSnapshot[], tree: BrowserTabTreeState) {
  const order = new Map(tree.tabOrder.map((id, index) => [id, index]));
  const sorted = [...tabs].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const groups = new Map<string, BrowserTabSnapshot[]>();
  for (const group of tree.groups) groups.set(group.id, []);
  const ungrouped: BrowserTabSnapshot[] = [];
  for (const tab of sorted) {
    const assigned = tree.tabToGroup[tab.id];
    const target = assigned ? groups.get(assigned) : undefined;
    if (target) target.push(tab);
    else ungrouped.push(tab);
  }
  return { groups, ungrouped };
}
