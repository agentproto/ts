---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Fix the approval card never rendering in Claude Desktop. The card and terminal panel now send `ui/initialize` with `appInfo` and spec `appCapabilities` (they sent `clientInfo`, which Desktop drops), and the card's buttons stay disabled until the handshake succeeds while its details are in the HTML from the start. `install-mcp --approvals --write` now also writes the `agentproto-approvals` entry into the Claude-3p profile when its config exists, with a backup, using absolute node and cli script paths so a Dock-launched Desktop can start it, and reminds you to quit Claude (Cmd+Q) first.
