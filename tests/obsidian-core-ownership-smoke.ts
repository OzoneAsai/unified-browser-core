import assert from "node:assert/strict";
import { isObsidianCorePluginEnabled, obsidianPagePreviewEnabled, ubcOwnsObsidianWebLinks } from "../src/integrations/obsidian-core-ownership";

const app = {
  internalPlugins: {
    plugins: {
      webviewer: { enabled: true },
      "page-preview": { enabled: true },
    },
    getPluginById(id: string) {
      return this.plugins[id as keyof typeof this.plugins];
    },
  },
} as never;

assert.equal(isObsidianCorePluginEnabled(app, "webviewer"), true);
assert.equal(ubcOwnsObsidianWebLinks(app), false);
assert.equal(obsidianPagePreviewEnabled(app), true);
(app as any).internalPlugins.plugins.webviewer.enabled = false;
assert.equal(ubcOwnsObsidianWebLinks(app), true);
(app as any).internalPlugins.plugins["page-preview"].enabled = false;
assert.equal(obsidianPagePreviewEnabled(app), false);
assert.equal(isObsidianCorePluginEnabled({} as never, "webviewer"), false);

console.log("Obsidian core-plugin ownership regression tests passed");
