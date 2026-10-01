import type { TabStyle } from "../core/model";

export interface TabLayoutPolicy {
  preferredWidth: number;
  minimumWidth: number;
  maximumWidth: number;
  flexGrow: number;
  flexShrink: number;
  overflow: "horizontal-scroll" | "compress";
  pinnedWidth: number;
  titleVisibility: "full" | "adaptive";
  faviconPriority: boolean;
}

const PRESETS: Record<TabStyle, Readonly<TabLayoutPolicy>> = {
  firefox: {
    preferredWidth: 180,
    minimumWidth: 110,
    maximumWidth: 240,
    flexGrow: 0,
    flexShrink: 1,
    overflow: "horizontal-scroll",
    pinnedWidth: 44,
    titleVisibility: "full",
    faviconPriority: true,
  },
  chrome: {
    preferredWidth: 180,
    minimumWidth: 44,
    maximumWidth: 240,
    flexGrow: 1,
    flexShrink: 1,
    overflow: "compress",
    pinnedWidth: 44,
    titleVisibility: "adaptive",
    faviconPriority: true,
  },
};

export function resolveTabLayoutPolicy(style: TabStyle): TabLayoutPolicy {
  return { ...PRESETS[style] };
}
