# Explicitly deferred by user — 2026-11-10

The following two items are **PENDING** and must not be implemented as part of the present Obsidian integration work:

1. **HTML file embeds in Markdown notes** (`![[example.html]]`, Obsidian `embedRegistry` HTML/HTM renderer). Existing `.html` file tab opening and URL code blocks are not the pending feature.
2. **Full Canvas-internal UBC WebView integration** (replace/own the Canvas node's guest, Container session, history, navigation and toolbar). The existing non-invasive Open in UBC Canvas action should remain and may be regression-tested.

Proceed instead with the remaining Obsidian integration features: Web-to-Vault information transfer; Vault bookmark live synchronization; editor commands; browser tab/Workspace and empty-tab search UI; and coexistence/lifecycle QA. Do not treat validation-only remaining work as an unimplemented feature.
