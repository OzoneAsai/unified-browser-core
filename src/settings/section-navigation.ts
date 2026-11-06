import { t } from "../i18n";

/** Derive the local table of contents from the real, translated Settings headings. */
export function renderSettingsSectionNavigation(container: HTMLElement): void {
  const headings = Array.from(container.querySelectorAll<HTMLElement>(".setting-item-heading"));
  if (headings.length <= 1) return;
  const rootHeading = headings[0];
  if (!rootHeading) return;
  const nav = container.createEl("nav", {
    cls: "ubc-settings-section-nav",
    attr: { "aria-label": t("Settings sections") },
  });
  const destinationCount = headings.length - 1;
  headings.slice(1).forEach((heading, index) => {
    const name = heading.querySelector<HTMLElement>(".setting-item-name")?.textContent?.trim();
    if (!name) return;
    heading.id = `ubc-settings-section-${index}`;
    heading.addClass("ubc-settings-section-target");
    const button = nav.createEl("button", {
      text: name,
      attr: { type: "button", "aria-controls": heading.id, title: name },
    });
    button.addEventListener("click", () => {
      heading.scrollIntoView({ block: "start", behavior: "auto" });
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    });
  });
  if (destinationCount > 0) rootHeading.after(nav);
  else nav.remove();
}
