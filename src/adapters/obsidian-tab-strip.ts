import type { Plugin, WorkspaceLeaf } from "obsidian";
import type { TabLayoutPolicy } from "../tabs/tab-layout-policy";

type TabGroup = { children: WorkspaceLeaf[]; currentTab: number; updateTabDisplay(): void };

export class ObsidianTabStripAdapter {
  private dragging = false;
  private pendingStrips = new Set<HTMLElement>();

  private scheduleStripStyle(strip: HTMLElement): void {
    if (this.pendingStrips.has(strip)) return;
    this.pendingStrips.add(strip);
    strip.ownerDocument.defaultView?.requestAnimationFrame(() => {
      this.pendingStrips.delete(strip);
      if (strip.isConnected) this.refreshStripStyle(strip);
    });
  }

  leavesInSameGroup(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
    const parent = leaf.parent as unknown as { children?: WorkspaceLeaf[] };
    return Array.isArray(parent.children) ? parent.children.filter(Boolean) : [leaf];
  }

  bind(
    plugin: Plugin,
    shouldHandle: (strip: HTMLElement) => boolean,
    onContextMenu: (event: MouseEvent) => void,
  ): void {
    let source: WorkspaceLeaf | undefined;
    let sourceStrip: HTMLElement | undefined;
    let marker: HTMLElement | undefined;
    let insertion = 0;
    const overStrip = (event: DragEvent) => {
      if (!sourceStrip) return false;
      const rect = sourceStrip.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    const clear = () => {
      marker?.removeClass("ubc-drop-before", "ubc-drop-after");
      if (source) this.tabHeader(source)?.removeClass("ubc-tab-dragging");
      source = undefined;
      sourceStrip = undefined;
      marker = undefined;
      this.dragging = false;
    };
    plugin.register(clear);
    plugin.registerDomEvent(document, "dragstart", (event: DragEvent) => {
      const target = event.target as HTMLElement;
      const header = target.closest?.<HTMLElement>(".workspace-tab-header.ubc-browser-tab-layout");
      const strip = header?.parentElement;
      if (!header || !strip?.hasClass("ubc-browser-tab-strip") || event.altKey) return;
      let leaf: WorkspaceLeaf | undefined;
      plugin.app.workspace.iterateAllLeaves((candidate) => { if (this.tabHeader(candidate) === header) leaf = candidate; });
      const group = leaf?.parent as unknown as TabGroup | undefined;
      // Obsidian must receive dragstart so it can own pane drops and split previews.
      // UBC only claims a drag gesture when reordering is possible in this group.
      if (!leaf || this.leavesInSameGroup(leaf).length < 2 || typeof group?.updateTabDisplay !== "function") return;
      clear();
      source = leaf;
      sourceStrip = strip;
      insertion = this.leavesInSameGroup(leaf).indexOf(leaf);
      this.dragging = true;
      header.addClass("ubc-tab-dragging");
    }, true);
    plugin.registerDomEvent(document, "dragover", (event: DragEvent) => {
      if (!source || !sourceStrip || !overStrip(event)) {
        marker?.removeClass("ubc-drop-before", "ubc-drop-after");
        return; // Obsidian's native drag handlers receive all pane movement.
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const others = this.leavesInSameGroup(source).filter((leaf) => leaf !== source);
      insertion = others.findIndex((leaf) => {
        const rect = this.tabHeader(leaf)?.getBoundingClientRect();
        return rect ? event.clientX < rect.left + rect.width / 2 : false;
      });
      if (insertion < 0) insertion = others.length;
      marker?.removeClass("ubc-drop-before", "ubc-drop-after");
      marker = others.length ? this.tabHeader(others[Math.min(insertion, others.length - 1)]!) : undefined;
      marker?.addClass(insertion === others.length ? "ubc-drop-after" : "ubc-drop-before");
      const rect = sourceStrip.getBoundingClientRect();
      if (event.clientX < rect.left + 24) sourceStrip.scrollLeft -= 16;
      else if (event.clientX > rect.right - 24) sourceStrip.scrollLeft += 16;
    }, true);
    plugin.registerDomEvent(document, "drop", (event: DragEvent) => {
      if (!source || !sourceStrip || !overStrip(event)) { clear(); return; }
      event.preventDefault();
      event.stopPropagation();
      const leaf = source;
      const group = leaf.parent as unknown as TabGroup;
      const selected = group.children[group.currentTab];
      const oldIndex = group.children.indexOf(leaf);
      try {
        if (oldIndex >= 0 && oldIndex !== insertion && group.children.length > 1) {
          // Reorder the existing group atomically; never detach the guest while moving it.
          group.children.splice(oldIndex, 1);
          group.children.splice(insertion, 0, leaf);
          group.currentTab = selected ? group.children.indexOf(selected) : insertion;
          group.updateTabDisplay();
        }
      } finally { clear(); }
      plugin.app.workspace.requestSaveLayout();
      plugin.app.workspace.trigger("layout-change");
    }, true);
    plugin.registerDomEvent(document, "dragend", clear, true);
    plugin.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const strip = target.closest<HTMLElement>(".workspace-tab-header-container-inner");
      if (!strip || target.closest(".workspace-tab-header")) return;
      if (!shouldHandle(strip)) return;
      event.preventDefault();
      onContextMenu(event);
    });
  }

  applyLeafStyle(
    leaf: WorkspaceLeaf,
    policy: TabLayoutPolicy,
    enabled: boolean,
    pinned: boolean,
    containerColor?: string,
  ): void {
    if (!enabled) {
      this.clearLeafStyle(leaf);
      return;
    }
    const header = this.tabHeader(leaf);
    if (!header) return;
    header.addClass("ubc-browser-tab");
    header.toggleClass("ubc-browser-tab-pinned", pinned);
    header.toggleClass("ubc-browser-tab-title-adaptive", policy.titleVisibility === "adaptive");
    header.toggleClass("ubc-browser-tab-favicon-priority", policy.faviconPriority);
    header.style.setProperty("--ubc-tab-preferred", `${policy.preferredWidth}px`);
    header.style.setProperty("--ubc-tab-min", `${policy.minimumWidth}px`);
    header.style.setProperty("--ubc-tab-max", `${policy.maximumWidth}px`);
    header.style.setProperty("--ubc-tab-grow", String(policy.flexGrow));
    header.style.setProperty("--ubc-tab-shrink", String(policy.flexShrink));
    header.style.setProperty("--ubc-pinned-tab-width", `${policy.pinnedWidth}px`);
    header.dataset.ubcTabOverflow = policy.overflow;
    if (containerColor) header.style.setProperty("--ubc-tab-container-color", containerColor);
    else header.style.removeProperty("--ubc-tab-container-color");
    const strip = header.parentElement;
    if (!(strip instanceof HTMLElement)) return;
    this.scheduleStripStyle(strip);
  }

  clearLeafStyle(leaf: WorkspaceLeaf): void {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const strip = header.parentElement;
    header.removeClass(
      "ubc-browser-tab",
      "ubc-browser-tab-pending",
      "ubc-browser-tab-layout",
      "ubc-browser-tab-pinned",
      "ubc-browser-tab-title-adaptive",
      "ubc-browser-tab-favicon-priority",
    );
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width",
    ]) header.style.removeProperty(variable);
    delete header.dataset.ubcTabOverflow;
    header.style.removeProperty("--ubc-tab-container-color");
    this.applyLeafFavicon(leaf);
    if (!(strip instanceof HTMLElement)) return;
    this.scheduleStripStyle(strip);
  }

  refreshLeafHeader(leaf: WorkspaceLeaf, activeInWindow = false, savedTitle?: string): void {
    const compatLeaf = leaf as WorkspaceLeaf & {
      updateHeader?: () => void;
      tabHeaderInnerTitleEl?: HTMLElement;
    };
    const title = savedTitle || leaf.view.getDisplayText();
    const viewCompat = leaf.view as typeof leaf.view & { titleEl?: HTMLElement };
    const viewTitleEl = viewCompat.titleEl ?? leaf.view.containerEl.querySelector<HTMLElement>(".view-header-title");
    if (viewTitleEl && viewTitleEl.innerText !== title) viewTitleEl.innerText = title;
    compatLeaf.updateHeader?.();
    if (compatLeaf.tabHeaderInnerTitleEl && compatLeaf.tabHeaderInnerTitleEl.innerText !== title) {
      // Surfing uses the same Obsidian-private element. Keep this compatibility
      // fallback isolated in the adapter so BrowserView never depends on it.
      compatLeaf.tabHeaderInnerTitleEl.innerText = title;
    }
    this.tabHeader(leaf)?.setAttribute("aria-label", title);
    this.tabHeader(leaf)?.setAttribute("title", title);
    if (activeInWindow) {
      const doc = leaf.getContainer().doc;
      const separator = doc.title.indexOf(" - ");
      doc.title = separator >= 0 ? title + doc.title.slice(separator) : title;
    }
  }

  applyLeafFavicon(leaf: WorkspaceLeaf, dataUrl?: string): void {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const icon = header.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
    if (!icon) return;
    icon.querySelector(".ubc-tab-favicon")?.remove();
    header.toggleClass("ubc-browser-tab-has-favicon", Boolean(dataUrl));
    if (!dataUrl) return;
    const image = document.createElement("img");
    image.className = "ubc-tab-favicon";
    image.alt = "";
    image.src = dataUrl;
    icon.appendChild(image);
  }

  revealActiveTab(leaf: WorkspaceLeaf): void {
    const header = this.tabHeader(leaf);
    const strip = header?.parentElement;
    if (!header || !(strip instanceof HTMLElement) || !strip.hasClass("ubc-browser-tab-strip-scroll")) return;
    window.requestAnimationFrame(() => {
      if (!header.isConnected || !strip.isConnected || !header.hasClass("is-active")) return;
      const headerRect = header.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      if (headerRect.left < stripRect.left) strip.scrollLeft += headerRect.left - stripRect.left;
      else if (headerRect.right > stripRect.right) strip.scrollLeft += headerRect.right - stripRect.right;
    });
  }

  private tabHeader(leaf: WorkspaceLeaf): HTMLElement | undefined {
    return (leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
  }

  private refreshStripStyle(strip: HTMLElement): void {
    strip.removeClass(
      "ubc-browser-tab-strip",
      "ubc-browser-tab-strip-scroll",
      "ubc-browser-tab-strip-compress",
    );
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width",
    ]) strip.style.removeProperty(variable);
    const headers = [...strip.querySelectorAll<HTMLElement>(".workspace-tab-header")];
    for (const header of headers) header.removeClass("ubc-browser-tab-layout");
    const browserHeaders = headers.filter((header) => header.hasClass("ubc-browser-tab"));
    if (!headers.length || !browserHeaders.length) return;
    const overflowModes = new Set(browserHeaders.map((header) => header.dataset.ubcTabOverflow).filter(Boolean));
    if (overflowModes.size !== 1) return;
    const mode = [...overflowModes][0];
    const source = browserHeaders[0];
    if (!source) return;
    for (const variable of [
      "--ubc-tab-preferred",
      "--ubc-tab-min",
      "--ubc-tab-max",
      "--ubc-tab-grow",
      "--ubc-tab-shrink",
      "--ubc-pinned-tab-width",
    ]) {
      const value = source.style.getPropertyValue(variable);
      if (value) strip.style.setProperty(variable, value);
    }
    for (const header of headers) header.addClass("ubc-browser-tab-layout");
    strip.addClass("ubc-browser-tab-strip");
    strip.addClass(mode === "horizontal-scroll" ? "ubc-browser-tab-strip-scroll" : "ubc-browser-tab-strip-compress");
  }
}
