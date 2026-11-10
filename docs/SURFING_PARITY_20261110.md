# Surfing → Unified Browser Core parity audit (2026-11-10)

## Source of truth and scope

- Latest upstream UBC `OzoneAsai/unified-browser-core`, `main`
  `ba4692f1a1a3370bc25639563adc1d60a00b6e77` (0.3.5, 2026-11-06).
  This work builds `0.3.6-beta.1` on that exact parent commit.
- Surfing `PKM-er/Obsidian-Surfing`, `main`
  `1bf883852e2e068dc74deec97a3b76a64849e8e0`.
- Built on an isolated worktree. The earlier 0.3.1 local working tree and its
  uncommitted changes are preserved separately.
- Compared Surfing's `surfingView.ts`, `WebviewManager.ts`, `SearchBox.ts`,
  `HeaderBar.ts`, `ContentScriptInjector.ts`, `ContextMenuHandler.ts`,
  in-page search UI, and the extension/adblock/MCP source tree with UBC.

## Parity matrix

| Capability | Surfing | UBC baseline 0.3.5 | This work |
| --- | --- | --- | --- |
| `target=_blank` and `parent.open` → Obsidian tab | yes | partial, auxiliary native windows leaked | **fixed**, real Electron verified |
| Named/sized `window.open` | tab (no live opener) | sometimes OS window | **fixed** for web links |
| `background-tab` intent | background tab | exists | retained |
| External app protocols | OS handoff | not distinguished in opener path | **fixed** |
| Page find UI with forward/back, count, Esc | yes | missing | **implemented**, real matches confirmed |
| Guest keyboard `before-input-event` | yes | only general interaction dismissal | **selective Ctrl/⌘+F, Ctrl/⌘+L, Ctrl/⌘+G, F3**, tested |
| Browser link hover URL preview | hover injection/port | missing | **native `update-target-url`**, tested |
| Right-click page screenshot → clipboard | yes | missing | **implemented** using native `capturePage` |
| Save current page as Markdown | Defuddle | missing | **implemented** via Obsidian `htmlToMarkdown`, unique filenames |
| Explicit external-browser action | yes | absent from web page menu | **implemented** |
| Context-menu links, images, editing | yes | present | retained |
| Header navigation, tab search, bookmarks | yes | present, different presentation | retained |
| Reader Mode | yes | missing | **not yet implemented** |
| Dark Reader injection | yes | missing | **not yet implemented** |
| Chrome extension compatibility | yes | missing | **not yet implemented** |
| Adblock and element picker | yes | missing | **not yet implemented** |
| MCP page automation and permissions | yes | missing | **not yet implemented** |
| Tree tab panel | yes | alternative history graph/tab search | **not equivalent** |
| Embedded/popover WebViews | yes | different embedding model | **not yet equivalent** |
| Drag-start integration | guest injection | missing | **not yet implemented** |
| Cookie manager | yes | container-level site storage controls | **not equivalent** |

Do not confuse browser feature parity with the existence of a project-level
equivalent. UBC's history graph is not Surfing's tab tree, and simple page
clipping is not a Defuddle reader.

## Architecture of the fixes

1. `electron-window-open.ts`: always return `deny` synchronously in the
   main process; IPC routes web targets into Obsidian UBC tabs. Renderer
   fallback follows the same policy. Runtime/IPC namespace upgraded to v2 to
   prevent reuse of the old `allow` handler across hot reloads.
2. `external-app-link.ts`: share the same browser-URL versus app-protocol
   distinction as Surfing, rather than adding Manaba-specific conditions.
3. `guest-keyboard.ts`: one selective listener per WebContents, cleaned up
   on guest teardown. Unmodified typing/IME is not intercepted.
4. `browser-find.ts`: native Electron find API, status updates from
   `found-in-page`, query-change cancellation, forward/back selection,
   keyboard, accessible labels and cleanup on navigation/destroy.
5. `guest-link-hover.ts`: native `update-target-url` listener, no polling or
   content-script injection. The hover URL is presented via textContent.
6. `browser-view.ts`: guest hooks bound when the WebContents exists;
   popups reasserted at `dom-ready` like Surfing. Browser-controlled menu
   actions use the same guest owner, not a second native browser window.

## Regression evidence

Automated: `npm run verify` passes including typecheck, core smoke,
UI/model tests, password tests, build, and release artifact verification.
`tests/core-smoke.ts` runs the actual injected main-process popup runtime
in a VM; verifies deny/tab IPC across _blank, background, named/sized,
noopener, new-window, and unbind. Shortcuts are tested against ordinary
typing cases.

Real Electron: isolated QA vault, Obsidian 1.15.0, UBC 0.3.5 code before
beta version bump. Chromium WebView file fixtures are in `tests/fixtures/`.

| Real action | Verified result |
| --- | --- |
| Manaba `_blank` fallback | exactly one UBC tab, OS windows stay at 1 |
| Manaba `window.parent.open` + balloon close | exactly one UBC tab, OS windows stay at 1 |
| Named `oauth` with `popup=yes,width,height` | exactly one UBC tab, OS windows stay at 1 |
| Ordinary `target=_blank` | exactly one UBC tab, OS windows stay at 1 |
| Find `orchid` in actual WebView | `1/3`, next gives `2/3` |
| macOS ⌘+F via `sendInputEvent` | find UI opened/focused |
| macOS ⌘+L via `sendInputEvent` | URL input focused and selected |
| `update-target-url` guest event | URL shown in status overlay |
| `capturePage()` | nonempty native image, 1360 × 1374 on QA screen |
| Save Markdown | new `Web Clippings/UBC find in page regression.md`, title, source, and text correct |
| Guest reload after keyboard/hover/find hooks | listeners remain at 2 each (one host + one UBC), no duplicates |

Real Manaba account login and Google document access were not used; fixture
links intentionally target `example.org` to verify window ownership only.
Clicking an external-browser action was deliberately not part of isolated QA
to avoid interfering with another browser session. The underlying action is
explicitly user-triggered.

## Outstanding work and limitations

Primary remaining browser parity work: Reader Mode, dark rendering, drag
integration, and richer page capture; distinct platform subsystems: tab tree,
embedded browsing, extension runtime, adblock, MCP, cookie management.
Integrations requiring a **live JavaScript `window.opener`** remain different
from native auxiliary popup windows, intentionally matching Surfing's choice.

The HTML-to-Markdown save path uses Obsidian's converter, not Surfing's
Defuddle extraction; for script-heavy sites, content quality can differ.
Windows/iOS parity was not exercised in this macOS-only run.
