---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Give the Claude Desktop Chat tab one shared, declared `claude-desktop` identity: `install-mcp` pins the shared MCP URL (with `--dry-run` to print the entry without writing), `hook install --host claude-desktop` prints that URL and ignores `--session`, and messages from a claimed external id are labelled `unverified` in delivered text and inbox digests.
