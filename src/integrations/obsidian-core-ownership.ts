import type { App } from "obsidian";

type InternalCorePlugin = { enabled?: boolean };
type AppWithInternalPlugins = App & {
  internalPlugins?: {
    getPluginById?: (id: string) => InternalCorePlugin | null | undefined;
    plugins?: Record<string, InternalCorePlugin | undefined>;
  };
};

/** Read one Obsidian core-plugin ownership bit without assuming the private registry shape. */
export function isObsidianCorePluginEnabled(app: App, id: string): boolean {
  const internal = (app as AppWithInternalPlugins).internalPlugins;
  const plugin = internal?.getPluginById?.(id) ?? internal?.plugins?.[id];
  return plugin?.enabled === true;
}

/** External HTTP(S) links belong to Core Web Viewer while that core plugin is enabled. */
export function ubcOwnsObsidianWebLinks(app: App): boolean {
  return !isObsidianCorePluginEnabled(app, "webviewer");
}

/** Web hover UI follows the user's Page Preview core-plugin enablement. */
export function obsidianPagePreviewEnabled(app: App): boolean {
  return isObsidianCorePluginEnabled(app, "page-preview");
}
