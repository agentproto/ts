---
"@agentproto/apps": patch
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Three fixes around MCP app panels and session restart:

- **MCP bridge injection** (`@agentproto/runtime`, `@agentproto/apps`): fix the idempotency check that incorrectly skipped injection for documents consuming `window.McpApp.connect()` — regex narrowed from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Defensive guard in mail-triage UI when the bridge is missing.
- **Credential re-resolution on restart** (`@agentproto/runtime`): pass `accessProfileRef` to `resolveResumeAuth` so restarting a session that used a named auth profile re-reads the current credential from the keychain instead of falling back to a stale mode-based path.
- **Restart loading state** (`agentproto-vscode`): show a loading state and disable the restart button while a session restart is in flight; new `restartFailed` webview message resets the state on error.
