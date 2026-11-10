# Popup navigation parity with Surfing — initial 0.3.1 check (2026-11-10)

This document is the historical first regression pass against the older local
checkout. The **current GitHub-based 0.3.5 audit, new UI and hook changes, and
macOS 1.15.0 real-guest tests** are documented in
`docs/SURFING_PARITY_20261110.md`. Do not treat the 0.3.1 deployment below as
the latest build.

## Cause and model

UBC's old main-process `setWindowOpenHandler` classified named windows,
`popup=yes`, and sizing features as auxiliary windows and returned `allow`.
Electron consequently created a separate OS window. Surfing's guest handler
instead denies all browser popups and opens their target URLs in Obsidian tabs.

UBC now uses that same navigation ownership boundary in both the main-process
handler and the renderer fallback: a website's window-open request is denied
synchronously and becomes a new UBC tab. Only background-tab disposition
remains background; even `new-window` becomes a new tab. External application
protocols, such as `obsidian://` and `mailto:`, still go to the OS as Surfing
does. Guest handlers are reasserted at `dom-ready` as well as `did-attach`.

The main-process singleton, module filename, and IPC channel are versioned
`v2` so that reloading the plugin cannot reuse the old `allow` handler.

## Deterministic verification

- `npm run verify`: typecheck, core smoke tests, password tests, build, and
  release artifact validation passed.
- `tests/core-smoke.ts` runs the **actual injected main-process source** in an
  isolated Node VM using a fake Electron guest. This verifies that _blank,
  background tab, named popup, sized popup, noopener, and new-window all return
  `deny`, that only a UBC tab IPC message is sent, and that pending messages
  are discarded after unbinding.
- CodeGraph indexed the source and traced `ElectronWindowOpenAdapter`,
  `BrowserView.bindGuestRuntime`, and `openFromOpener` before changes.

## Real Obsidian / Electron validation

Environment: macOS, isolated Obsidian QA profile, Obsidian 1.10.6,
UBC 0.3.1. The test opened a file-based page equivalent to
`tests/fixtures/manaba-balloon.html` in an actual UBC WebView and used its
DOM to click links. The scenarios and results were:

| Guest action | UBC browser leaves | OS window count | Destination |
| --- | --- | --- | --- |
| Manaba `_blank` fallback | 7 → 8 | 1 → 1 | `https://example.org/ubc-manaba-iframe` |
| Manaba `parent.open` + balloon close | 8 → 9 | 1 → 1 | `https://example.org/ubc-manaba-iframe` |
| Named `oauth`, width/height, `popup=yes` | 9 → 10 | 1 → 1 | `https://example.org/ubc-named-popup` |
| Ordinary `target=_blank` | 10 → 11 | 1 → 1 | `https://example.org/ubc-ordinary-blank` |

In all four cases, the correct destination became the active UBC tab.
No real Manaba account or document access was required for this routing test.

## Deployment and rollback

The verified `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` were
installed into the Mac's existing iCloud Obsidian vault, upgrading its UBC
manifest from `0.3.0` to `0.3.1`. SHA-256 comparisons confirmed all three
installed artifacts match the build. The existing `data.json` was not edited
and its pre/post checksum was identical. Previous plugin artifacts were saved
in the local Desktop backup folder `UBC-install-backup-20261110/` for rollback. Obsidian
must reload/restart the plugin to pick up the new JavaScript if it was open.

The temporary QA vault was returned to its original plugin artifact version
`0.3.3`, and the test-only HTML page and tabs were removed. No other running
Obsidian profile was used for the GUI test.

## Compatibility boundary

Like Surfing, converting a true JavaScript popup into a separate tab does not
preserve a live `window.opener` reference. Some OAuth workflows requiring
`postMessage` to the original window can therefore differ from dedicated
popup-window browsers. This is an intentional Surfing-parity behavior, not a
Manaba-specific exception.
