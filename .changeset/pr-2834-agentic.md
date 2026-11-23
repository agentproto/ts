---
"agentproto-vscode": patch
---

The VS Code Apps view pages the daemon's MCP-only `app_list` with limit/cursor so a large installed-app registry no longer trips the daemon's MCP result cap and reads back as the `{ truncated: true }` stub — which the tree used to render as an empty registry. A page that still exceeds the cap is retried with a halved limit; a single record over the cap throws instead of resolving to an empty list, and a daemon that predates limit/cursor falls back to the unpaged call. A failed load now shows a "Couldn't load apps" row with a retry command rather than the "Browse the App Store" empty row.
