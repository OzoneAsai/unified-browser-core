import type { BrowserCore } from "../core/browser-core";
import { t } from "../i18n";

export type HistoryVisit = { url: string; timestamp: number };
export type HistoryHostSuggestion = { host: string; visits: number; lastVisited: number };

export function completionHistoryVisits(nodes: readonly {
  kind: string; url?: string; residualKind?: string; fromUrl?: string; timestamp: number
}[]): HistoryVisit[] {
  return nodes.flatMap(node => {
    if (node.kind === "navigation" && node.url) return [{url:node.url, timestamp:node.timestamp}];
    if (node.kind === "residual" && node.residualKind === "redirect" && node.fromUrl) {
      return [{url:node.fromUrl, timestamp:node.timestamp}];
    }
    return [];
  });
}

/** Rank only previously visited hosts by visit count and recency.
 * No network lookup, bundled domain list or site-specific exceptions. */
export function rankedHistoryHosts(
  typed: string,
  history: readonly HistoryVisit[],
): HistoryHostSuggestion[] {
  const query = typed.trim().toLowerCase();
  if (!query || /\s/.test(query) || /[^a-z0-9.-]/.test(query)) return [];
  const hosts = new Map<string, HistoryHostSuggestion>();
  for (const visit of history) {
    let host: string;
    try {
      const url = new URL(visit.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      host = url.hostname.toLowerCase().replace(/^www\./, "");
    } catch { continue; }
    if (!host.startsWith(query) || host.length <= query.length) continue;
    const previous = hosts.get(host);
    if (previous) {
      previous.visits += 1;
      previous.lastVisited = Math.max(previous.lastVisited, visit.timestamp);
    } else hosts.set(host, { host, visits: 1, lastVisited: visit.timestamp });
  }
  return [...hosts.values()].sort((a, b) =>
    b.visits - a.visits || b.lastVisited - a.lastVisited || a.host.localeCompare(b.host)).slice(0, 12);
}

/** Chrome-style host completion without sending typed text to a remote API. */
export function inlineAddressCompletion(typed: string, hosts: Iterable<string>): string | undefined {
  const query = typed.trim();
  if (!query || /\s/.test(query) || /^(?:https?:\/\/|browser:)/i.test(query) || /[/?#@]/.test(query)) return;
  for (const host of hosts) {
    const clean = host.replace(/^www\./i, "").toLowerCase();
    if (clean.length > query.length && clean.startsWith(query.toLowerCase())) return typed + clean.slice(query.length);
  }
}

/** Local suggestions never send typed addresses to a remote service. */
export function bindAddressSuggestions(input: HTMLInputElement, core: BrowserCore, navigate: (value: string) => void): () => void {
  const doc = input.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "ubc-address-wrapper";
  input.replaceWith(wrapper);
  wrapper.appendChild(input);
  const list = wrapper.createDiv({ cls: "ubc-address-suggestions is-hidden", attr: { role: "listbox" } });
  list.id = `ubc-suggestions-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "both");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");
  let choices: { url: string; title: string; source: string }[] = [];
  let selected = -1;
  let inlinePrefix = "";
  const historyVisits = (): HistoryVisit[] => completionHistoryVisits(core.history.allNodes());
  const hostsFor = (query: string): HistoryHostSuggestion[] =>
    rankedHistoryHosts(query, historyVisits());
  const hasInlineSelection = () => Boolean(inlinePrefix && input.selectionStart === inlinePrefix.length && input.selectionEnd === input.value.length && input.value.length > inlinePrefix.length);
  const close = () => {
    list.addClass("is-hidden"); input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant"); selected = -1;
  };
  const highlight = () => {
    [...list.children].forEach((row, index) => {
      row.classList.toggle("is-selected", index === selected);
      row.setAttribute("aria-selected", String(index === selected));
    });
    if (selected >= 0) { const row = list.children[selected] as HTMLElement; input.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const update = (event?: Event) => {
    const raw = input.value;
    const query = raw.trim().toLocaleLowerCase();
    list.empty(); selected = -1;
    inlinePrefix = "";
    if (!query) { close(); return; }
    const candidates = new Map<string, { url: string; title: string; source: string }>();
    const add = (url: string, title: string, source: string) => {
      if (!/^https?:\/\//i.test(url) || candidates.has(url)) return;
      if ((title + " " + url).toLocaleLowerCase().includes(query)) candidates.set(url, { url, title, source });
    };
    for (const result of hostsFor(query)) add(`https://${result.host}/`, result.host, t("History"));
    for (const bookmark of core.bookmarks.allBookmarks()) add(bookmark.url, bookmark.title, t("Bookmarks"));
    for (const node of core.history.allNodes().sort((a, b) => b.timestamp - a.timestamp)) {
      if (node.kind === "navigation") add(node.url, node.title, t("History"));
    }
    choices = [...candidates.values()].slice(0, 8);
    const inputEvent = event as InputEvent | undefined;
    const cursorAtEnd = input.selectionStart === raw.length && input.selectionEnd === raw.length;
    if (cursorAtEnd && !inputEvent?.isComposing && !inputEvent?.inputType?.startsWith("delete")) {
      const completion = inlineAddressCompletion(raw, hostsFor(query).map(item => item.host));
      if (completion) {
        inlinePrefix = raw;
        input.value = completion;
        input.setSelectionRange(raw.length, completion.length);
      }
    }
    for (const [index, choice] of choices.entries()) {
      const row = list.createDiv({ cls: "ubc-address-suggestion", attr: { role: "option", id: `${list.id}-${index}`, "aria-selected": "false" } });
      row.createDiv({ cls: "ubc-suggestion-title", text: choice.title || choice.url });
      row.createDiv({ cls: "ubc-suggestion-url", text: choice.url });
      row.createSpan({ cls: "ubc-suggestion-source", text: choice.source });
      row.addEventListener("pointerdown", (event) => { event.preventDefault(); input.value = choice.url; close(); navigate(choice.url); });
    }
    list.toggleClass("is-hidden", !choices.length);
    input.setAttribute("aria-expanded", String(Boolean(choices.length)));
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      if (hasInlineSelection()) input.value = inlinePrefix;
      inlinePrefix = ""; close(); event.preventDefault(); return;
    }
    if ((event.key === "Tab" || event.key === "ArrowRight") && hasInlineSelection()) {
      event.preventDefault(); event.stopImmediatePropagation();
      input.setSelectionRange(input.value.length, input.value.length); inlinePrefix = "";
      close(); return;
    }
    if (list.hasClass("is-hidden")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopImmediatePropagation();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      highlight();
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault(); event.stopImmediatePropagation();
      const choice = choices[selected]; if (!choice) return; input.value = choice.url; close(); navigate(choice.url);
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (hasInlineSelection()) input.setSelectionRange(input.value.length, input.value.length);
      inlinePrefix = ""; close();
    }
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", keydown, true);
  const blur = () => { if (hasInlineSelection()) input.value = inlinePrefix; inlinePrefix = ""; close(); };
  input.addEventListener("blur", blur);
  close();
  return () => { input.removeEventListener("input", update); input.removeEventListener("keydown", keydown, true); input.removeEventListener("blur", blur); list.remove(); };
}
