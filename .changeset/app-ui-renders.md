---
"@agentproto/app-kit": minor
---

New optional `ui.renders`: the subset of `ui.tools` whose results the host displays in the app's UI. A server publishing the app as an MCP App links those tools to the app's `ui://` resource. `defineApp` rejects ids missing from `ui.tools` and duplicates; the field round-trips through `emit` and `loadAppHandle`.
