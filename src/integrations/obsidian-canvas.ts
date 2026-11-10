import { setIcon, type Plugin, type Workspace } from "obsidian";
import { parseObsidianWebLink } from "./obsidian-link-policy";

export interface ObsidianCanvasHost {
  app: { workspace: Workspace };
  register: Plugin["register"];
  registerEvent: Plugin["registerEvent"];
  openUrl: (url: string) => void;
}

/**
 * Obsidian 1.15 already creates WebViews inside Canvas link nodes. Do not
 * duplicate the native WebView or monkey-patch its private node prototype.
 * Add a scoped action to open the same URL with UBC's own session/container.
 */
export function registerObsidianCanvasBrowserActions(host: ObsidianCanvasHost): void {
  const observers = new Map<HTMLElement, MutationObserver>();
  const actions = new Map<HTMLElement, HTMLButtonElement>();
  let scheduled = false;

  const scan = () => {
    scheduled = false;
    const roots = new Set<HTMLElement>();
    for (const leaf of host.app.workspace.getLeavesOfType("canvas")) {
      const canvas = leaf.view.containerEl.querySelector<HTMLElement>(".canvas");
      if (canvas) roots.add(canvas);
    }
    for (const [root, observer] of observers) {
      if (roots.has(root) && root.isConnected) continue;
      observer.disconnect();
      observers.delete(root);
    }
    for (const [node, action] of actions) {
      if (node.isConnected && [...roots].some(root => root.contains(node))) continue;
      action.remove();
      actions.delete(node);
    }
    for (const root of roots) {
      if (!observers.has(root)) {
        const observer = new MutationObserver(() => schedule());
        observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
        observers.set(root, observer);
      }
      for (const node of root.querySelectorAll<HTMLElement>(".canvas-node")) {
        const guest = node.querySelector<HTMLElement>(".canvas-node-content webview[src]");
        const url = parseObsidianWebLink(guest?.getAttribute("src"));
        const existing = actions.get(node);
        if (!url) { if (existing) { existing.remove(); actions.delete(node); } continue; }
        if (existing) continue;
        const parent = node.querySelector<HTMLElement>(".canvas-node-container") ?? node;
        const button = parent.createEl("button", {
          cls: "ubc-canvas-browser-action clickable-icon",
          attr: { type: "button", title: "Open Canvas link in Unified Browser Core", "aria-label": "Open Canvas link in Unified Browser Core" },
        });
        setIcon(button, "globe");
        const cancel = (event: Event) => { event.stopPropagation(); };
        for (const type of ["pointerdown", "mousedown", "mouseup"] as const) button.addEventListener(type, cancel);
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          const current = parseObsidianWebLink(node.querySelector(".canvas-node-content webview")?.getAttribute("src"));
          if (current) host.openUrl(current);
        });
        actions.set(node, button);
      }
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // Installing the link action is an event/state transition, not painting.
    // A hidden Obsidian window may suspend animation frames indefinitely;
    // coalesce mutations in a microtask so reopening a Canvas works even if
    // its nodes were restored while that window was in the background.
    queueMicrotask(scan);
  };
  host.registerEvent(host.app.workspace.on("layout-change", schedule));
  host.registerEvent(host.app.workspace.on("file-open", schedule));
  host.register(() => {
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
    for (const button of actions.values()) button.remove();
    actions.clear();
  });
  schedule();
}
