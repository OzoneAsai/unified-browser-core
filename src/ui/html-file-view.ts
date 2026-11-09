import { FileSystemAdapter, FileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type UnifiedBrowserCorePlugin from "../main";

export const UBC_HTML_FILE_VIEW = "ubc-html-file-view";

/** Obsidian file type adapter: a local HTML vault file becomes a managed browser tab. */
export class UbcHtmlFileView extends FileView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(leaf);
    this.allowNoFile = false;
  }

  getViewType(): string { return UBC_HTML_FILE_VIEW; }
  getDisplayText(): string { return this.file?.basename ?? "HTML browser view"; }
  canAcceptExtension(extension: string): boolean { return extension === "html" || extension === "htm"; }

  async onLoadFile(file: TFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const url = pathToFileURL(join(adapter.getBasePath(), file.path)).href;
    await this.plugin.openBrowser({ url });
    if (this.leaf.view === this) this.leaf.detach();
  }
}
