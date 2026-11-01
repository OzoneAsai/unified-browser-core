import { Menu, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { BrowserCore } from "../core/browser-core";
import type { BrowserSettings } from "../core/model";
import { matchesHomeFilter, parseHomeFilter, safeHomeNoteName, type HomeSearchFilter } from "../home/search-model";
import type { ObsidianHomeAdapter, VaultHomeFile } from "../adapters/obsidian-home";
import { t } from "../i18n";

export type HomeSearchMode = BrowserSettings["homeSearchMode"];

export interface HomeSearchHost {
  app: App;
  core: BrowserCore;
  home: ObsidianHomeAdapter;
  openFile(path: string, newTab: boolean): Promise<void> | void;
  webSearch(query: string): Promise<void> | void;
  onModeChange?: (mode: HomeSearchMode) => void;
  onFileCreated?: (file: VaultHomeFile) => void;
}

export interface HomeSearchWidget {
  input: HTMLInputElement;
  dispose(): void;
}

let nextHomeWidgetId = 0;

const matchesNoteFilter = (filter: HomeSearchFilter) =>
  (filter.kind === "type" || filter.kind === "extension") && matchesHomeFilter("md", filter);

/**
 * One search component for browser://home and the `search-bar` Markdown code block.
 * Source selection, active filters, keyboard selection and creation are shared.
 */
export function mountHomeSearch(parent: HTMLElement, host: HomeSearchHost, sections?: HTMLElement): HomeSearchWidget {
  const settings = () => host.core.settings();
  const widgetId = ++nextHomeWidgetId;
  const wrapper = parent.createDiv({ cls: "ubc-home-search-widget" });
  const modePicker = wrapper.createDiv({ cls: "ubc-home-search-modes", attr: { role: "group", "aria-label": t("Home search mode") } });
  const vaultMode = modePicker.createEl("button", { text: t("Vault"), attr: { type: "button" } });
  const omniMode = modePicker.createEl("button", { text: "Omnisearch", attr: { type: "button" } });
  const webMode = modePicker.createEl("button", { text: t("Web"), attr: { type: "button" } });
  const inputRow = wrapper.createDiv({ cls: "ubc-home-search-row" });
  const filterPill = inputRow.createEl("button", { cls: "ubc-home-search-filter is-hidden", attr: { type: "button", "aria-label": t("Clear search filter") } });
  const input = inputRow.createEl("input", { cls: "ubc-home-search", attr: { "aria-label": t("Home search"), type: "search", autocomplete: "off" } });
  const resultsEl = wrapper.createDiv({ cls: "ubc-home-search-results", attr: { role: "listbox", "aria-label": t("Vault search results") } });
  const shortcuts = wrapper.createDiv({ cls: "ubc-home-shortcuts", text: t("↑↓ select · Enter open · Ctrl/⌘+Enter new tab · Shift+Enter create · Tab filter · Esc dismiss") });
  if (!settings().homeShowShortcuts) shortcuts.addClass("is-hidden");
  let mode: HomeSearchMode = settings().homeSearchMode;
  let filter: HomeSearchFilter | undefined;
  let current: VaultHomeFile[] = [];
  let selected = 0;
  let requestId = 0;
  let timer: number | undefined;
  let disposed = false;

  const updateFilter = () => {
    filterPill.toggleClass("is-hidden", !filter);
    filterPill.setText(filter ? filter.value + " ×" : "");
  };
  const clearResults = () => {
    resultsEl.empty();
    current = [];
    selected = 0;
    input.removeAttribute("aria-activedescendant");
    sections?.removeClass("is-hidden");
  };
  const markSelection = () => {
    for (const [index, child] of Array.from(resultsEl.querySelectorAll<HTMLElement>("[data-home-result]")).entries()) {
      const chosen = selected === index;
      child.toggleClass("is-selected", chosen);
      child.setAttribute("aria-selected", String(chosen));
      if (chosen) {
        input.setAttribute("aria-activedescendant", child.id);
        child.scrollIntoView({ block: "nearest" });
      }
    }
  };
  const showResults = (files: VaultHomeFile[], query: string) => {
    if (disposed) return;
    resultsEl.empty();
    current = files;
    selected = 0;
    if (!query) {
      clearResults();
      return;
    }
    sections?.addClass("is-hidden");
    const heading = resultsEl.createDiv({ cls: "ubc-home-results-heading" });
    heading.createEl("strong", { text: files.length ? t("{count} results", { count: files.length }) : t("No vault files found") });
    if (!files.length && mode !== "omnisearch") {
      heading.createSpan({ cls: "ubc-card-subtitle", text: t("Press Shift+Enter to create a note.") });
    }
    for (const [index, item] of files.entries()) {
      const button = resultsEl.createEl("button", {
        cls: "ubc-home-result",
        attr: { id: "ubc-home-result-" + widgetId + "-" + String(requestId) + "-" + index, type: "button", role: "option", "data-home-result": "" },
      });
      const icon = button.createSpan({ cls: "ubc-home-result-icon" });
      setIcon(icon, item.unresolved ? "file-plus" : "file");
      const info = button.createSpan({ cls: "ubc-home-result-info" });
      info.createSpan({ cls: "ubc-home-result-name", text: item.name + (item.unresolved ? " (" + t("Uncreated") + ")" : "") });
      if (settings().homeShowFilePaths) info.createSpan({ cls: "ubc-card-subtitle", text: item.matchedAlias ? item.matchedAlias + " · " + item.path : item.path });
      if (mode === "omnisearch" && settings().homeShowOmnisearchExcerpts && item.excerpt) {
        info.createSpan({ cls: "ubc-card-subtitle", text: item.excerpt.slice(0, 320) });
      }
      button.addEventListener("pointerenter", () => { selected = index; markSelection(); });
      button.addEventListener("click", (event) => { void activate(item, event.metaKey || event.ctrlKey); });
      button.addEventListener("auxclick", (event) => {
        if (event.button === 1) { event.preventDefault(); void activate(item, true); }
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((entry) => entry.setTitle(t("Open")).onClick(() => void activate(item, false)));
        menu.addItem((entry) => entry.setTitle(t("Open in new tab")).onClick(() => void activate(item, true)));
        menu.showAtMouseEvent(event);
      });
    }
    if (!files.length && mode === "vault" && safeHomeNoteName(query) &&
      (!filter || (filter.kind === "type" && filter.value === "markdown") || (filter.kind === "extension" && filter.value === "md"))) {
      const create = resultsEl.createEl("button", { cls: "ubc-home-create", text: t("Create note: {name}", { name: query }) });
      create.addEventListener("click", () => void createNote(false));
    }
    markSelection();
  };

  async function activate(file: VaultHomeFile, newTab: boolean): Promise<void> {
    try {
      if (file.unresolved) {
        const created = await host.home.createNote(file.name, file.path);
        host.onFileCreated?.({ path: created.path, extension: created.extension, name: created.basename });
      }
      await host.openFile(file.path, newTab);
    } catch (error) {
      console.warn("Unified Browser Core: Home could not open a file", error);
      new Notice(t("Could not open that file."));
    }
  }

  async function createNote(newTab: boolean): Promise<void> {
    try {
      const name = safeHomeNoteName(input.value);
      if (!name) {
        new Notice(t("Enter a valid note name."));
        return;
      }
      const file = await host.home.createNote(name);
      host.onFileCreated?.({ path: file.path, name: file.basename, extension: file.extension });
      await host.openFile(file.path, newTab);
    } catch (error) {
      console.warn("Unified Browser Core: could not create note", error);
      new Notice(t("Could not create that note."));
    }
  }

  const render = async () => {
    if (disposed) return;
    const id = ++requestId;
    const query = input.value.trim();
    if (!query || mode === "web" || filter?.kind === "web") {
      clearResults();
      return;
    }
    let files: VaultHomeFile[] = [];
    try {
      if (mode === "omnisearch" || filter?.kind === "omnisearch") {
        files = await host.home.searchOmnisearch(query, settings().homeMaxSearchResults);
      } else {
        files = host.home.searchFiles(query, settings().homeMaxSearchResults, filter,
          settings().homeMarkdownOnly, settings().homeShowUnresolvedLinks);
      }
      if (id !== requestId || disposed) return;
      showResults(files, query);
    } catch (error) {
      if (id === requestId) {
        clearResults();
        console.warn("Unified Browser Core: Home search failed", error);
        new Notice(t("Home search failed."));
      }
    }
  };

  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    const delay = Math.max(0, Math.min(500, settings().homeSearchDelayMs));
    if (delay) timer = window.setTimeout(() => { timer = undefined; void render(); }, delay);
    else void render();
  };
  const setMode = (next: HomeSearchMode, persist = true) => {
    if (next === "omnisearch" && !host.home.hasOmnisearch()) {
      new Notice(t("Omnisearch is not enabled."));
      return;
    }
    mode = next;
    vaultMode.toggleClass("is-active", mode === "vault");
    omniMode.toggleClass("is-active", mode === "omnisearch");
    webMode.toggleClass("is-active", mode === "web");
    for (const [button, name] of [[vaultMode, "vault"], [omniMode, "omnisearch"], [webMode, "web"]] as const) {
      button.setAttribute("aria-pressed", String(name === mode));
    }
    input.placeholder = mode === "web" ? t("Search the web or enter an address") : t("Search files in your vault");
    clearResults();
    if (persist && settings().homeSearchMode !== mode) host.core.updateSettings({ homeSearchMode: mode });
    host.onModeChange?.(mode);
    schedule();
    input.focus();
  };

  vaultMode.addEventListener("click", () => { filter = undefined; updateFilter(); setMode("vault"); });
  omniMode.addEventListener("click", () => { filter = undefined; updateFilter(); setMode("omnisearch"); });
  webMode.addEventListener("click", () => { filter = undefined; updateFilter(); setMode("web"); });
  filterPill.addEventListener("click", () => { filter = undefined; updateFilter(); schedule(); input.focus(); });
  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Tab") {
      const parsed = parseHomeFilter(input.value);
      if (parsed) {
        if (parsed.kind === "omnisearch" && !host.home.hasOmnisearch()) {
          new Notice(t("Omnisearch is not enabled."));
          return;
        }
        event.preventDefault();
        if (parsed.kind === "web") {
          filter = undefined;
          setMode("web");
        } else if (parsed.kind === "omnisearch") {
          filter = undefined;
          setMode("omnisearch");
        } else {
          filter = parsed;
          setMode("vault");
        }
        input.value = "";
        updateFilter();
        clearResults();
      }
      return;
    }
    if (event.key === "Backspace" && !input.value && filter) {
      event.preventDefault();
      filter = undefined;
      updateFilter();
      schedule();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!current.length) return;
      event.preventDefault();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + current.length) % current.length;
      markSelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      ++requestId;
      clearResults();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const newTab = event.ctrlKey || event.metaKey;
      if (mode === "web") {
        if (input.value.trim()) void host.webSearch(input.value.trim());
      } else if (event.shiftKey && mode === "vault" &&
        (!filter || matchesNoteFilter(filter))) {
        void createNote(newTab);
      } else if (current[selected]) {
        const chosen = current[selected];
        if (chosen) void activate(chosen, newTab);
      } else if (mode === "vault" && safeHomeNoteName(input.value) &&
        (!filter || matchesNoteFilter(filter))) {
        void createNote(newTab);
      }
    }
  });
  omniMode.toggleClass("is-hidden", !host.home.hasOmnisearch());
  if (mode === "omnisearch" && !host.home.hasOmnisearch()) mode = "vault";
  setMode(mode, false);
  return {
    input,
    dispose: () => {
      disposed = true;
      ++requestId;
      if (timer !== undefined) window.clearTimeout(timer);
      wrapper.remove();
    },
  };
}
