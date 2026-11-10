import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { BrowserTabSnapshot } from "../api/browser-api";
import type { BrowserTabTreeState } from "../core/model";
import { createId } from "../core/id";
import { promptText } from "./text-prompt";
import { orderedTabTree } from "../tabs/browser-tab-tree-model";

export const BROWSER_TREE_VIEW_TYPE = "ubc-browser-tab-tree";

/** A stable view of the Browser Core tab registry, not a second tab manager.
 * All navigation/activation remains owned by BrowserPublicApi and Obsidian. */
export class ObsidianBrowserTreeView extends ItemView {
  private disposeEvents: (() => void)[] = [];
  private renderScheduled = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(leaf);
  }

  getViewType(): string { return BROWSER_TREE_VIEW_TYPE; }
  getDisplayText(): string { return "Browser tab tree"; }
  getIcon(): string { return "list-tree"; }

  async onOpen(): Promise<void> {
    this.disposeEvents.push(this.plugin.core.events.on("leaf-opened", () => this.scheduleRender()));
    this.disposeEvents.push(this.plugin.core.events.on("leaf-closed", () => this.scheduleRender()));
    this.disposeEvents.push(this.plugin.core.events.on("navigation-committed", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRender()));
    this.render();
  }

  async onClose(): Promise<void> {
    for (const dispose of this.disposeEvents) dispose();
    this.disposeEvents = [];
    this.contentEl.empty();
  }

  private state(): BrowserTabTreeState { return this.plugin.core.state.browserTabTree; }
  private persist(): void { this.plugin.core.scheduleSave(); this.render(); }
  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => { this.renderScheduled = false; this.render(); });
  }

  private async addGroup(): Promise<void> {
    const name = await promptText(this.app, "New browser tab group", "", "Group name");
    if (!name) return;
    this.state().groups.push({ id: createId("tab-group"), name, collapsed: false });
    this.persist();
  }

  private moveTab(id: string, groupId: string | null, beforeId?: string): void {
    const tree = this.state();
    if (groupId && !tree.groups.some(group => group.id === groupId)) return;
    if (groupId) tree.tabToGroup[id] = groupId;
    else delete tree.tabToGroup[id];
    const order = tree.tabOrder.filter(tabId => tabId !== id);
    const position = beforeId ? order.indexOf(beforeId) : -1;
    if (position < 0) order.push(id);
    else order.splice(position, 0, id);
    tree.tabOrder = order;
    this.persist();
  }

  private async saveCurrentWorkspace(): Promise<void> {
    const name = await promptText(this.app, "Save browser workspace", "", "Workspace name");
    if (!name) return;
    const tree = this.state();
    if (tree.savedWorkspaces[name]) { new Notice("That browser workspace name is already in use."); return; }
    tree.savedWorkspaces[name] = {
      savedAt: Date.now(),
      groups: tree.groups.map(group => ({ ...group })),
      tabs: this.plugin.api.tabs().map(tab => ({
        id: tab.id, url: tab.url, title: tab.title, containerId: tab.containerId,
        pinned: tab.pinned, groupId: tree.tabToGroup[tab.id] ?? null,
      })),
    };
    this.persist();
    new Notice(`Browser workspace saved: ${name}`);
  }

  private async restoreWorkspace(name: string): Promise<void> {
    const saved = this.state().savedWorkspaces[name];
    if (!saved) return;
    const tree = this.state();
    const groups = new Map(tree.groups.map(group => [group.id, group]));
    for (const group of saved.groups) if (!groups.has(group.id)) tree.groups.push({ ...group });
    let restored = 0;
    for (const tab of saved.tabs) {
      try {
        const leaf = await this.plugin.openBrowser({
          url: tab.url, containerId: tab.containerId,
          state: { pinned: tab.pinned }, reveal: false,
        });
        leaf.setPinned(tab.pinned);
        const current = leaf.view.getState() as { lifecycleId?: string };
        const id = current.lifecycleId;
        if (id) this.moveTab(id, tab.groupId);
        restored++;
      } catch (error) { console.warn("Unified Browser Core: could not restore browser tab", tab.url, error); }
    }
    this.persist();
    new Notice(`Restored ${restored} browser tabs from ${name}`);
  }

  private render(): void {
    // Obsidian constructs sidebar views before inserting the leaf into the
    // document. Rendering into the detached contentEl is still valid.
    if (!this.contentEl) return;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "ubc-tab-tree" });
    const header = root.createDiv({ cls: "ubc-tab-tree-header" });
    header.createEl("h3", { text: "Browser tabs" });
    const add = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Create browser tab group", title: "Create group" } });
    setIcon(add, "folder-plus");add.addEventListener("click", () => void this.addGroup());
    const save = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Save browser workspace", title: "Save workspace" } });
    setIcon(save, "save");save.addEventListener("click", () => void this.saveCurrentWorkspace());
    const restore = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Restore browser workspace", title: "Restore workspace" } });
    setIcon(restore, "folder-open");restore.addEventListener("click", () => {
      const menu = new Menu();
      for (const name of Object.keys(this.state().savedWorkspaces).sort()) {
        menu.addItem(item => item.setTitle(name).onClick(() => void this.restoreWorkspace(name)));
      }
      menu.addItem(item => item.setTitle("Save current workspace…").onClick(() => void this.saveCurrentWorkspace()));
      const bounds = restore.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left, y: bounds.bottom });
    });
    const tree = this.state();
    const { groups, ungrouped } = orderedTabTree(this.plugin.api.tabs(), tree);
    for (const group of tree.groups) {
      const section = root.createDiv({ cls: "ubc-tab-tree-group" });
      const label = section.createEl("button", { cls: "ubc-tab-tree-group-header", attr: { "aria-expanded": String(!group.collapsed) } });
      const icon = label.createSpan();setIcon(icon, group.collapsed ? "chevron-right" : "chevron-down");
      label.createSpan({ text: group.name });
      label.createSpan({ cls: "ubc-tab-tree-count", text: String(groups.get(group.id)?.length ?? 0) });
      label.addEventListener("click", () => { group.collapsed = !group.collapsed; this.persist(); });
      this.acceptDrop(label, group.id);
      label.addEventListener("contextmenu", event => {
        event.preventDefault();const menu = new Menu();
        menu.addItem(item => item.setTitle("Rename group").onClick(async () => {
          const renamed = await promptText(this.app, "Rename tab group", group.name);
          if (renamed) { group.name = renamed; this.persist(); }
        }));
        menu.addItem(item => item.setTitle("Remove group (keep tabs)").onClick(() => {
          for (const [tabId, groupId] of Object.entries(tree.tabToGroup)) if (groupId === group.id) delete tree.tabToGroup[tabId];
          tree.groups = tree.groups.filter(entry => entry.id !== group.id);this.persist();
        }));
        menu.showAtMouseEvent(event);
      });
      if (!group.collapsed) for (const tab of groups.get(group.id) ?? []) this.renderTab(section, tab, group.id);
    }
    const other = root.createDiv({ cls: "ubc-tab-tree-ungrouped" });
    const label = other.createDiv({ cls: "ubc-tab-tree-group-header", text: `Ungrouped · ${ungrouped.length}` });
    this.acceptDrop(label, null);
    for (const tab of ungrouped) this.renderTab(other, tab, null);
    if (!this.plugin.api.tabs().length) root.createDiv({ cls: "ubc-tab-tree-empty", text: "No browser tabs. Open a browser tab to see it here." });
  }

  private acceptDrop(target: HTMLElement, groupId: string | null, beforeId?: string): void {
    target.addEventListener("dragover", event => {
      if (!event.dataTransfer?.types.includes("application/x-ubc-tab")) return;
      event.preventDefault();event.dataTransfer.dropEffect = "move";
    });
    target.addEventListener("drop", event => {
      const id = event.dataTransfer?.getData("application/x-ubc-tab");
      if (!id || !this.plugin.api.tabs().some(tab => tab.id === id)) return;
      event.preventDefault();event.stopPropagation();
      this.moveTab(id, groupId, beforeId === id ? undefined : beforeId);
    });
  }

  private renderTab(parent: HTMLElement, tab: BrowserTabSnapshot, groupId: string | null): void {
    const item = parent.createDiv({ cls: "ubc-tab-tree-entry" });
    item.draggable = true;
    item.setAttribute("role", "listitem");
    item.setAttribute("aria-label", tab.title || tab.url);
    item.toggleClass("is-active", tab.active);
    const icon = item.createSpan({ cls: "ubc-tab-tree-icon" });
    setIcon(icon, tab.pinned ? "pin" : "globe");
    const text = item.createEl("button", { cls: "ubc-tab-tree-label", attr: { type: "button", title: tab.url } });
    text.createSpan({ text: tab.title || tab.url });
    text.createSpan({ cls: "ubc-tab-tree-url", text: tab.url });
    text.addEventListener("click", () => void this.plugin.api.activateTab(tab.id));
    item.addEventListener("dragstart", event => {
      event.dataTransfer?.setData("application/x-ubc-tab", tab.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    this.acceptDrop(item, groupId, tab.id);
    item.addEventListener("contextmenu", event => {
      event.preventDefault();const menu = new Menu();
      menu.addItem(entry => entry.setTitle("Activate").onClick(() => void this.plugin.api.activateTab(tab.id)));
      menu.addItem(entry => entry.setTitle("Move to Ungrouped").onClick(() => this.moveTab(tab.id, null)));
      for (const group of this.state().groups) {
        menu.addItem(entry => entry.setTitle(`Move to ${group.name}`).onClick(() => this.moveTab(tab.id, group.id)));
      }
      menu.addItem(entry => entry.setTitle("Close tab").onClick(() => this.plugin.api.closeTab(tab.id)));
      menu.showAtMouseEvent(event);
    });
  }
}
