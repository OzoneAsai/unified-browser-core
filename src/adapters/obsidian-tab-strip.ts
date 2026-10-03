import type { Plugin, WorkspaceLeaf } from "obsidian";
import type { TabLayoutPolicy } from "../tabs/tab-layout-policy";

export class ObsidianTabStripAdapter {
  leavesInSameGroup(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
    const parent = leaf.parent as unknown as { children?: WorkspaceLeaf[] };
    return Array.isArray(parent.children) ? parent.children.filter(Boolean) : [leaf];
  }

  bind(
    plugin: Plugin,
    shouldHandle: (strip: HTMLElement) => boolean,
    onContextMenu: (event: MouseEvent) => void,
  ): void {
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
    this.refreshStripStyle(strip);
  }

  clearLeafStyle(leaf: WorkspaceLeaf): void {
    const header = this.tabHeader(leaf);
    if (!header) return;
    const strip = header.parentElement;
    header.removeClass(
      "ubc-browser-tab",
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
    window.requestAnimationFrame(() => {
      this.refreshStripStyle(strip);
    });
  }

  refreshLeafHeader(leaf: WorkspaceLeaf, activeInWindow = false): void {
    const compatLeaf = leaf as WorkspaceLeaf & {
      updateHeader?: () => void;
      tabHeaderInnerTitleEl?: HTMLElement;
    };
    const title = leaf.view.getDisplayText();
    const viewCompat = leaf.view as typeof leaf.view & { titleEl?: HTMLElement };
    const viewTitleEl = viewCompat.titleEl ?? leaf.view.containerEl.querySelector<HTMLElement>(".view-header-title");
    if (viewTitleEl && viewTitleEl.innerText !== title) viewTitleEl.innerText = title;
    compatLeaf.updateHeader?.();
    if (compatLeaf.tabHeaderInnerTitleEl && compatLeaf.tabHeaderInnerTitleEl.innerText !== title) {
      // Surfing uses the same Obsidian-private element. Keep this compatibility
      // fallback isolated in the adapter so BrowserView never depends on it.
      compatLeaf.tabHeaderInnerTitleEl.innerText = title;
    }
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
