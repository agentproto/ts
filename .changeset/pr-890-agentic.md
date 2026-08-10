---
"@agentproto/apps": minor
"@agentproto/runtime": minor
---

Extend MCP app bridge wire (spec 2026-01-26) with three new methods and enhance mail-triage UI:

- **Bridge extension** (`@agentproto/runtime`): Add `updateModelContext`, `openLink`, and `onTeardown` methods to the `window.McpApp.connect()` promise surface. `updateModelContext` sends contextual information to the host (replaces previous context); `openLink` opens URLs; `onTeardown` registers cleanup callbacks invoked on `ui/resource-teardown`.
- **Mail-triage UI** (`@agentproto/apps`): Add email selection via checkboxes, "Send selection to Claude" button to call `updateModelContext` with selected email metadata, and "Open" links to open threads directly in Gmail via `openLink`. Register teardown handler to clear polling timers.
