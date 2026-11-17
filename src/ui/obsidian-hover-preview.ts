import { HoverPopover, type HoverParent, type WorkspaceLeaf } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import { obsidianPagePreviewEnabled } from "../integrations/obsidian-core-ownership";
import { EmbeddedBrowser } from "./embedded-browser";

type HoverPopoverLifecycle = HoverPopover & {
  targetEl?: HTMLElement;
  hide: () => void;
  onShow: () => void;
  onHide: () => void;
};
type ViewWithHoverParents = WorkspaceLeaf["view"] & {
  hoverPopover?: HoverPopover | null;
  previewMode?: HoverParent;
  editMode?: HoverParent;
};

/**
 * Web previews use Obsidian's native HoverPopover state machine and Page
 * Preview enablement. UBC owns only the managed browser guest rendered inside
 * the popover after Obsidian decides it should actually be shown.
 */
export class ObsidianHoverPreview {
  private anchor: Element | null = null;
  private url = "";
  private popover: HoverPopoverLifecycle | undefined;
  private component: EmbeddedBrowser | undefined;
  private parent: HoverParent | undefined;
  private readonly fallbackParent: HoverParent = { hoverPopover: null };

  constructor(private readonly plugin: UnifiedBrowserCorePlugin) {}

  enter(anchor: Element, url: string): void {
    if (!obsidianPagePreviewEnabled(this.plugin.app) || anchor.ownerDocument.hidden) {
      this.close();
      return;
    }
    if (this.anchor === anchor && this.url === url && this.popover) return;
    this.close();

    const target = anchor as HTMLElement;
    const parent = this.resolveHoverParent(anchor);
    const existing = parent.hoverPopover as HoverPopoverLifecycle | null;
    // Native Page Preview already owns this hover parent: do not stack another popover.
    if (existing?.hoverEl?.isConnected) return;

    // Construct immediately while the pointer is still over the target. The
    // native popover owns the 550 ms show/hide delay and cancels itself if the
    // target is left before that delay expires.
    const popover = new HoverPopover(parent, target, 550) as HoverPopoverLifecycle;
    const nativeOnShow = popover.onShow.bind(popover);
    const nativeOnHide = popover.onHide.bind(popover);

    popover.onShow = () => {
      nativeOnShow();
      if (this.popover !== popover || this.plugin.isUnloading() || !obsidianPagePreviewEnabled(this.plugin.app)) {
        popover.hide();
        return;
      }
      popover.hoverEl.addClass("ubc-hover-preview");
      popover.hoverEl.setAttribute("aria-label", "Web link preview");
      const pane = popover.hoverEl.createDiv({ cls: "ubc-hover-preview-content" });
      const component = new EmbeddedBrowser(pane, this.plugin, url);
      this.component = component;
      component.load();
    };
    popover.onHide = () => {
      this.disposeComponent();
      nativeOnHide();
      if (this.popover === popover) {
        this.popover = undefined;
        this.parent = undefined;
        this.anchor = null;
        this.url = "";
      }
    };

    this.anchor = anchor;
    this.url = url;
    this.parent = parent;
    this.popover = popover;
  }

  /** Native HoverPopover handles target/popup mouseout; this hook is kept for router symmetry. */
  leave(anchor: Element): void {
    if (this.anchor !== anchor) return;
  }

  close(): void {
    const popover = this.popover;
    if (popover) {
      try { popover.hide(); } catch { this.disposeComponent(); }
    } else {
      this.disposeComponent();
    }
    const parent = this.parent;
    if (parent && parent.hoverPopover === popover) parent.hoverPopover = null;
    this.popover = undefined;
    this.parent = undefined;
    this.anchor = null;
    this.url = "";
  }

  private disposeComponent(): void {
    this.component?.unload();
    this.component = undefined;
  }

  private resolveHoverParent(anchor: Element): HoverParent {
    let found: HoverParent | undefined;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (found || !leaf.view.containerEl?.contains(anchor)) return;
      const view = leaf.view as ViewWithHoverParents;
      for (const candidate of [view.previewMode, view.editMode, view]) {
        if (candidate && "hoverPopover" in candidate) {
          found = candidate as HoverParent;
          break;
        }
      }
    });
    return found ?? this.fallbackParent;
  }
}
