---
"@agentproto/runtime": patch
---

`agent_start.parent` now accepts the caller's own declared `cc:<session_id>` from the shared unverified `claude-desktop` MCP identity (a verified identity still may not declare a parent), so the child's `message_parent` and follow digests land on the `cc:` row's hook inbox / socket wake instead of the shared inbox. The schema text tells a Claude Desktop agent to pass its own session id.
