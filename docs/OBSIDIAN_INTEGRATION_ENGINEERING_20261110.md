# Obsidian integration — implementation and engineering log

## Scope / pinned sources

- UBC starting point: `OzoneAsai/unified-browser-core@b4129ec`, branch `fix/surfing-browser-parity-20261110`, package `0.3.6-beta.1`.
- Surfing baseline: `PKM-er/Obsidian-Surfing@1bf883852e2e068dc74deec97a3b76a64849e8e0`.
- Full original inventory: `/Users/o3/Desktop/UBC-audit-20261110/full-inventory/result/` (214 Surfing files, 1,808 check units).
- User direction: **Obsidian integration only**. Chrome extensions, MCP, adblock, Reader Mode and Dark Reader are not authorized for this implementation interval.
- Development on macOS: `/Users/o3/Desktop/ubc-surfing-parity-20261110`; no changes to the original dirty `/Users/o3/Desktop/unified-browser-core` tree.
- QA: isolated Obsidian 1.15.0 at CDP port 19229, vault `macos-qa-vault`. The user's ordinary Obsidian vault is *not updated by this task*.

## Architectural decisions

1. **Link semantics rather than patching many prototypes.** `src/integrations/obsidian-link-policy.ts` owns the HTTP(S)-only URL boundary; `src/integrations/obsidian-link-router.ts` owns a single document-level event path for Reading View, Markdown Live Preview and Properties. A Markdown editor must return an `external-link` semantic token *and* the DOM target must be a rendered `.cm-link .cm-underline`; raw editor text retains its caret and selection behavior. Normal activation opens a UBC tab; Ctrl/⌘ activation retains the Surfing-style external-browser handoff. Non-HTTP(S) targets remain Obsidian's concern.
2. **Popout and reload lifecycle.** Obsidian secondary windows have separate DOM prototypes, so element identity uses DOM node capabilities (`nodeType`, `closest`) instead of the main-window `instanceof Element`. The bridge registers the main document, discovers already-open popout documents from workspace leaves, listens for new `window-open` events and disposes listeners on window close and plugin unload.
3. **Shared guest ownership.** `EmbeddedBrowser` creates guests via the existing `ManagedWebviewBackend` with the selected Container partition, uses the existing `ElectronWindowOpenAdapter` and permission adapter, and releases guest resources through the MarkdownRenderChild lifecycle. `surfing` and `ubc-browser` fenced code blocks use the same implementation; malformed source is rejected. No second independent WebView runtime is created.
4. **Coexistence namespace.** `ubc-browser` is UBC's own code-block name. Legacy `surfing` and `obsidian://web-open` handlers are claimed only when the Surfing plugin is not loaded during UBC startup. This avoids a startup namespace takeover, though dynamic enable/disable ordering of a second plugin has not yet been exhaustively tested.
5. **Canvas is host-owned.** Obsidian 1.15 already manages a WebView for a Canvas URL node. Instead of replacing its private Canvas node implementation, `src/integrations/obsidian-canvas.ts` adds a scoped Open in UBC action. It uses a MutationObserver and a microtask-coalesced scan; `requestAnimationFrame` was removed because the hidden-window QA revealed that it could indefinitely delay *registration*, which is a state transition rather than painting. This is **partial** Surfing parity, not replacement of the Canvas guest partition.
6. **Hover preview lifecycle.** A delayed single `EmbeddedBrowser` hover panel is owned by `ObsidianHoverPreview`; leaving the link/panel, scrolling, hiding the document or unloading the plugin disposes it. Do not schedule hover previews in background windows; Chromium can defer the timer until an old hover is no longer relevant.
7. **HTML ownership.** `.html`/`.htm` TFiles have a `FileView` adapter that opens their local `file://` URLs in a UBC tab, using `pathToFileURL`. Extension registration conflicts with other plugins fall back to an explicit file-menu action.

## Surfing capability delta (does not replace the original audit)

| Surfing feature / source | UBC current status | Implemented/evidence | Outstanding |
|---|---|---|---|
| `surfingIndex.ts` external-link routing from Markdown Reading View | Implemented / QA passed | `obsidian-link-router.ts`; click creates 1 UBC tab, native Window count unchanged | Multiple windows not yet macOS GUI tested |
| `surfingIndex.ts` Live Preview external links | Implemented / QA passed | Editor's `getClickableTokenAt` gated by rendered hyperlink target | Mouse / IME / accessibility matrix not exhaustive |
| `surfingIndex.ts` Properties URL | Implemented / QA passed | `.metadata-link-inner[data-href]` (not a normal anchor) | Custom property renderers untested |
| `surfingIndex.ts` HTML fenced code | Implemented / initial QA passed | `src/ui/embedded-browser.ts`, `surfing` and `ubc-browser` | Reactivation in a background, hidden renderer may be deferred until markdown is repainted |
| `surfingIndex.ts` custom `web-open` URI | Implemented with namespace coexistence | Same router; handler if Surfing itself not loaded | Not exercised through OS URL scheme in QA |
| `surfingIndex.ts` hover-linked WebView | Implemented / lifecycle tested | `src/ui/obsidian-hover-preview.ts`; guest count +1/-1 in visible QA; direct mount/close repeated in hidden QA | Competing native Page Preview UI and real pointer dwell not fully verified |
| `surfingIndex.ts` Canvas integration | **Partial** / action QA passed | `src/integrations/obsidian-canvas.ts`; host WebView remains intact, action opens UBC tab | Full Canvas tab/drag/guest partition ownership parity not implemented |
| `surfingFileView.ts` HTML file handling | Implemented / QA passed | `src/ui/html-file-view.ts` | Other plugin's extension owner may take precedence; explicit file menu is fallback |
| `surfingIndex.ts` global `window.open` patch | Deliberately **not** equivalent | Managed guest popups already routed via `ElectronWindowOpenAdapter` | Obsidian host-level global interception would be much broader and is deferred |

## QA evidence

**Initial implementation checkpoint** (`fb4955a`): `npm run verify` passed. Native Obsidian 1.15.0 QA verified Reading View external link, Properties URL, code-block `webview` creation, Canvas action, HTML local file view, and guest hover panel cleanup.

**29-minute follow-up (2026-11-10 JST):**

- Diagnosed failed Live Preview as event ownership: normal click did not use `getClickableTokenAt` even though it returned `external-link`. Updated the same router to distinguish `.cm-link .cm-underline` from ordinary source text.
- Repro in isolated Obsidian: plain click → `https://example.org/ubc-reading`, exactly one new UBC tab, OS BrowserWindow count stays 1. ⌘+click → one `window.open(url, "_external")` call and no UBC tab. Ordinary Markdown text → no browser navigation.
- Added `tests/obsidian-link-router-smoke.ts`: Reading View, properties, Canvas, native mailto/Obsidian URI exclusions, fake elements with other DOM prototypes, semantic Live Preview activation, ordinary editor text and internal-link noninterference.
- `npm run verify` passed, including TypeScript, smoke, UX/Home, passwords/preload, build, release verification.
- Repeatable QA harness: `node qa/obsidian-integration-macos.mjs`. It runs only against the *named isolated QA vault*, reuses the running Obsidian CDP instance and removes only browser tabs it creates.
- **QA caveat:** After disabling/re-enabling the plugin while the QA app is hidden (`document.hidden===true`), Obsidian's suspended Markdown preview renderer does not always rerender cached fenced blocks. The harness marks that observation as `deferred`, not as a pass or a proven feature regression. Initial QA with a rendered section showed two real `webview` elements with the expected URLs and matching Container partitions.
- Canvas node action initially used animation frames and did not appear while the test window was hidden. State-based microtask scheduling corrected the issue; repeated QA confirms one action opening exactly one UBC tab with the expected URL.
- Hover preview guest ownership: direct internal mount added one live guest and close removed one. Synthetic pointer dwell in the *hidden* document is not a valid real-hover test; visibility gating now prevents stale hover timers. Earlier visible-window testing verified actual panel creation and teardown.

## Risks and remaining work (inside Obsidian integration only)

1. Perform live pointer dwell and cross-window GUI QA while the isolated Obsidian window is foregrounded; do not infer success from a background document.
2. Validate dynamic two-plugin load order (Surfing first, UBC first, Surfing reenabled after UBC) before claiming namespace-coexistence parity.
3. Decide whether Canvas's original guest should continue to own in-node navigation or whether UBC should fully manage that guest. Current button is intentionally host-preserving and **not full Surfing Canvas parity**.
4. Verify Markdown section visibility/re-render lifecycle after plugin reload without forcing an unrelated workspace refresh.
5. Complete an accessible pointer/keyboard/IME interaction matrix on Obsidian source editor and native Page Preview coexistence.

## Engineering checkpoints

- `b4129ec`: prior Surfing browser-navigation baseline.
- `fb4955a`: first Obsidian link/embedded/HTML checkpoint.
- Follow-up: shared Live Preview routing, popout DOM ownership, hover visibility lifecycle, Canvas state scheduling, read-only QA harness and source-level regression tests. **Check Git for the latest checkpoint commit SHA.**

The original root branch and ordinary Obsidian installation are not silently modified; QA uses the separate vault/profile.
