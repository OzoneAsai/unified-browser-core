import { MarkdownRenderChild, Notice, type App, type WorkspaceLeaf } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import { mountHomeSearch, type HomeSearchWidget } from "./home-search-widget";
import { normalizeBrowserAddress } from "../navigation/address-normalizer";
import type { VaultHomeFile } from "../adapters/obsidian-home";
import { t } from "../i18n";

/**
 * ```search-bar
 * only search bar
 * show starred files
 * show recent files
 * ```
 *
 * The original Home Tab spelling "show bookmarked files" is also supported.
 */
export class EmbeddedHomeSearch extends MarkdownRenderChild {
  private widget?: HomeSearchWidget;
  private readonly directives: Set<string>;

  constructor(container: HTMLElement, private readonly plugin: UnifiedBrowserCorePlugin, source: string) {
    super(container);
    this.directives = new Set(source.split(/\r?\n/).map((line) => line.trim().toLowerCase()));
  }

  onload(): void {
    const el = this.containerEl.createDiv({ cls: "ubc-home-embedded" });
    if (!this.directives.has("only search bar")) el.createEl("h3", { text: this.plugin.core.settings().homeTitle || t("Home") });
    this.widget = mountHomeSearch(el, {
      app: this.plugin.app,
      core: this.plugin.core,
      home: this.plugin.homeAdapter,
      openFile: async (path, newTab) => {
        const leaf = this.plugin.app.workspace.getMostRecentLeaf() ?? this.plugin.app.workspace.getLeaf("tab");
        await this.plugin.homeAdapter.openFile(leaf, path, newTab);
      },
      webSearch: async (query) => {
        await this.plugin.openBrowser({
          url: normalizeBrowserAddress(query, (term) => this.plugin.core.searchUrl(term)),
        });
      },
    });
    if (this.directives.has("show starred files") || this.directives.has("show bookmarked files")) {
      this.renderFiles(el, t("Bookmarked files"), this.plugin.homeAdapter.bookmarkedFiles(this.plugin.core.settings().homeMaxBookmarkedFiles));
    }
    if (this.directives.has("show recent files")) {
      this.renderFiles(el, t("Recent files"), this.plugin.homeAdapter.recentFiles(
        this.plugin.core.settings().homeMaxRecentFiles, this.plugin.core.settings().homeHiddenRecentPaths));
    }
  }

  private renderFiles(parent: HTMLElement, title: string, files: VaultHomeFile[]): void {
    if (!files.length) return;
    parent.createEl("h4", { text: title });
    const list = parent.createDiv({ cls: "ubc-home-embedded-files" });
    for (const file of files) {
      const item = list.createEl("button", { text: file.name, attr: { type: "button", title: file.path } });
      item.addEventListener("click", async (event) => {
        const leaf: WorkspaceLeaf = this.plugin.app.workspace.getMostRecentLeaf() ?? this.plugin.app.workspace.getLeaf("tab");
        const opened = await this.plugin.homeAdapter.openFile(leaf, file.path, event.ctrlKey || event.metaKey);
        if (!opened) new Notice(t("That file is no longer available."));
      });
    }
  }

  onunload(): void {
    this.widget?.dispose();
    this.widget = undefined;
    this.containerEl.empty();
  }
}
