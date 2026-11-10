import { type Editor, type EditorPosition, type MarkdownView, type Menu, type Plugin, type Workspace } from "obsidian";
import { parseObsidianWebLink } from "./obsidian-link-policy";
export { parseObsidianWebLink } from "./obsidian-link-policy";

export type ObsidianBrowserLinkSource = "reading" | "live-preview" | "properties" | "canvas" | "url-menu" | "editor-menu" | "protocol";

export interface ObsidianBrowserLinkIntent {
  url: string;
  source: ObsidianBrowserLinkSource;
  external: boolean;
}

export interface ObsidianLinkHost {
  app: { workspace: Workspace };
  register: Plugin["register"];
  registerEvent: Plugin["registerEvent"];
  registerObsidianProtocolHandler: Plugin["registerObsidianProtocolHandler"];
  claimSurfingProtocol: boolean;
  open: (intent: ObsidianBrowserLinkIntent) => void;
  preview: (anchor: Element, intent: ObsidianBrowserLinkIntent) => void;
  leavePreview: (anchor: Element) => void;
  closePreview: () => void;
}

type ClickableEditor = Editor & {
  getClickableTokenAt?: (position: EditorPosition) => { type?: string; text?: string } | null;
  posAtCoords?: (x: number, y: number) => EditorPosition | null;
};

/** Window popouts have their own DOM prototypes, so instanceof Element from
 * the main Obsidian window does not identify elements belonging to a popout. */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && typeof (target as Element).closest === "function"
    && (target as Node).nodeType === 1;
}

function isWithin(anchor: Element, target: EventTarget | null): boolean {
  return !!target && typeof (target as Node).nodeType === "number"
    && anchor.contains(target as Node);
}

/** A single UI policy shared by Reading View, Properties, Canvas, and Live Preview. */
export function linkIntentFromDom(target: EventTarget | null, modifiers: { metaKey?: boolean; ctrlKey?: boolean }): ObsidianBrowserLinkIntent | null {
  if (!isElement(target)) return null;
  if (target.closest(".ubc-browser-view, .ubc-embedded-browser, .ubc-hover-preview")) return null;
  // Reading View uses <a href>, whereas Obsidian Properties renders URL
  // values as .metadata-link-inner[data-href] without an anchor element.
  const anchor = target.closest<HTMLElement>("a[href], .metadata-link-inner[data-href]");
  if (!anchor) return null;
  const context = anchor.closest(".metadata-container, .metadata-property, .markdown-rendered, .markdown-preview-view, .markdown-reading-view, .canvas-node");
  if (!context) return null;
  const url = parseObsidianWebLink(anchor.getAttribute("href") ?? anchor.getAttribute("data-href"));
  if (!url) return null;
  const source: ObsidianBrowserLinkSource = context.closest(".metadata-container, .metadata-property") ? "properties"
    : context.closest(".canvas-node") ? "canvas" : "reading";
  return { url, source, external: Boolean(modifiers.metaKey || modifiers.ctrlKey) };
}

export function linkIntentFromClickableToken(
  editor: ClickableEditor | null | undefined,
  position: EditorPosition | null,
  external: boolean,
): ObsidianBrowserLinkIntent | null {
  if (!editor?.getClickableTokenAt || !position) return null;
  const token = editor.getClickableTokenAt(position);
  if (token?.type !== "external-link") return null;
  const url = parseObsidianWebLink(token.text);
  return url ? { url, source: "live-preview", external } : null;
}

export function linkIntentFromEditorDom(workspace: Workspace, target: Element, x: number, y: number, external: boolean): ObsidianBrowserLinkIntent | null {
  // Resolve a *rendered hyperlink*, never arbitrary source text.  A markdown
  // editor is still a text editor: a click on raw markup must place a caret,
  // whereas a click on its rendered .cm-underline label activates the link.
  // Both normal click and Mod-click share this semantic token path.
  if (!target.closest(".cm-link .cm-underline") ||
      !target.closest(".markdown-source-view") ||
      target.closest(".ubc-browser-view")) return null;
  const leaf = workspace.getLeavesOfType("markdown").find(candidate => candidate.view.containerEl?.contains(target));
  const editor = (leaf?.view as MarkdownView | undefined)?.editor as ClickableEditor | undefined;
  return linkIntentFromClickableToken(editor, editor?.posAtCoords?.(x, y) ?? null, external);
}

/** Explicit ownership and cleanup; no global window.open or Obsidian prototype patches. */
export function registerObsidianLinkBridge(plugin: ObsidianLinkHost): void {
  const documents = new Map<Document, () => void>();
  const bindDocument = (doc: Document) => {
    if (documents.has(doc)) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      let intent = linkIntentFromDom(event.target, event);
      if (!intent && isElement(event.target)) {
        intent = linkIntentFromEditorDom(
          plugin.app.workspace, event.target, event.clientX, event.clientY,
          Boolean(event.metaKey || event.ctrlKey),
        );
      }
      if (!intent) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      plugin.open(intent);
    };
    const onPointerOver = (event: PointerEvent) => {
      if (!isElement(event.target)) return;
      const anchor = event.target.closest("a[href], .metadata-link-inner[data-href], .cm-underline");
      if (!anchor || isWithin(anchor, event.relatedTarget)) return;
      const intent = linkIntentFromDom(anchor, event) ??
        linkIntentFromEditorDom(plugin.app.workspace, anchor, event.clientX, event.clientY, false);
      if (intent) plugin.preview(anchor, intent);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!isElement(event.target)) return;
      const anchor = event.target.closest("a[href], .metadata-link-inner[data-href], .cm-underline");
      if (anchor && !isWithin(anchor, event.relatedTarget)) plugin.leavePreview(anchor);
    };
    const onScroll = () => plugin.closePreview();
    const onVisibilityChange = () => {
      if (doc.hidden) plugin.closePreview();
    };
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("pointerover", onPointerOver, true);
    doc.addEventListener("pointerout", onPointerOut, true);
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("visibilitychange", onVisibilityChange);
    documents.set(doc, () => {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("pointerover", onPointerOver, true);
      doc.removeEventListener("pointerout", onPointerOut, true);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
    });
  };
  bindDocument(document);
  // Reloading the plugin while a popout is already open does not emit a new
  // `window-open` event. Discover those documents from actual workspace leaves
  // instead of relying on the window creation event as the only entry point.
  const bindExistingDocuments = () => plugin.app.workspace.iterateAllLeaves(leaf => {
    const doc = leaf.view.containerEl?.ownerDocument;
    if (doc) bindDocument(doc);
  });
  bindExistingDocuments();
  plugin.registerEvent(plugin.app.workspace.on("layout-change", bindExistingDocuments));
  plugin.registerEvent(plugin.app.workspace.on("window-open", (_workspaceWindow, win) => bindDocument(win.document)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
    documents.get(win.document)?.();
    documents.delete(win.document);
  }));
  plugin.register(() => {
    for (const dispose of documents.values()) dispose();
    documents.clear();
  });

  plugin.registerEvent(plugin.app.workspace.on("url-menu", (menu: Menu, url: string) => {
    const parsed = parseObsidianWebLink(url);
    if (!parsed) return;
    menu.addItem(item => item.setTitle("Open in Unified Browser Core").setIcon("globe")
      .onClick(() => plugin.open({ url: parsed, source: "url-menu", external: false })));
  }));
  plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
    const text = (editor as ClickableEditor).getClickableTokenAt?.(editor.getCursor());
    const url = text?.type === "external-link" ? parseObsidianWebLink(text.text) : null;
    if (!url) return;
    menu.addItem(item => item.setTitle("Open link in Unified Browser Core").setIcon("globe")
      .onClick(() => plugin.open({ url, source: "editor-menu", external: false })));
  }));
  if (plugin.claimSurfingProtocol) {
    plugin.registerObsidianProtocolHandler("web-open", params => {
      const url = parseObsidianWebLink(params.url);
      if (url) plugin.open({ url, source: "protocol", external: false });
    });
  }
}
