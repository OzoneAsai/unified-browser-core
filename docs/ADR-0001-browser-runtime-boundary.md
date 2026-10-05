# ADR-0001: Browser runtime boundary

Status: Accepted

## Context

Unified Browser Core needs stronger browser semantics than a simple embedded page:

- persistent container sessions
- graph history and rich closed-tab recovery
- permission ownership
- popup ownership
- form recovery
- Browser Core context menus and navigation events

Electron currently exposes those controls most directly through guest web contents. Electron discourages new designs from coupling themselves tightly to the `<webview>` tag, but Surfing remains an important Obsidian precedent: it has used an embedded web view as its core browsing surface across many Obsidian releases. Browser Core therefore treats Surfing-compatible WebView behavior as the practical compatibility baseline rather than as a temporary implementation to be removed on principle.

## Decision

Browser Core semantics are independent from the rendering runtime, but the managed WebView backend is the primary desktop runtime for the current architecture.

Direct `<webview>` construction lives only in `ManagedWebviewBackend`, and private Electron bridging lives only in the Electron compatibility adapters. This boundary exists to contain Obsidian/Electron coupling, not to force an immediate rewrite to another rendering technology.

The current backend is allowed to remain the default as long as it continues to behave correctly on supported Obsidian releases. A future runtime may replace it only when that runtime provides the required capabilities with equal or better compatibility.

Required capabilities are conceptually:

- isolated persistent session
- navigation observation and traversal
- rich navigation-history capture/restore when available
- permission interception
- popup interception
- script execution for optional form recovery
- context-menu metadata
- zoom and developer inspection

An Obsidian Web Viewer backend is optional rather than preferred by default. It becomes useful only if a stable public interface exposes the capabilities required by Browser Core. Likewise, WebContentsView is a future option only if Obsidian exposes a safe main-process bridge and positioning lifecycle for community plugins.

If a runtime lacks a capability, the Core must degrade explicitly rather than silently creating a second source of truth. Browser Core does not split one logical tab across multiple rendering backends merely to satisfy a feature.

## Popup rule

Guest pages never own unmanaged native popup creation.

The managed backend keeps WebView popups under Browser Core ownership. Ordinary `window.open()` and `target=_blank` intents become Browser Core tabs/windows and inherit the opener container. Authentication flows that require a same-session named or sized auxiliary window may use an owned auxiliary Electron window, but that window remains tied to the opener lifecycle and container session.

Window-feature text alone does not make a request auxiliary. Unrecognized/non-presentation features remain Browser Core tabs, and `noopener`/`noreferrer` explicitly remove the native-opener requirement. A request is auxiliary only when it retains opener semantics and names a non-reserved browsing context or explicitly asks for popup/window geometry such as `popup=yes`, `width`, `height`, `left`, or `top`. This keeps ordinary web resources—including browser-renderable documents such as PDFs—under Browser Core ownership instead of delegating them to the host or operating-system browser.

On the current Obsidian/Electron runtime, the auxiliary allow/deny decision must execute synchronously in the Electron main process to preserve native `window.opener` semantics. Browser Core therefore installs a small main-process window-open runtime through the isolated Electron compatibility boundary. Ordinary new-tab requests are denied there and forwarded back to Browser Core through a scoped IPC channel; named or sized auxiliary requests are allowed there with `outlivesOpener: false`, so Electron keeps the opener relationship and inherited container session intact.

The WebView keeps Surfing-compatible popup capability only while that control point can be established. Browser Core attempts to bind the guest runtime when the guest attaches and retries at `dom-ready`, matching Surfing's proven timing for guest `webContents` access. If the owned handler is still unavailable by `dom-ready`, Browser Core removes `allowpopups` rather than leaving unmanaged popup creation enabled. Hosts that cannot install the main-process runtime degrade auxiliary requests to Browser Core tabs; opener-dependent authentication may be reduced in that fallback, but popup ownership is not abandoned.

## Container routing and authentication affinity

Site assignment is a rule for choosing the container of an independent browsing context; it is not a rule for tearing an already-running browsing context out of its session whenever the hostname changes.

For example, `google.com -> Search` and `chatgpt.com -> Personal` imply that a standalone open of `accounts.google.com` normally routes to Search because the `google.com` rule matches its subdomain. However, when ChatGPT running in Personal starts a Google sign-in flow, redirects in that WebView and tabs/windows spawned by that page retain Personal as opener affinity. This allows `chatgpt.com -> accounts.google.com -> chatgpt.com` to complete inside one authenticated session even though `accounts.google.com` has a different ordinary site assignment.

Browser Core distinguishes this opener affinity from an explicit user override. Both may temporarily bypass a site assignment, but their provenance is preserved so UI and future policy can treat them differently.

## Session rule

Container identity belongs to Browser Core. A runtime receives a container partition when it is created. A live tab never mutates its partition; changing containers means reopening into a new tab lifecycle.

## Obsidian boundary

Obsidian-private workspace DOM and header operations live in Obsidian adapters. Browser Core tab styling may mark Browser Core tab headers, but must not impose width rules on unrelated Markdown, Canvas, PDF or other tabs.

Tab-strip integration is optional and can be disabled when another workspace/tab plugin owns that surface.

## Persistence boundary

Core stores are independent from their persistence backend.

Large history/restore/form data currently use a hybrid persistence adapter to avoid rewriting a growing `data.json` on every navigation. This is an implementation policy, not a domain assumption. Community-directory compatibility must be reviewed against current Obsidian guidance before release; the persistence port can be replaced without changing history, recovery or container semantics.

## Form recovery rule

Form recovery is disabled by default and additionally requires explicit per-site opt-in.

Password, payment, one-time-code, WebAuthn, file and hidden fields are excluded from ordinary form recovery. Form snapshots have independent age, per-URL generation and URL-count limits, and users can clear all stored form data.

## Runtime evolution rule

`BrowserView` may continue to consume WebView behavior through a thin adapter while that path remains the most compatible route in Obsidian. Further abstraction is justified when it removes a real compatibility problem, enables testing, or allows a proven replacement runtime. It is not a goal to abstract every WebView event merely to make the type disappear from the codebase.

Surfing is used as the practical reference for Obsidian compatibility. Browser Core may intentionally diverge where its stronger model requires it, especially for container isolation, graph history, popup ownership, recovery, permissions and public API boundaries.
