import { PluginSettingTab, Setting, type App } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { TabStyle } from "../core/model";
import { confirmAction } from "../ui/confirm-modal";
import { permissionDecisionLabel, permissionLabel } from "../ui/permission-label";

export class BrowserSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Unified Browser Core").setHeading();

    new Setting(containerEl)
      .setName("Tab style")
      .setDesc("Firefox keeps a readable minimum tab width and overflows horizontally. Chrome compresses tabs more aggressively.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("firefox", "Firefox")
          .addOption("chrome", "Chrome")
          .setValue(this.plugin.core.settings().tabStyle)
          .onChange((value) => {
            this.plugin.core.updateSettings({ tabStyle: value as TabStyle });
            this.plugin.applyTabStyle();
          }),
      );

    new Setting(containerEl)
      .setName("Use Browser Core tab layout")
      .setDesc("Apply the selected browser tab style only to panes that contain Browser Core tabs.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().tabStripIntegrationEnabled)
          .onChange((value) => {
            this.plugin.core.updateSettings({ tabStripIntegrationEnabled: value });
            this.plugin.applyTabStyle();
          }),
      );

    const currentSearchTemplate = this.plugin.core.settings().searchUrlTemplate;
    const currentSearchPreset = searchPresetForTemplate(currentSearchTemplate);
    let customSearchSetting: Setting | undefined;
    const searchEngineSetting = new Setting(containerEl)
      .setName("Web search engine")
      .setDesc("Used when Browser Core treats text as a web search rather than an address.");
    searchEngineSetting.addDropdown((dropdown) => {
      for (const preset of SEARCH_PRESETS) dropdown.addOption(preset.id, preset.name);
      dropdown.addOption("custom", "Custom");
      dropdown
        .setValue(currentSearchPreset?.id ?? "custom")
        .onChange((value) => {
          const preset = SEARCH_PRESETS.find((candidate) => candidate.id === value);
          if (preset) this.plugin.core.updateSettings({ searchUrlTemplate: preset.template });
          if (customSearchSetting) {
            customSearchSetting.settingEl.style.display = value === "custom" ? "" : "none";
          }
        });
    });

    customSearchSetting = new Setting(containerEl)
      .setName("Custom search URL")
      .setDesc("Use {query} where the encoded search text should be inserted.")
      .addText((text) =>
        text
          .setPlaceholder("https://search.example/?q={query}")
          .setValue(currentSearchTemplate)
          .onChange((value) => {
            const template = value.trim();
            if (template.includes("{query}")) this.plugin.core.updateSettings({ searchUrlTemplate: template });
          }),
      );
    customSearchSetting.settingEl.style.display = currentSearchPreset ? "none" : "";

    new Setting(containerEl).setName("Home").setHeading();

    new Setting(containerEl)
      .setName("Replace new empty tabs with Home")
      .setDesc("A newly created empty Obsidian tab becomes the Browser Core Home surface.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().replaceEmptyTabsWithHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ replaceEmptyTabsWithHome: value });
            if (value) void this.plugin.replaceMostRecentEmptyLeafWithHome();
          }),
      );

    new Setting(containerEl)
      .setName("Default Home search")
      .setDesc("Vault searches files in this vault. Web searches the web or opens an address.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("vault", "Vault files")
          .addOption("web", "Web")
          .setValue(this.plugin.core.settings().homeSearchMode)
          .onChange((value) => {
            if (value === "vault" || value === "web") {
              this.plugin.core.updateSettings({ homeSearchMode: value });
              this.plugin.refreshBrowserViews();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Show bookmarked Vault files on Home")
      .setDesc("Reads file bookmarks from Obsidian's built-in Bookmarks plugin without mixing them with web bookmarks.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showVaultBookmarksOnHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showVaultBookmarksOnHome: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl)
      .setName("Show recent Vault files on Home")
      .setDesc("Uses Obsidian's recent-file list; Browser Core does not maintain a duplicate recent-file database.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showRecentVaultFilesOnHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showRecentVaultFilesOnHome: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl)
      .setName("Browser startup")
      .setDesc("Choose what happens when Obsidian starts and no browser tabs are already open.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("restore", "Restore previous browser session")
          .addOption("home", "Open Home")
          .addOption("none", "Do nothing")
          .setValue(this.plugin.core.settings().startupBehavior)
          .onChange((value) => {
            if (value === "restore" || value === "home" || value === "none") {
              this.plugin.core.updateSettings({ startupBehavior: value });
            }
          }),
      );

    new Setting(containerEl).setName("History & recovery").setHeading();

    new Setting(containerEl)
      .setName("History day starts at")
      .setDesc("History day boundaries default to 04:00 so late-night work stays together.")
      .addText((text) => {
        text.inputEl.type = "time";
        text.setValue(formatDayStart(this.plugin.core.settings().historyDayStartMinutes));
        text.onChange((value) => {
          const minutes = parseDayStart(value);
          if (minutes !== undefined) this.plugin.core.updateSettings({ historyDayStartMinutes: minutes });
        });
      });

    new Setting(containerEl)
      .setName("History retention (days)")
      .setDesc("0 keeps browsing history until you delete it. Protected tab histories are not removed automatically.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().historyRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ historyRetentionDays: days });
          }),
      );

    const advancedStorage = containerEl.createEl("details", { cls: "ubc-settings-advanced" });
    advancedStorage.createEl("summary", { text: "Advanced history and recovery storage" });
    const advancedStorageEl = advancedStorage.createDiv({ cls: "ubc-settings-advanced-content" });

    new Setting(advancedStorageEl)
      .setName("Automatic history size limit")
      .setDesc("0 disables size-based cleanup. A positive value allows the oldest closed, unprotected tab histories to be removed when stored history grows past this limit.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().historyMaxNodes))
          .onChange((value) => {
            const count = Number(value);
            if (Number.isFinite(count) && (count === 0 || count >= 1000)) {
              this.plugin.core.updateSettings({ historyMaxNodes: Math.floor(count) });
            }
          }),
      );

    new Setting(containerEl)
      .setName("Detailed tab recovery retention (days)")
      .setDesc("How long Browser Core should keep extra state that can restore recently closed tabs more accurately.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().restoreRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ restoreRetentionDays: days });
          }),
      );

    new Setting(advancedStorageEl)
      .setName("Detailed recovery storage limit (MB)")
      .setDesc("When this budget is exceeded, older unprotected recovery data may fall back to URL-only reopening.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().restoreStorageLimitMb))
          .onChange((value) => {
            const mb = Number(value);
            if (Number.isFinite(mb) && mb >= 16) this.plugin.core.updateSettings({ restoreStorageLimitMb: mb });
          }),
      );

    new Setting(containerEl)
      .setName("Form recovery")
      .setDesc("Allow form recovery as a feature. Capture remains opt-in per site, and password/payment credentials are excluded.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().formRecoveryEnabled)
          .onChange((value) => {
            this.plugin.core.updateSettings({ formRecoveryEnabled: value });
            this.plugin.refreshFormRecoveryInstrumentation();
          }),
      );

    new Setting(containerEl)
      .setName("Form recovery retention (days)")
      .setDesc("How long saved non-credential form values are retained.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().formRecoveryRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ formRecoveryRetentionDays: days });
          }),
      );

    new Setting(advancedStorageEl)
      .setName("Saved form versions per page")
      .setDesc("How many recent recovery versions to keep for one page. Multi-step forms can use values from several versions.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().formRecoveryMaxSnapshotsPerUrl))
          .onChange((value) => {
            const count = Number(value);
            if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxSnapshotsPerUrl: Math.floor(count) });
          }),
      );

    new Setting(advancedStorageEl)
      .setName("Pages with saved form recovery")
      .setDesc("Maximum number of distinct pages that may keep form recovery data.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().formRecoveryMaxUrls))
          .onChange((value) => {
            const count = Number(value);
            if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxUrls: Math.floor(count) });
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("trash")
          .setTooltip("Clear all saved form recovery data")
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear form recovery data",
              "Delete all saved Browser Core form recovery data? Sites that opted in will stay enabled.",
              "Clear form data",
            );
            if (!confirmed) return;
            this.plugin.clearFormRecoveryData();
          }),
      );

    const recoveryPolicies = this.plugin.core.formRecovery.policies();
    if (recoveryPolicies.length) {
      new Setting(containerEl).setName("Form recovery by site").setHeading();
      for (const policy of recoveryPolicies) {
        new Setting(containerEl)
          .setName(`${this.plugin.core.containers.nameFor(policy.containerId)} · ${policy.origin}`)
          .setDesc(
            policy.disabled
              ? "Disabled for this site"
              : `${policy.excludedFieldKeys.length} excluded field(s)`,
          )
          .addExtraButton((button) =>
            button
              .setIcon("rotate-ccw")
              .setTooltip("Reset form recovery for this site")
              .onClick(async () => {
                const confirmed = await confirmAction(
                  this.app,
                  "Reset form recovery for site",
                  `Reset form recovery for ${policy.origin}? This also deletes saved form recovery data for this site.`,
                  "Reset site",
                );
                if (!confirmed) return;
                this.plugin.core.formRecovery.resetPolicy(policy.containerId, policy.origin);
                this.plugin.core.scheduleSave();
                this.display();
              }),
          );
      }
    }

    new Setting(containerEl).setName("Browsing data").setHeading();

    new Setting(containerEl)
      .setName("Clear browsing history")
      .setDesc("Deletes browsing history and detailed recovery data for closed tabs. Open tabs stay open.")
      .addButton((button) =>
        button
          .setButtonText("Clear history")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear browser history",
              "Delete browsing history and detailed closed-tab recovery data? Open tabs, bookmarks, containers, cookies and form recovery remain.",
              "Clear history",
            );
            if (!confirmed) return;
            this.plugin.clearBrowserHistory();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Clear detailed tab recovery")
      .setDesc("Keeps browsing history, but removes extra state used to restore recently closed tabs more accurately. Open tabs start collecting detailed recovery again after they are reopened.")
      .addButton((button) =>
        button
          .setButtonText("Clear recovery data")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear detailed tab recovery",
              "Old tabs will still reopen from durable URLs, but high-fidelity closed-tab restoration will be lost.",
              "Clear recovery data",
            );
            if (!confirmed) return;
            this.plugin.clearRichRestoreData();
          }),
      );

    new Setting(containerEl)
      .setName("Clear form recovery data")
      .setDesc("Deletes all saved non-credential form values without changing which sites have form recovery enabled.")
      .addButton((button) =>
        button
          .setButtonText("Clear form data")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear form recovery data",
              "Delete all saved Browser Core form recovery data?",
              "Clear form data",
            );
            if (!confirmed) return;
            this.plugin.clearFormRecoveryData();
          }),
      );

    new Setting(containerEl)
      .setName("Reset site permissions")
      .setDesc("Returns saved site permissions to Ask next time. Container cookies and site storage are not changed.")
      .addButton((button) =>
        button
          .setButtonText("Reset permissions")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Reset site permissions",
              "Reset all saved site permissions to Ask next time?",
              "Reset permissions",
            );
            if (!confirmed) return;
            this.plugin.clearPermissionDecisions();
            this.display();
          }),
      );

    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Full-page loading shield")
      .setDesc("Cover the web page while a new page starts loading. Off by default to avoid a full-page flash.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().fullPageLoadingShield)
          .onChange((value) => {
            this.plugin.core.updateSettings({ fullPageLoadingShield: value });
            this.plugin.refreshLoadingShields();
          }),
      );

    new Setting(containerEl)
      .setName("Reduced motion")
      .setDesc("Avoid large transitions, slides and parallax in Browser Core UI.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().reducedMotion)
          .onChange((value) => {
            this.plugin.core.updateSettings({ reducedMotion: value });
            this.plugin.applyAccessibilityClasses();
          }),
      );

    new Setting(containerEl)
      .setName("Default web content zoom")
      .setDesc("Used by sites without a site-specific zoom override.")
      .addSlider((slider) =>
        slider
          .setLimits(50, 200, 10)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.core.settings().defaultZoomFactor * 100))
          .onChange((value) => {
            this.plugin.core.updateSettings({ defaultZoomFactor: value / 100 });
            this.plugin.refreshBrowserZoom();
          }),
      );

    new Setting(containerEl)
      .setName("Favorites bar")
      .setDesc("Show only bookmarks marked as favorites beneath the browser toolbar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showFavoritesBar)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showFavoritesBar: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl).setName("Containers").setHeading();
    new Setting(containerEl)
      .setName("Container use")
      .setDesc("Off uses the default browser session only. Manual keeps containers available without automatic site routing. Automatic also applies site default rules.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off")
          .addOption("manual", "Manual")
          .addOption("automatic", "Automatic")
          .setValue(this.plugin.core.settings().containerMode)
          .onChange((value) => {
            this.plugin.core.updateSettings({ containerMode: value as "off" | "manual" | "automatic" });
            this.plugin.refreshContainerPresentation();
            this.display();
          }),
      );
    new Setting(containerEl)
      .setName("Default container")
      .setDesc("Used for new browser tabs when containers are enabled. Automatic mode may replace it with a site's default container.")
      .addDropdown((dropdown) => {
        for (const container of this.plugin.core.containers.list()) {
          dropdown.addOption(container.id, container.name);
        }
        dropdown
          .setValue(this.plugin.core.settings().defaultContainerId)
          .setDisabled(this.plugin.core.settings().containerMode === "off")
          .onChange((value) => this.plugin.core.updateSettings({ defaultContainerId: value }));
      });
    for (const container of this.plugin.core.containers.list()) {
      const row = new Setting(containerEl)
        .setName(container.name)
        .setDesc("Separate persistent login and site data")
        .addText((text) =>
          text
            .setPlaceholder("Container name")
            .setValue(container.name)
            .onChange((value) => {
              const next = value.trim();
              if (!next) return;
              container.name = next;
              this.plugin.core.scheduleSave();
              this.plugin.refreshContainerPresentation();
            }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption("box", "Box")
            .addOption("user-round", "Personal")
            .addOption("briefcase", "Work")
            .addOption("search", "Search")
            .addOption("graduation-cap", "Study")
            .addOption("building-2", "Organization")
            .addOption("shield", "Protected")
            .addOption("heart", "Favorite")
            .setValue(container.icon || "box")
            .onChange((value) => {
              container.icon = value;
              this.plugin.core.scheduleSave();
              this.plugin.refreshContainerPresentation();
            }),
        )
        .addColorPicker((picker) =>
          picker
            .setValue(container.color || "#7f7f7f")
            .onChange((value) => {
              container.color = value;
              this.plugin.core.scheduleSave();
              this.plugin.refreshContainerPresentation();
            }),
        )
        .addExtraButton((button) => {
          button.setIcon("eraser").setTooltip("Clear browsing data and saved permissions");
          button.onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear " + container.name + " browsing data",
              "Clear this container's cookies, site storage, cache, sign-in cache, and saved site permissions? Open pages may need to be reloaded.",
              "Clear browsing data",
            );
            if (!confirmed) return;
            const cleared = await this.plugin.clearContainerSession(container.id);
            if (!cleared) return;
            this.display();
          });
        })
        .addExtraButton((button) => {
          button.setIcon("trash").setTooltip("Delete container");
          button.setDisabled(container.id === "default");
          button.onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Delete container",
              `Delete “${container.name}”? Its cookies, site storage, cache, saved permissions, form recovery data, and site default rules will be cleared. Browsing history will remain.`,
              "Delete container",
            );
            if (!confirmed) return;
            if (await this.plugin.deleteContainer(container.id)) this.display();
          });
        });
      row.settingEl.dataset.containerId = container.id;
    }
    new Setting(containerEl)
      .setName("Add container")
      .setDesc("Creates a separate persistent login and site data.")
      .addButton((button) =>
        button.setButtonText("Add").onClick(() => {
          this.plugin.core.containers.create("Container");
          this.plugin.core.scheduleSave();
          this.display();
        }),
      );

    const assignments = this.plugin.core.containers.assignments();
    if (assignments.length) {
      new Setting(containerEl)
        .setName("Site default containers")
        .setDesc(this.plugin.core.settings().containerMode === "automatic"
          ? "Applied automatically when an independent navigation opens a matching site."
          : "Saved for later, but currently paused because automatic container routing is off.")
        .setHeading();
      for (const rule of assignments) {
        new Setting(containerEl)
          .setName(rule.originPattern)
          .setDesc(this.plugin.core.containers.nameFor(rule.containerId))
          .addExtraButton((button) =>
            button
              .setIcon("x")
              .setTooltip("Forget site default container")
              .onClick(() => {
                this.plugin.core.containers.unassignOrigin(rule.originPattern);
                this.plugin.core.scheduleSave();
                this.display();
              }),
          );
      }
    }

    const permissions = this.plugin.core.permissions.list();
    if (permissions.length) {
      new Setting(containerEl).setName("Site permissions").setHeading();
      for (const record of permissions) {
        new Setting(containerEl)
          .setName(permissionLabel(record.permission))
          .setDesc(`${record.origin} · ${this.plugin.core.containers.nameFor(record.containerId)} · ${permissionDecisionLabel(record.decision)}`)
          .addDropdown((dropdown) =>
            dropdown
              .addOption("ask", "Ask next time")
              .addOption("allow", "Allow")
              .addOption("block", "Block")
              .setValue(record.decision)
              .onChange((value) => {
                if (value === "ask") {
                  this.plugin.core.permissions.remove(record.containerId, record.origin, record.permission);
                } else {
                  this.plugin.core.permissions.set(
                    record.containerId,
                    record.origin,
                    record.permission,
                    value as "allow" | "block",
                  );
                }
                this.plugin.core.scheduleSave();
              }),
          );
      }
    }
  }
}

function formatDayStart(totalMinutes: number): string {
  const normalized = Math.max(0, Math.min(1439, Math.floor(totalMinutes)));
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseDayStart(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

const SEARCH_PRESETS = [
  { id: "google", name: "Google", template: "https://www.google.com/search?q={query}" },
  { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q={query}" },
  { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={query}" },
] as const;

function searchPresetForTemplate(template: string): (typeof SEARCH_PRESETS)[number] | undefined {
  return SEARCH_PRESETS.find((preset) => preset.template === template);
}
