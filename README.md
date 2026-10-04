# Unified Browser Core

Unified Browser Core is a desktop-only browser plugin for [Obsidian](https://obsidian.md/). It brings browser tabs and browsing data into an Obsidian workspace, with container sessions, graph-based history, bookmarks, session restore, and recovery tools.

> The plugin is under active development. It depends on Obsidian's Electron environment and compatibility adapters, so behavior may vary across Obsidian versions.

## Features

- Open web pages in browser views inside the Obsidian workspace.
- Organize browsing into containers with separate persistent sessions.
- Track navigation as graph history and restore closed tabs with their available state.
- Save and organize bookmarks, including importing from Obsidian's Bookmarks core plugin, Web viewer Bookmarks, and Surfing.
- Restore tabs and windows after restarting Obsidian.
- Handle browser permissions and popup requests through Browser Core.
- Optionally recover form contents for sites you explicitly allow. Form recovery is off by default and excludes password, payment, one-time-code, WebAuthn, file, and hidden fields.
- Expose a public API for other Obsidian plugins.

## Bookmark library and selected members

The star in the browser toolbar saves a page and opens a lightweight editor. Choose a folder, change its type, or add it to **Selected members**. Changes are saved as you edit; **Done**, Escape, or a click outside closes the editor. Click the star on an existing bookmark to edit it; remove it with **Delete bookmark** in the editor.

The bookmark library has visual cards grouped by type, a folder tree, and a **Selected members** screen where you choose your everyday pages from existing bookmarks. Search matches names, URLs, descriptions, tags, and folder paths. Type detection uses URL extensions, query filenames, and known domains. Google services are references, Gmail and other mail services are mail, and YouTube is video. Common audio, image, PDF, document, blog, and forum links have separate groups. Automatic results can be overridden in either bookmark editor.

In Settings, enable **Show bookmark bar** and select **Bookmark bar** to show the root bookmarks and folders, or **Selected members** to show only the pages you selected. Existing favorites become selected members. **Initial background color override** can be disabled to stop painting the Obsidian theme color behind initial web content; the full-page loading shield remains a separate option.

**Language** offers English, Japanese, or automatic selection from Obsidian's language. The settings, bookmark screens, browser menus, dialogs, and primary command labels support both languages; command labels are registered when the plugin loads.

## Import from Web viewer Bookmarks

In a vault that has Web viewer Bookmarks installed, open Unified Browser Core's Bookmarks page and choose **Import Web viewer Bookmarks**, or run **Import bookmarks from Web viewer Bookmarks** from the command palette. UBC reads that plugin's `data.json` from the same vault and leaves it unchanged. Repeating the import skips URLs already in UBC.

The import copies web URLs, titles, and Lucide icons. Bookmarks shown in the source plugin's ribbon become UBC favorites. URLs containing `{{selection}}` expand the selected text from an active Markdown editor when opened. Per-bookmark commands and the source plugin's opening mode are not copied.

## Migrate from Surfing

While Surfing is still installed, open **Unified Browser Core → Settings → Migration → Migrate from Surfing**, or run **Migrate browsing data from Surfing**. Review the preview and confirm. Keep Surfing installed until you have checked the migrated pages and bookmarks in UBC.

The migration registers Surfing's vault-specific persistent Electron session as a dedicated UBC container and selects it for new tabs. Cookies, local storage, IndexedDB, and other data in that session remain available without copying Chromium's live database files. Existing UBC containers keep their own sessions. Because both plugins refer to the same session, clearing browsing data in either plugin clears that shared profile. Uninstalling Surfing's plugin files does not itself clear the Electron session; deleting Obsidian's application data does.

UBC also imports Surfing bookmarks from `.obsidian/surfing-bookmark.json`, including folders, descriptions, and tags. It imports Surfing's open tabs and their available navigation history, then maps the selected search engine and bookmark-bar setting where UBC has an equivalent. Surfing-only feature settings are saved in the migration backup but are not enabled as UBC features. The backup includes the original Surfing settings and bookmarks plus UBC's pre-migration state, and is written inside UBC's plugin folder before any UBC state changes. Surfing's source files and open tabs are left untouched. If Surfing is disabled before migration, saved workspace tabs may be recoverable, but live WebView navigation history is unavailable.

## Requirements

- Obsidian 1.8.0 or later
- Obsidian desktop (this plugin does not support mobile)
- Node.js and npm to build from source

## Install from source

```sh
git clone https://github.com/OzoneAsai/unified-browser-core.git
cd unified-browser-core
npm install
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` from `dist/` into your vault's plugin folder:

```text
<Vault>/.obsidian/plugins/unified-browser-core/
```

Then restart Obsidian, open **Settings → Community plugins**, and enable **Unified Browser Core**.

## Install beta releases with BRAT

BRAT installs plugin builds from GitHub Releases. Add `OzoneAsai/unified-browser-core` with BRAT's **Add beta plugin for testing** command, then enable Unified Browser Core in **Settings → Community plugins**. BRAT can track the latest release or a frozen version.

To publish a build for BRAT, update the version in both `package.json` and `manifest.json`, commit the change, and push a matching version tag. For example, for version `0.1.0-beta.1`:

```sh
git tag 0.1.0-beta.1
git push origin 0.1.0-beta.1
```

GitHub Actions builds the plugin and creates a release containing `main.js`, `manifest.json`, and `styles.css`. Keep the tag and both manifest versions identical. Tags with a prerelease suffix, such as `-beta.1`, are published as pre-releases.

The repository is currently private. BRAT users need access to a private repository; for general beta testing, the repository must be public.

## Development

```sh
npm install
npm run dev       # rebuild on source changes
npm run typecheck # check TypeScript types
npm test          # run the core smoke checks
npm run build     # create the plugin files in dist/
```

The `verify` script runs type checking, smoke checks, a build, and release checks:

```sh
npm run verify
```

## Use

After enabling the plugin, use the **Open browser** ribbon icon or command. The command palette also provides commands for browser history and bookmarks. Configure containers, tab layout, and other browser behavior in the plugin settings.

## Architecture

Browser Core owns browser state and policies; adapters connect it to Obsidian and Electron. The managed WebView backend is the current desktop rendering runtime. The design and runtime boundaries are documented in [ADR-0001](docs/ADR-0001-browser-runtime-boundary.md).

## License

No license has been specified yet.

### Playback and passkey controls

Settings → Playback and authentication offers audible autoplay suppression (default) or allowance. Chromium's document activation policy permits muted autoplay and can unlock playback after page interaction. Reopen tabs after changing this option.

Block passkey requests is off by default. WebAuthn get/create Permissions-Policy restrictions apply to UBC's HTTP(S) guest documents before scripts run. Explicit passkey login and registration are also blocked: disable and reload to use passkeys. Requires Electron remote session APIs and WebAuthn policy support. Plugins sharing the adopted Surfing session should be disabled after migration to avoid competing headers listeners.

Initial background can follow the Obsidian theme, use a custom color, or remain unmodified. The choice affects the initial backing surface, not the colors painted by a website.

Restored tab state preserves the page title and a bounded raster favicon. Deferred, loading, failed and stopped tabs use a grayscale dimmed favicon; the title stays readable. Guest content is bounded by the pane and redundant zoom resets are avoided.
