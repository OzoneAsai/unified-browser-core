import { EditorView } from "@codemirror/view";
import { editorInfoField, type Editor, type Menu, type Plugin, type Workspace } from "obsidian";
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
  registerEditorExtension: Plugin["registerEditorExtension"];
  registerObsidianProtocolHandler: Plugin["registerObsidianProtocolHandler"];
  open: (intent: ObsidianBrowserLinkIntent) => void;
}

type ClickableEditor = Editor & {
  getClickableTokenAt?: (position: { line: number; ch: number }) => { type?: string; text?: string } | null;
};

/** A single UI policy shared by Reading View, Properties, Canvas, and Live Preview. */
export function linkIntentFromDom(target: EventTarget | null, modifiers: { metaKey?: boolean; ctrlKey?: boolean }): ObsidianBrowserLinkIntent | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(".ubc-browser-view, .ubc-embedded-browser, .ubc-hover-preview")) return null;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return null;
  const context = anchor.closest(".metadata-container, .metadata-property, .markdown-rendered, .markdown-preview-view, .markdown-reading-view, .canvas-node");
  if (!context) return null;
  const url = parseObsidianWebLink(anchor.getAttribute("href"));
  if (!url) return null;
  const source: ObsidianBrowserLinkSource = context.closest(".metadata-container, .metadata-property") ? "properties"
    : context.closest(".canvas-node") ? "canvas" : "reading";
  return { url, source, external: Boolean(modifiers.metaKey || modifiers.ctrlKey) };
}

export function linkIntentFromClickableToken(
  editor: ClickableEditor | null | undefined,
  offset: number | null,
  external: boolean,
): ObsidianBrowserLinkIntent | null {
  if (!editor?.getClickableTokenAt || offset === null || offset < 0) return null;
  const token = editor.getClickableTokenAt(editor.offsetToPos(offset));
  if (token?.type !== "external-link") return null;
  const url = parseObsidianWebLink(token.text);
  return url ? { url, source: "live-preview", external } : null;
}

/** Explicit ownership and cleanup; no global window.open or Obsidian prototype patches. */
export function registerObsidianLinkBridge(plugin: ObsidianLinkHost): void {
  const documents = new Map<Document, () => void>();
  const bindDocument = (doc: Document) => {
    if (documents.has(doc)) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const intent = linkIntentFromDom(event.target, event);
      if (!intent) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      plugin.open(intent);
    };
    doc.addEventListener("click", onClick, true);
    documents.set(doc, () => doc.removeEventListener("click", onClick, true));
  };
  bindDocument(document);
  plugin.registerEvent(plugin.app.workspace.on("window-open", (_workspaceWindow, win) => bindDocument(win.document)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
    documents.get(win.document)?.();
    documents.delete(win.document);
  }));
  plugin.register(() => {
    for (const dispose of documents.values()) dispose();
    documents.clear();
  });

  plugin.registerEditorExtension(EditorView.domEventHandlers({
    click(event, view) {
      // The default editing click stays untouched; only Ctrl/Command+click
      // invokes the editor's semantic external-link token resolver.
      if (!event.ctrlKey && !event.metaKey || event.button !== 0 || event.defaultPrevented) return false;
      const fileInfo = view.state.field(editorInfoField, false);
      const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const intent = linkIntentFromClickableToken(fileInfo?.editor as ClickableEditor | undefined, offset, true);
      if (!intent) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      plugin.open(intent);
      return true;
    },
  }));

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
  plugin.registerObsidianProtocolHandler("web-open", params => {
    const url = parseObsidianWebLink(params.url);
    if (url) plugin.open({ url, source: "protocol", external: false });
  });
}
