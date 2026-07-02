---
"@agentproto/cli": minor
---

Add `hermes` as a target for `agentproto install-mcp` — registers the daemon's MCP
server as an HTTP entry under `mcp_servers.agentproto` in `~/.hermes/config.yaml`.
The edit is surgical: it inserts/updates only the `agentproto` entry (backing the
config up first) and `--uninstall` removes only that entry, so sibling MCP servers
(bureau, guilde, …) and the rest of the hand-maintained config are preserved.
