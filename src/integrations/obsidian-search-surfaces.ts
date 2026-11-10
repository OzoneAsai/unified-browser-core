import { setIcon, type Plugin, type Workspace } from "obsidian";
import { normalizeBrowserAddress } from "../navigation/address-normalizer";

export interface ObsidianSearchSurfaceHost {
  app: { workspace: Workspace };
  core: { settings: () => { replaceEmptyTabsWithHome: boolean }; searchUrl: (query: string) => string };
  openBrowser: (request: { url: string }) => Promise<unknown>;
  registerEvent: Plugin["registerEvent"];
  register: Plugin["register"];
}

/** Native Obsidian empty-tab search UI, mounted only while that view is empty.
 * Home Tab and Markdown headers are not globally patched. */
export function registerObsidianSearchSurfaces(host: ObsidianSearchSurfaceHost): void {
  const widgets = new Map<HTMLElement, HTMLElement>();
  let scheduled = false;
  const render = () => {
    scheduled = false;
    const roots = new Set<HTMLElement>();
    if (!host.core.settings().replaceEmptyTabsWithHome) {
      for (const leaf of host.app.workspace.getLeavesOfType("empty")) {
        const root = leaf.view.containerEl.querySelector<HTMLElement>(".empty-state-container");
        if (root) roots.add(root);
      }
    }
    for (const [root, widget] of widgets) {
      if (roots.has(root) && root.isConnected) continue;
      widget.remove();widgets.delete(root);
    }
    for (const root of roots) {
      if (widgets.has(root)) continue;
      const form = root.createEl("form", { cls: "ubc-obsidian-empty-search", attr: { role: "search" } });
      const icon = form.createSpan({ cls: "ubc-obsidian-empty-search-icon" });
      setIcon(icon, "search");
      const input = form.createEl("input", { attr: {
        type: "search", "aria-label": "Search the web with UBC", placeholder: "Search the web or enter a URL",
        autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      } });
      form.addEventListener("submit", event => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        const url = normalizeBrowserAddress(text, query => host.core.searchUrl(query));
        void host.openBrowser({ url });
      });
      widgets.set(root, form);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  };
  host.registerEvent(host.app.workspace.on("layout-change", schedule));
  host.register(() => {
    for (const widget of widgets.values()) widget.remove();
    widgets.clear();
  });
  schedule();
}
