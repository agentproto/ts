---
"@agentproto/runtime": patch
---

Passive wake for Claude Desktop sessions behind the shared unverified `claude-desktop` MCP identity: `agent_start.parent` now accepts the caller's own declared `cc:<session_id>` from that identity (a verified identity still may not declare a parent), so the child's `message_parent` and follow digests land on the `cc:` row's hook inbox / socket wake instead of the shared inbox. `message_reply` to a message sent from `claude-desktop` with `replyTo: "cc:<id>"` is routed to that declared row (new rule `messaging.declaredReply`, capped at steer). The `agent_start.parent` and `message_send.replyTo` schema text tell a Claude Desktop agent to pass its own session id.
