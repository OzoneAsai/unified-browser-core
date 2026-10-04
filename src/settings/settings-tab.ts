import { PluginSettingTab, Setting, type App } from "obsidian";
import type UnifiedBrowserCorePlugin from "../main";
import type { TabStyle } from "../core/model";
import { confirmAction } from "../ui/confirm-modal";
import { permissionDecisionLabel, permissionLabel } from "../ui/permission-label";
import { t, setLanguage } from "../i18n";

export class BrowserSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: UnifiedBrowserCorePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(t("Unified Browser Core")).setHeading();
    new Setting(containerEl)
      .setName(t("Language"))
      .setDesc(t("Choose the language used by Browser Core."))
      .addDropdown((dropdown) => dropdown
        .addOption("auto", t("Follow Obsidian"))
        .addOption("en", t("English"))
        .addOption("ja", "日本語")
        .setValue(this.plugin.core.settings().language)
        .onChange((value) => {
          const language = value as "auto" | "en" | "ja";
          this.plugin.core.updateSettings({ language }); setLanguage(language);
          this.plugin.refreshLanguage(); this.display();
        }));

    new Setting(containerEl).setName(t("Playback and authentication")).setHeading();
    new Setting(containerEl)
      .setName(t("Autoplay"))
      .setDesc(t("Block audible autoplay until you interact with the page. Muted videos may still play. Reopen tabs after changing this setting."))
      .addDropdown((dropdown) => dropdown
        .addOption("block-audible", t("Block audible autoplay"))
        .addOption("allow", t("Allow autoplay"))
        .setValue(this.plugin.core.settings().autoplayPolicy)
        .onChange((value) => {
          if (value === "allow" || value === "block-audible") this.plugin.core.updateSettings({ autoplayPolicy: value });
        }));
    new Setting(containerEl)
      .setName(t("Block passkey requests"))
      .setDesc(t("Prevent sites from requesting or creating passkeys, including requests you start yourself. Turn off to sign in with a passkey. Reload pages after changing this setting."))
      .addToggle((toggle) => toggle.setValue(this.plugin.core.settings().blockPasskeyRequests)
        .onChange((value) => this.plugin.core.updateSettings({ blockPasskeyRequests: value })));

    new Setting(containerEl)
      .setName(t("Tab style"))
      .setDesc(t("Firefox keeps a readable minimum tab width and overflows horizontally. Chrome compresses tabs more aggressively."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("firefox", t("Firefox"))
          .addOption("chrome", t("Chrome"))
          .setValue(this.plugin.core.settings().tabStyle)
          .onChange((value) => {
            this.plugin.core.updateSettings({ tabStyle: value as TabStyle });
            this.plugin.applyTabStyle();
          }),
      );

    new Setting(containerEl)
      .setName(t("Use Browser Core tab layout"))
      .setDesc(t("Apply the selected browser tab style only to panes that contain Browser Core tabs."))
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
      .setName(t("Web search engine"))
      .setDesc(t("Used when Browser Core treats text as a web search rather than an address."));
    searchEngineSetting.addDropdown((dropdown) => {
      for (const preset of SEARCH_PRESETS) dropdown.addOption(preset.id, preset.name);
      dropdown.addOption("custom", t("Custom"));
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
      .setName(t("Custom search URL"))
      .setDesc(t("Use {query} where the encoded search text should be inserted."))
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

    new Setting(containerEl).setName(t("Migration")).setHeading();
    const surfingMigration = this.plugin.core.state.surfingMigration;
    new Setting(containerEl)
      .setName(t("Migrate from Surfing"))
      .setDesc(surfingMigration?.completedAt
        ? t("Completed. Original Surfing data was kept. Backup: {v0}", { v0: surfingMigration.backupPath })
        : t("Adopt Surfing's persistent login session, import bookmarks and compatible settings, and copy open tabs. Existing Browser Core data and Surfing source files are kept."))
      .addButton((button) => button
        .setButtonText(t(surfingMigration?.completedAt ? "Migrated" : surfingMigration ? "Resume migration" : "Preview and migrate"))
        .setDisabled(Boolean(surfingMigration?.completedAt))
        .onClick(async () => {
          await this.plugin.migrateFromSurfing();
          this.display();
        }));

    new Setting(containerEl).setName(t("Home")).setHeading();

    new Setting(containerEl)
      .setName(t("Replace new empty tabs with Home"))
      .setDesc(t("A newly created empty Obsidian tab becomes the Browser Core Home surface."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().replaceEmptyTabsWithHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ replaceEmptyTabsWithHome: value });
            if (value) void this.plugin.replaceMostRecentEmptyLeafWithHome();
          }),
      );

    new Setting(containerEl)
      .setName(t("Default Home search"))
      .setDesc(t("Vault searches files in this vault. Web searches the web or opens an address."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("vault", t("Vault files"))
          .addOption("web", t("Web"))
          .setValue(this.plugin.core.settings().homeSearchMode)
          .onChange((value) => {
            if (value === "vault" || value === "web") {
              this.plugin.core.updateSettings({ homeSearchMode: value });
              this.plugin.refreshBrowserViews();
            }
          }),
      );

    new Setting(containerEl)
      .setName(t("Show bookmarked Vault files on Home"))
      .setDesc(t("Reads file bookmarks from Obsidian's built-in Bookmarks plugin without mixing them with web bookmarks."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showVaultBookmarksOnHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showVaultBookmarksOnHome: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("Show recent Vault files on Home"))
      .setDesc(t("Uses Obsidian's recent-file list; Browser Core does not maintain a duplicate recent-file database."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showRecentVaultFilesOnHome)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showRecentVaultFilesOnHome: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("Browser startup"))
      .setDesc(t("Choose what happens when Obsidian starts and no browser tabs are already open."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("restore", t("Restore previous browser session"))
          .addOption("home", t("Open Home"))
          .addOption("none", t("Do nothing"))
          .setValue(this.plugin.core.settings().startupBehavior)
          .onChange((value) => {
            if (value === "restore" || value === "home" || value === "none") {
              this.plugin.core.updateSettings({ startupBehavior: value });
            }
          }),
      );

    new Setting(containerEl).setName(t("History & recovery")).setHeading();

    new Setting(containerEl)
      .setName(t("History day starts at"))
      .setDesc(t("History day boundaries default to 04:00 so late-night work stays together."))
      .addText((text) => {
        text.inputEl.type = "time";
        text.setValue(formatDayStart(this.plugin.core.settings().historyDayStartMinutes));
        text.onChange((value) => {
          const minutes = parseDayStart(value);
          if (minutes !== undefined) this.plugin.core.updateSettings({ historyDayStartMinutes: minutes });
        });
      });

    new Setting(containerEl)
      .setName(t("History retention (days)"))
      .setDesc(t("0 keeps browsing history until you delete it. Protected tab histories are not removed automatically."))
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().historyRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ historyRetentionDays: days });
          }),
      );

    const advancedStorage = containerEl.createEl("details", { cls: "ubc-settings-advanced" });
    advancedStorage.createEl("summary", { text: t("Advanced history and recovery storage") });
    const advancedStorageEl = advancedStorage.createDiv({ cls: "ubc-settings-advanced-content" });

    new Setting(advancedStorageEl)
      .setName(t("Automatic history size limit"))
      .setDesc(t("0 disables size-based cleanup. A positive value allows the oldest closed, unprotected tab histories to be removed when stored history grows past this limit."))
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
      .setName(t("Detailed tab recovery retention (days)"))
      .setDesc(t("How long Browser Core should keep extra state that can restore recently closed tabs more accurately."))
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().restoreRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ restoreRetentionDays: days });
          }),
      );

    new Setting(advancedStorageEl)
      .setName(t("Detailed recovery storage limit (MB)"))
      .setDesc(t("When this budget is exceeded, older unprotected recovery data may fall back to URL-only reopening."))
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().restoreStorageLimitMb))
          .onChange((value) => {
            const mb = Number(value);
            if (Number.isFinite(mb) && mb >= 16) this.plugin.core.updateSettings({ restoreStorageLimitMb: mb });
          }),
      );

    new Setting(containerEl)
      .setName(t("Form recovery"))
      .setDesc(t("Allow form recovery as a feature. Capture remains opt-in per site, and password/payment credentials are excluded."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().formRecoveryEnabled)
          .onChange((value) => {
            this.plugin.core.updateSettings({ formRecoveryEnabled: value });
            this.plugin.refreshFormRecoveryInstrumentation();
          }),
      );

    new Setting(containerEl)
      .setName(t("Form recovery retention (days)"))
      .setDesc(t("How long saved non-credential form values are retained."))
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().formRecoveryRetentionDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) this.plugin.core.updateSettings({ formRecoveryRetentionDays: days });
          }),
      );

    new Setting(advancedStorageEl)
      .setName(t("Saved form versions per page"))
      .setDesc(t("How many recent recovery versions to keep for one page. Multi-step forms can use values from several versions."))
      .addText((text) =>
        text
          .setValue(String(this.plugin.core.settings().formRecoveryMaxSnapshotsPerUrl))
          .onChange((value) => {
            const count = Number(value);
            if (Number.isFinite(count) && count >= 1) this.plugin.core.updateSettings({ formRecoveryMaxSnapshotsPerUrl: Math.floor(count) });
          }),
      );

    new Setting(advancedStorageEl)
      .setName(t("Pages with saved form recovery"))
      .setDesc(t("Maximum number of distinct pages that may keep form recovery data."))
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
          .setTooltip(t("Clear all saved form recovery data"))
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Clear form recovery data"),
              t("Delete all saved Browser Core form recovery data? Sites that opted in will stay enabled."),
              t("Clear form data"),
            );
            if (!confirmed) return;
            this.plugin.clearFormRecoveryData();
          }),
      );

    const recoveryPolicies = this.plugin.core.formRecovery.policies();
    if (recoveryPolicies.length) {
      new Setting(containerEl).setName(t("Form recovery by site")).setHeading();
      for (const policy of recoveryPolicies) {
        new Setting(containerEl)
          .setName(`${this.plugin.core.containers.nameFor(policy.containerId)} · ${policy.origin}`)
          .setDesc(
            policy.disabled
              ? t("Disabled for this site")
              : t("{v0} excluded field(s)", { v0: policy.excludedFieldKeys.length }),
          )
          .addExtraButton((button) =>
            button
              .setIcon("rotate-ccw")
              .setTooltip(t("Reset form recovery for this site"))
              .onClick(async () => {
                const confirmed = await confirmAction(
                  this.app,
                  t("Reset form recovery for site"),
                  t("Reset form recovery for {v0}? This also deletes saved form recovery data for this site.", { v0: policy.origin }),
                  t("Reset site"),
                );
                if (!confirmed) return;
                this.plugin.core.formRecovery.resetPolicy(policy.containerId, policy.origin);
                this.plugin.core.scheduleSave();
                this.display();
              }),
          );
      }
    }

    new Setting(containerEl).setName(t("Browsing data")).setHeading();

    new Setting(containerEl)
      .setName(t("Clear browsing history"))
      .setDesc(t("Deletes browsing history and detailed recovery data for closed tabs. Open tabs stay open."))
      .addButton((button) =>
        button
          .setButtonText(t("Clear history"))
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Clear browser history"),
              t("Delete browsing history and detailed closed-tab recovery data? Open tabs, bookmarks, containers, cookies and form recovery remain."),
              t("Clear history"),
            );
            if (!confirmed) return;
            this.plugin.clearBrowserHistory();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName(t("Clear detailed tab recovery"))
      .setDesc(t("Keeps browsing history, but removes extra state used to restore recently closed tabs more accurately. Open tabs start collecting detailed recovery again after they are reopened."))
      .addButton((button) =>
        button
          .setButtonText(t("Clear recovery data"))
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Clear detailed tab recovery"),
              t("Old tabs will still reopen from durable URLs, but high-fidelity closed-tab restoration will be lost."),
              t("Clear recovery data"),
            );
            if (!confirmed) return;
            this.plugin.clearRichRestoreData();
          }),
      );

    new Setting(containerEl)
      .setName(t("Clear form recovery data"))
      .setDesc(t("Deletes all saved non-credential form values without changing which sites have form recovery enabled."))
      .addButton((button) =>
        button
          .setButtonText(t("Clear form data"))
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Clear form recovery data"),
              t("Delete all saved Browser Core form recovery data?"),
              t("Clear form data"),
            );
            if (!confirmed) return;
            this.plugin.clearFormRecoveryData();
          }),
      );

    new Setting(containerEl)
      .setName(t("Reset site permissions"))
      .setDesc(t("Returns saved site permissions to Ask next time. Container cookies and site storage are not changed."))
      .addButton((button) =>
        button
          .setButtonText(t("Reset permissions"))
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Reset site permissions"),
              t("Reset all saved site permissions to Ask next time?"),
              t("Reset permissions"),
            );
            if (!confirmed) return;
            this.plugin.clearPermissionDecisions();
            this.display();
          }),
      );

    new Setting(containerEl).setName(t("Appearance")).setHeading();

    new Setting(containerEl)
      .setName(t("Initial background color override"))
      .setDesc(t("Choose the background before the site paints. The site's own colors remain in control once painted."))
      .addDropdown((dropdown) => dropdown
        .addOption("none", t("No override"))
        .addOption("theme", t("Follow theme"))
        .addOption("custom", t("Custom color"))
        .setValue(this.plugin.core.settings().initialBackgroundOverride ? this.plugin.core.settings().initialBackgroundSource : "none")
        .onChange((value) => {
          this.plugin.core.updateSettings({ initialBackgroundOverride: value !== "none", initialBackgroundSource: value === "custom" ? "custom" : "theme" });
          this.plugin.refreshBrowserViews(); this.display();
        }));
    if (this.plugin.core.settings().initialBackgroundOverride && this.plugin.core.settings().initialBackgroundSource === "custom") {
      new Setting(containerEl).setName(t("Initial background color"))
        .addColorPicker((picker) => picker.setValue(this.plugin.core.settings().initialBackgroundColor)
          .onChange((value) => {
            this.plugin.core.updateSettings({ initialBackgroundColor: value }); this.plugin.refreshBrowserViews();
          }));
    }

    new Setting(containerEl)
      .setName(t("Full-page loading shield"))
      .setDesc(t("Cover the web page while a new page starts loading. Off by default to avoid a full-page flash."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().fullPageLoadingShield)
          .onChange((value) => {
            this.plugin.core.updateSettings({ fullPageLoadingShield: value });
            this.plugin.refreshLoadingShields();
          }),
      );

    new Setting(containerEl)
      .setName(t("Reduced motion"))
      .setDesc(t("Avoid large transitions, slides and parallax in Browser Core UI."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().reducedMotion)
          .onChange((value) => {
            this.plugin.core.updateSettings({ reducedMotion: value });
            this.plugin.applyAccessibilityClasses();
          }),
      );

    new Setting(containerEl)
      .setName(t("Default web content zoom"))
      .setDesc(t("Relative to this Obsidian window. Used by sites without a site-specific zoom override."))
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
      .setName(t("Show bookmark bar"))
      .setDesc(t("Your everyday pages, one click away."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.core.settings().showFavoritesBar)
          .onChange((value) => {
            this.plugin.core.updateSettings({ showFavoritesBar: value });
            this.plugin.refreshBrowserViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("Bookmark bar display"))
      .setDesc(t("Choose every bookmark and folder, or just the members you select."))
      .addDropdown((dropdown) => dropdown
        .addOption("all", t("Bookmark bar"))
        .addOption("selected", t("Selected members"))
        .setValue(this.plugin.core.settings().bookmarkBarMode)
        .onChange((value) => { this.plugin.core.updateSettings({ bookmarkBarMode: value as "all" | "selected" }); this.plugin.refreshBrowserViews(); }))
      .addButton((button) => button.setButtonText(t("Choose members")).onClick(() => void this.plugin.openBrowser({ url: "browser://bookmarks", state: { bookmarkLayout: "selected" } })));

    new Setting(containerEl).setName(t("Containers")).setHeading();
    new Setting(containerEl)
      .setName(t("Container use"))
      .setDesc(t("Off uses only the selected default container. Manual keeps other containers available without automatic site routing. Automatic also applies site default rules."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", t("Off"))
          .addOption("manual", t("Manual"))
          .addOption("automatic", t("Automatic"))
          .setValue(this.plugin.core.settings().containerMode)
          .onChange((value) => {
            this.plugin.core.updateSettings({ containerMode: value as "off" | "manual" | "automatic" });
            this.plugin.refreshContainerPresentation();
            this.display();
          }),
      );
    new Setting(containerEl)
      .setName(t("Default container"))
      .setDesc(t("Used for new browser tabs, including when container controls are off. Automatic mode may replace it with a site's default container."))
      .addDropdown((dropdown) => {
        for (const container of this.plugin.core.containers.list()) {
          dropdown.addOption(container.id, container.name);
        }
        dropdown
          .setValue(this.plugin.core.settings().defaultContainerId)
          .onChange((value) => this.plugin.core.updateSettings({ defaultContainerId: value }));
      });
    for (const container of this.plugin.core.containers.list()) {
      const row = new Setting(containerEl)
        .setName(container.name)
        .setDesc(t("Separate persistent login and site data"))
        .addText((text) =>
          text
            .setPlaceholder(t("Container name"))
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
            .addOption("box", t("Box"))
            .addOption("user-round", t("Personal"))
            .addOption("briefcase", t("Work"))
            .addOption("search", t("Search"))
            .addOption("graduation-cap", t("Study"))
            .addOption("building-2", t("Organization"))
            .addOption("shield", t("Protected"))
            .addOption("heart", t("Favorite"))
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
          button.setIcon("eraser").setTooltip(t("Clear browsing data and saved permissions"));
          button.onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Clear " + container.name + " browsing data",
              t("Clear this container's cookies, site storage, cache, sign-in cache, and saved site permissions? Open pages may need to be reloaded."),
              t("Clear browsing data"),
            );
            if (!confirmed) return;
            const cleared = await this.plugin.clearContainerSession(container.id);
            if (!cleared) return;
            this.display();
          });
        })
        .addExtraButton((button) => {
          button.setIcon("trash").setTooltip(t("Delete container"));
          button.setDisabled(container.id === "default");
          button.onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              t("Delete container"),
              t("Delete “{v0}”? Its cookies, site storage, cache, saved permissions, form recovery data, and site default rules will be cleared. Browsing history will remain.", { v0: container.name }),
              t("Delete container"),
            );
            if (!confirmed) return;
            if (await this.plugin.deleteContainer(container.id)) this.display();
          });
        });
      row.settingEl.dataset.containerId = container.id;
    }
    new Setting(containerEl)
      .setName(t("Add container"))
      .setDesc(t("Creates a separate persistent login and site data."))
      .addButton((button) =>
        button.setButtonText(t("Add")).onClick(() => {
          this.plugin.core.containers.create("Container");
          this.plugin.core.scheduleSave();
          this.display();
        }),
      );

    const assignments = this.plugin.core.containers.assignments();
    if (assignments.length) {
      new Setting(containerEl)
        .setName(t("Site default containers"))
        .setDesc(this.plugin.core.settings().containerMode === "automatic"
          ? t("Applied automatically when an independent navigation opens a matching site.")
          : t("Saved for later, but currently paused because automatic container routing is off."))
        .setHeading();
      for (const rule of assignments) {
        new Setting(containerEl)
          .setName(rule.originPattern)
          .setDesc(this.plugin.core.containers.nameFor(rule.containerId))
          .addExtraButton((button) =>
            button
              .setIcon("x")
              .setTooltip(t("Forget site default container"))
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
      new Setting(containerEl).setName(t("Site permissions")).setHeading();
      for (const record of permissions) {
        new Setting(containerEl)
          .setName(permissionLabel(record.permission))
          .setDesc(`${record.origin} · ${this.plugin.core.containers.nameFor(record.containerId)} · ${permissionDecisionLabel(record.decision)}`)
          .addDropdown((dropdown) =>
            dropdown
              .addOption("ask", t("Ask next time"))
              .addOption("allow", t("Allow"))
              .addOption("block", t("Block"))
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
