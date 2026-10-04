import { t } from "../i18n";
import { FuzzySuggestModal, Menu, Notice, type App, type FuzzyMatch, type WorkspaceLeaf } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import { BrowserView, BROWSER_VIEW_TYPE } from "./browser-view";

type TabSearchItem = {
  leaf: WorkspaceLeaf;
  title: string;
  url: string;
  domain: string;
  container: string;
  containerId: string;
  pinned: boolean;
  active: boolean;
  sameWindow: boolean;
  lastActiveAt: number;
};

export class TabSearchModal extends FuzzySuggestModal<TabSearchItem> {
  constructor(app: App, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(app);
    this.setPlaceholder(
      plugin.core.settings().containerMode === "off"
        ? "Search browser tabs by title, URL, domain, or pinned state"
        : "Search browser tabs by title, URL, domain, container, or pinned state",
    );
    this.setInstructions([
      { command: "↑↓", purpose: "Navigate" },
      { command: "↵", purpose: "Switch tab" },
      { command: "Right click", purpose: "Tab actions" },
    ]);
    this.emptyStateText = "No matching browser tabs.";
  }

  onOpen(): void {
    super.onOpen();
    const bridge = this.resultContainerEl.ownerDocument.createElement("div");
    bridge.className = "ubc-tab-search-bridge";
    const text = bridge.createDiv({ cls: "ubc-tab-search-bridge-copy" });
    text.createEl("strong", { text: t("Looking for a Vault file?") });
    text.createSpan({ text: t("Use Obsidian's Quick Switcher for notes and files.") });
    const button = bridge.createEl("button", {
      text: t("Quick Switcher"),
      attr: { type: "button", "aria-label": t("Open Obsidian Quick Switcher") },
    });
    button.disabled = !this.plugin.commandAdapter.has(this.app, "switcher:open");
    button.addEventListener("click", () => {
      if (button.disabled) return;
      this.close();
      const hostWindow = this.modalEl.ownerDocument.defaultView ?? window;
      hostWindow.requestAnimationFrame(() => this.plugin.openQuickSwitcher());
    });
    this.resultContainerEl.before(bridge);
  }

  getItems(): TabSearchItem[] {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    const activeDocument = activeLeaf?.view.containerEl.ownerDocument;
    return this.plugin.app.workspace.getLeavesOfType(BROWSER_VIEW_TYPE).flatMap((leaf) => {
      if (!(leaf.view instanceof BrowserView)) return [];
      const state = leaf.view.getState();
      const lifecycleId = state.lifecycleId || leaf.view.lifecycleIdentity();
      const record = this.plugin.core.state.history.leaves[lifecycleId];
      const containerId = this.plugin.core.normalizeContainer(state.containerId);
      let domain = "";
      try {
        const parsed = new URL(leaf.view.currentUrl());
        domain = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : "";
      } catch {
        domain = "";
      }
      return [{
        leaf,
        title: leaf.view.getDisplayText(),
        url: leaf.view.currentUrl(),
        domain,
        container: this.plugin.core.containers.nameFor(containerId),
        containerId,
        pinned: Boolean(state.pinned),
        active: leaf === activeLeaf,
        sameWindow: !activeDocument || leaf.view.containerEl.ownerDocument === activeDocument,
        lastActiveAt: record?.lastActiveAt ?? 0,
      }];
    }).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getItemText(item: TabSearchItem): string {
    return [
      item.title,
      item.url,
      item.domain,
      this.plugin.core.settings().containerMode === "off" ? "" : item.container,
      item.pinned ? "pinned pin" : "unpinned",
      item.active ? "current active" : "",
      item.sameWindow ? "" : "other window",
    ].filter(Boolean).join(" ");
  }

  renderSuggestion(match: FuzzyMatch<TabSearchItem>, el: HTMLElement): void {
    el.empty();
    const primary = el.createDiv({ cls: "ubc-tab-search-primary" });
    primary.createEl("strong", { text: match.item.title || "Browser tab" });
    primary.createSpan({
      cls: "ubc-tab-search-url",
      text: match.item.url.startsWith("browser://") ? t("Browser Core page") : match.item.url,
    });
    const meta = el.createDiv({ cls: "ubc-tab-search-meta" });
    const parts = [
      match.item.pinned ? "Pinned" : "",
      match.item.active ? "Current" : "",
      !match.item.sameWindow ? "Other window" : "",
      this.plugin.core.settings().containerMode === "off" ? "" : match.item.container,
      match.item.domain,
      match.item.lastActiveAt ? relativeTime(match.item.lastActiveAt) : "",
    ].filter(Boolean);
    meta.setText(parts.join(" · "));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const { leaf, title, url } = match.item;
      const view = leaf.view instanceof BrowserView ? leaf.view : undefined;
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(t("Switch to tab")).setIcon("mouse-pointer-click").onClick(() => this.plugin.app.workspace.revealLeaf(leaf)));
      menu.addItem((item) => item.setTitle(match.item.pinned ? t("Unpin") : t("Pin")).setIcon("pin").onClick(() => leaf.setPinned(!match.item.pinned)));
      menu.addItem((item) => item.setTitle(t("Move to new window")).setIcon("picture-in-picture").onClick(() => {
        try {
          this.plugin.app.workspace.moveLeafToPopout(leaf);
        } catch {
          new Notice(t("This Obsidian build cannot move the tab to a new window."));
        }
      }));
      if (view) {
        if (this.plugin.core.settings().containerMode !== "off") {
          for (const container of this.plugin.core.containers.list()) {
            menu.addItem((item) =>
              item
                .setTitle("Reopen in " + container.name)
                .setIcon("box")
                .setDisabled(container.id === match.item.containerId)
                .onClick(() => view.reopenInContainer(container.id)),
            );
          }
        }
        if (!url.startsWith("browser://")) {
          const bookmark = this.plugin.core.bookmarks.findByUrl(url);
          menu.addItem((item) => item.setTitle(bookmark ? t("Remove bookmark") : t("Bookmark")).setIcon(bookmark ? "bookmark-check" : "bookmark").onClick(() => {
            this.plugin.core.bookmarks.toggleBookmark({ title, url });
            this.plugin.core.scheduleSave();
            this.plugin.refreshBrowserViews();
          }));
          menu.addItem((item) => item.setTitle(t("Copy URL")).setIcon("copy").onClick(() => {
            void navigator.clipboard.writeText(url);
          }));
        }
      }
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(t("Open Quick Switcher")).setIcon("file-search-2").onClick(() => {
        this.close();
        const hostWindow = this.modalEl.ownerDocument.defaultView ?? window;
        hostWindow.requestAnimationFrame(() => this.plugin.openQuickSwitcher());
      }));
      menu.addItem((item) => item.setTitle(t("Close tab")).setIcon("x").onClick(() => leaf.detach()));
      menu.showAtMouseEvent(event);
    });
  }

  onChooseItem(item: TabSearchItem): void {
    this.plugin.app.workspace.revealLeaf(item.leaf);
  }
}

function relativeTime(timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
