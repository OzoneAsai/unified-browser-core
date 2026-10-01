import type { App } from "obsidian";

type SettingsHost = {
  open?: () => void;
  openTabById?: (id: string) => void;
};

export class ObsidianSettingsAdapter {
  openPluginSettings(app: App, pluginId: string): boolean {
    const host = (app as App & { setting?: SettingsHost }).setting;
    if (!host?.open) return false;
    host.open();
    host.openTabById?.(pluginId);
    return true;
  }
}
