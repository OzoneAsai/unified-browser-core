import type { App } from "obsidian";

type CommandHost = {
  executeCommandById?: (id: string) => boolean | void;
  commands?: Record<string, unknown>;
};

export class ObsidianCommandAdapter {
  has(app: App, id: string): boolean {
    const host = (app as App & { commands?: CommandHost }).commands;
    return Boolean(host?.commands && id in host.commands);
  }

  execute(app: App, id: string): boolean {
    const host = (app as App & { commands?: CommandHost }).commands;
    if (!host?.executeCommandById) return false;
    const result = host.executeCommandById(id);
    return result !== false;
  }

  openQuickSwitcher(app: App): boolean {
    return this.execute(app, "switcher:open");
  }
}
