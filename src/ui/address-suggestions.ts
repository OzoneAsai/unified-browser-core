import type { BrowserCore } from "../core/browser-core";
import { t } from "../i18n";

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
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");
  let choices: { url: string; title: string; source: string }[] = [];
  let selected = -1;
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
  const update = () => {
    const query = input.value.trim().toLocaleLowerCase();
    list.empty(); selected = -1;
    if (!query) { close(); return; }
    const candidates = new Map<string, { url: string; title: string; source: string }>();
    const add = (url: string, title: string, source: string) => {
      if (!/^https?:\/\//i.test(url) || candidates.has(url)) return;
      if ((title + " " + url).toLocaleLowerCase().includes(query)) candidates.set(url, { url, title, source });
    };
    for (const bookmark of core.bookmarks.allBookmarks()) add(bookmark.url, bookmark.title, t("Bookmarks"));
    for (const node of core.history.allNodes().sort((a, b) => b.timestamp - a.timestamp)) {
      if (node.kind === "navigation") add(node.url, node.title, t("History"));
    }
    choices = [...candidates.values()].slice(0, 8);
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
    if (event.key === "Escape") { close(); event.preventDefault(); return; }
    if (list.hasClass("is-hidden")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopImmediatePropagation();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      highlight();
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault(); event.stopImmediatePropagation();
      const choice = choices[selected]; if (!choice) return; input.value = choice.url; close(); navigate(choice.url);
    } else if (event.key === "Enter" || event.key === "Tab") close();
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", keydown, true);
  input.addEventListener("blur", close);
  close();
  return () => { input.removeEventListener("input", update); input.removeEventListener("keydown", keydown, true); input.removeEventListener("blur", close); list.remove(); };
}
