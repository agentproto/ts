---
"@agentproto/cli": minor
"@agentproto/runtime": patch
"@agentproto/apps": patch
---

Reach Bureau natively from stdio clients, and stop the daemon browser relays from misleading agents.

`@agentproto/cli`: `agentproto mcp-bridge --import <alias|importId>` dials the daemon's `/mcp/imported/<id>` instead of `/mcp`, so a stdio client (Codex app, Claude Desktop) gets one imported server (for example `bureau`) under its own tool names. Same auth and caller identity as `/mcp`; refused together with `--surface`. `agentproto install-mcp --import <alias>` writes such an entry (cursor, codex, claude-desktop, windsurf), named after the alias.

`@agentproto/runtime`: every relayed `browser_*` tool's description now starts by saying it is a deprecated relay and names the Bureau tool it runs; the `deprecated` note on results says how to reach Bureau (a `bureau` MCP server, or `mcp_imported_call` with alias `bureau`). `browser_press_key` refuses `selector` and `count` with an error instead of forwarding them to a Bureau tool that ignores them. Stale comments and README lines about `browser_new_tab` / `browser_upload_file` corrected.

`@agentproto/apps`: the `agentproto_bureau_sessions` panel description says what it is (a legacy chrome-live browser-session list, not Bureau).
