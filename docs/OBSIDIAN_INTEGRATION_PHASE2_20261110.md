# Obsidian integration phase 2 — engineering log

Date: 2026-11-10 JST. Worktree: `/Users/o3/Desktop/ubc-surfing-parity-20261110`. Source baseline commit `acfdcf5` (0.3.6-beta.2).

## Scope

Two explicitly postponed items are kept **PENDING** in `OBSIDIAN_INTEGRATION_PENDING.md`:

- `![[example.html]]` HTML file embed rendering in Markdown, through Obsidian's embed registry.
- Full UBC-owned Canvas-internal WebView with Container, history and controls. The already implemented Canvas *Open in UBC* action remains.

The other Obsidian integration areas were prioritized. Chrome extensions, MCP, advertisement blocking, Reader Mode and Dark Reader are not part of this scope.

## Implemented

| Obsidian surface | Capability | Data/control ownership |
|---|---|---|
| WebView context menu | Save selected web text as a new Markdown note under `Web Clippings`, with quoted text, source URL, and YAML metadata | Existing BrowserView uses Vault API, never directly edits other notes |
| WebView context menu | Copy selected text as a URL Text Fragment link (`#:~:text=`), preserving regular page anchors | Pure `obsidian-web-transfer.ts`, HTTP(S) only |
| Browser tab commands | Copy all current HTTP(S) browser tabs into Markdown link list | BrowserPublicApi `tabs()` is source of truth |
| Markdown editor | Search selected text via configured engine, Google, DuckDuckGo or Bing | Obsidian Editor selection via official `editorCheckCallback` |
| Markdown editor | Insert current HTML5 video timestamp from most recently active UBC tab; Bilibili/YouTube use `?t=`, others `#t=` | One read-only guest `executeJavaScript` call, selection replacement through Editor API |
| Browser toolbar | Drag current page as Markdown link into a note | Host-side draggable icon; native `dataTransfer` text/plain and text/uri-list; does **not** inject event handlers into websites |
| Vault bookmark sync | Optional bidirectional sync in **dedicated** `UBC Bookmarks` folder | Opt-in setting/command, saved ID mirror, Obsidian Vault events and BookmarkStore events; only explicitly managed files |
| Browser tab tree | Workspace sidebar `ubc-browser-tab-tree`: tab groups, reorder within tree by drag/drop, rename/collapse, move/close/activate, named group+tab workspace snapshots and restore | ItemView and public tab API; virtual grouping, **does not physically reorder Obsidian tab strip** |
| Obsidian empty tabs | Search field when UBC Home replacement is disabled | Adds local form inside native empty-view container, no other plugin's Home Tab mutation |
| Markdown note header | Command to open focused temporary web/URL search field | One scoped input; removed on blur, Enter, or Escape |

### Vault mirror invariants

- Disabled by default. Enabling explicitly starts a new two-way mirror; disabling preserves Vault notes.
- No files in Surfing's existing `surfing-bookmarks` folder are modified. This implementation does **not** yet provide live import from the legacy Surfing bookmark folder.
- Managed Markdown files include a durable `ubc_bookmark_id`, stable across user file renames and plugin restart.
- Only previously published bookmark IDs can be deleted through a managed note deletion; unrelated native bookmarks remain intact. UBC bookmark deletions send owned notes to Obsidian's recoverable trash (`system=false`).
- Existing files are updated via `processFrontMatter`, so note body and unrelated YAML fields are preserved.
- If the managed folder unexpectedly disappears, syncing is disabled rather than wiping bookmarks. Invalid managed YAML pauses export and protects original text.
- Core event-bus changes are serialized with Vault events; `flush()` waits until no more queued events are added.

### Code layout

- `src/integrations/obsidian-web-transfer.ts`: pure text fragment URL, note formatting, tab-list formatting, timestamp deep links.
- `src/integrations/obsidian-vault-bookmark-mirror.ts`: opt-in two-way, serial Vault mirror; `src/bookmarks/bookmark-store.ts` supports stable-ID imports.
- `src/tabs/browser-tab-tree-model.ts`: pure grouping/ordering; `src/ui/obsidian-browser-tree-view.ts`: ItemView, menu and DOM interactions.
- `src/integrations/obsidian-search-surfaces.ts`: native empty-view search lifecycle.
- `src/main.ts`: official Obsidian commands, registration and settings integration.
- `src/ui/browser-view.ts`, `src/ui/web-content-menu-model.ts`, `src/ui/context-menus.ts`: browser host actions.

## Automated validation

Run `npm run verify`. In addition to the existing core/UX/password/preload/build/release tests, the suite now checks:

- `tests/obsidian-web-transfer-smoke.ts`: URL fragments, commas/UTF-8, safe source notes, tab Markdown, video timestamps.
- `tests/obsidian-vault-bookmark-mirror-smoke.ts`: new bookmark mirroring, note edit roundtrip, rename identity, note deletion, UBC deletion, disabling/re-enabling after offline note edit, malformed YAML preservation, no self-resurrection on queued events.
- `tests/obsidian-browser-tree-model-smoke.ts`: group assignment and persisted ordering independent of the physical tab strip.

## macOS isolated Obsidian 1.15.0 QA

Connected QA instance reused: remote debugging port 19229, vault `macos-qa-vault`. No additional browser/profile spawned.

- `Vault mirror`: enabled on QA only; created managed bookmark note with stable ID, edited its title/favorite via Obsidian `processFrontMatter`, observed both changes in UBC, deleted note and observed UBC bookmark deletion. Returned sync to disabled.
- `Tab tree`: sidebar view registered. Initial construction exposed a detached-DOM check bug; adjusted `render()` to render into detached Obsidian ItemView root before workspace insertion. Subsequent QA confirmed initial tree, 10 existing tabs, a new tab appearing dynamically and draggable tree entries. The test detached its created sidebar and tab.
- `Markdown header search`: input appears in note header, Enter removes it and creates exactly one UBC search tab with the correct query; test tab closed afterwards.
- `Empty-view search`: native empty tab has an independent search form when replacement is disabled; Enter opens the specified URL in exactly one UBC tab; test leaves cleaned.
- `Web→note`: host drag handle writes a valid Markdown hyperlink into DataTransfer; selected text clipping wrote the expected YAML source and two quoted lines into a new QA note. Test note and browser tab were removed afterward.
- `full npm run verify`: TypeScript, smoke tests, password/preload contracts, production build, release artifact passed.

**Final background QA caveat:** On the beta.3 bundle, replaying the old full `qa/obsidian-integration-macos.mjs` while the QA Obsidian window remained hidden first found the CodeMirror link layout unready; a second run stalled on an awaited workspace operation. The *test Node process* was terminated while the isolated Obsidian process and its vault were left running. **The full replay did not pass** on that last attempt; individual phase-2 interactive fixtures above and the full static/contract suite passed. Do not generalize this into a claim that every GUI case passed on beta.3.

## Remaining/limits outside the two Pending items

1. Actual native mouse drag-and-drop *into CodeMirror* is not covered by synthetic DataTransfer; handoff was checked but final drop UX still needs GUI QA.
2. Tab-tree group order is a **virtual sidebar projection**. It does not move physical Obsidian tab containers, and saved workspace restoration is additive (does not close existing tabs). A full multi-Workspace persistence matrix is not yet proven.
3. Native Surfing `surfing-bookmarks/*.md` still lacks event-driven live import; current Vault sync is for UBC's dedicated folder. Source-folder edit/write safety must precede any cross-plugin ownership changes.
4. Multiple Obsidian popouts, native Page Preview coexistence, native real-pointer hover dwell, OS scheme `obsidian://web-open`, dynamic Surfing/UBC enable/disable ordering, and background Markdown code-block rerendering remain integration QA work.
5. No deliberate change was made to the two Pending feature areas.

## Checkpoints

- `acfdcf5`: previously completed Obsidian link/Canvas-action/hover integration, beta.2.
- `1538bfa`: phase 2 Web–Vault transfer + live bookmark mirror + commands, with Pending backlog recorded.
- Subsequent commit: sidebar tab-tree, Obsidian search surfaces, drag/drop source, video timestamp, additional QA and documentation. Check `git log -1` for finalized hash.
