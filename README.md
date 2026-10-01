# Unified Browser Core

Unified Browser Core is a desktop-only browser plugin for [Obsidian](https://obsidian.md/). It brings browser tabs and browsing data into an Obsidian workspace, with container sessions, graph-based history, bookmarks, session restore, and recovery tools.

> The plugin is under active development. It depends on Obsidian's Electron environment and compatibility adapters, so behavior may vary across Obsidian versions.

## Features

- Open web pages in browser views inside the Obsidian workspace.
- Organize browsing into containers with separate persistent sessions.
- Track navigation as graph history and restore closed tabs with their available state.
- Save and organize bookmarks, including importing bookmarks from Obsidian's Bookmarks core plugin.
- Restore tabs and windows after restarting Obsidian.
- Handle browser permissions and popup requests through Browser Core.
- Optionally recover form contents for sites you explicitly allow. Form recovery is off by default and excludes password, payment, one-time-code, WebAuthn, file, and hidden fields.
- Expose a public API for other Obsidian plugins.

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
