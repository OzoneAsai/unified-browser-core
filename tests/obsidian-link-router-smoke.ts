import assert from "node:assert/strict";
import {
  linkIntentFromClickableToken,
  linkIntentFromDom,
  linkIntentFromEditorDom,
} from "../src/integrations/obsidian-link-router";
import type { Workspace } from "obsidian";

// These mock DOM nodes deliberately do not inherit from the main window's
// global Element.  Popout windows have separate DOM prototypes, and links in
// those windows must still be recognized by our delegated listener.
class DomNode {
  readonly nodeType = 1;
  private matches = new Map<string, DomNode | null>();
  private attrs = new Map<string, string>();
  constructor(attrs: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }
  maps(selector: string, target: DomNode | null = this): this {
    this.matches.set(selector, target);
    return this;
  }
  closest(selector: string): DomNode | null { return this.matches.get(selector) ?? null; }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
}

const excluded = ".ubc-browser-view, .ubc-embedded-browser, .ubc-hover-preview";
const address = "a[href], .metadata-link-inner[data-href]";
const container = ".metadata-container, .metadata-property, .markdown-rendered, .markdown-preview-view, .markdown-reading-view, .canvas-node";
const metadata = ".metadata-container, .metadata-property";

const preview = new DomNode().maps(metadata, null).maps(".canvas-node", null);
const link = new DomNode({ href: "https://example.org/notes" }).maps(excluded, null)
  .maps(address).maps(container, preview);
assert.deepEqual(linkIntentFromDom(link as unknown as Element, {}), {
  url: "https://example.org/notes", source: "reading", external: false,
});
assert.deepEqual(linkIntentFromDom(link as unknown as Element, { metaKey: true }), {
  url: "https://example.org/notes", source: "reading", external: true,
});

const property = new DomNode().maps(metadata);
const urlProperty = new DomNode({ "data-href": "https://example.org/property" })
  .maps(excluded, null).maps(address).maps(container, property);
assert.deepEqual(linkIntentFromDom(urlProperty as unknown as Element, {}), {
  url: "https://example.org/property", source: "properties", external: false,
});

const canvas = new DomNode().maps(metadata, null).maps(".canvas-node");
const canvasLink = new DomNode({ href: "https://example.org/canvas" })
  .maps(excluded, null).maps(address).maps(container, canvas);
assert.equal(linkIntentFromDom(canvasLink as unknown as Element, {})?.source, "canvas");

for (const href of ["mailto:person@example.org", "obsidian://open?vault=QA", "javascript:alert(1)", "[[local note]]"] ) {
  const native = new DomNode({ href }).maps(excluded, null).maps(address).maps(container, preview);
  assert.equal(linkIntentFromDom(native as unknown as Element, {}), null, href);
}
const withinBrowser = new DomNode({ href: "https://example.org" }).maps(excluded)
  .maps(address).maps(container, preview);
assert.equal(linkIntentFromDom(withinBrowser as unknown as Element, {}), null);
assert.equal(linkIntentFromDom(null, {}), null);

const rendered = new DomNode().maps(".cm-link .cm-underline")
  .maps(".markdown-source-view").maps(".ubc-browser-view", null);
const editor = {
  posAtCoords: (_x: number, _y: number) => ({ line: 5, ch: 16 }),
  getClickableTokenAt: (_pos: { line: number; ch: number }) => ({
    type: "external-link", text: "https://example.org/from-editor",
  }),
};
const workspace = {
  getLeavesOfType: () => [{ view: { containerEl: { contains: (node: unknown) => node === rendered }, editor } }],
} as unknown as Workspace;
assert.deepEqual(linkIntentFromEditorDom(workspace, rendered as unknown as Element, 5, 15, false), {
  url: "https://example.org/from-editor", source: "live-preview", external: false,
});
assert.equal(linkIntentFromEditorDom(workspace, rendered as unknown as Element, 5, 15, true)?.external, true);

const rawSourceText = new DomNode().maps(".cm-link .cm-underline", null)
  .maps(".markdown-source-view");
assert.equal(linkIntentFromEditorDom(workspace, rawSourceText as unknown as Element, 5, 15, false), null);
assert.equal(linkIntentFromClickableToken({ getClickableTokenAt: () => ({ type: "internal-link", text: "https://example.org" }) } as never,
  { line: 1, ch: 0 }, false), null);
assert.equal(linkIntentFromClickableToken({ getClickableTokenAt: () => ({ type: "external-link", text: "mailto:x@y.tld" }) } as never,
  { line: 1, ch: 0 }, false), null);

console.log("Obsidian delegated link routing, cross-window DOM, and editor ownership passed");
