---
"@agentproto/cli": patch
---

`install-mcp --agent claude-desktop` also writes the shared Chat-tab identity into the Claude-3p profile's `claude_desktop_config.json` when that file exists. Before, only the `Claude/` profile was updated, so a Chat conversation in the other profile kept the old no-identity entry and sent as the anonymous `claude-code` sender.
