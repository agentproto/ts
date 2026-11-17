---
"@agentproto/runtime": minor
---

New MCP tool `desktop_conversation_ask { app: "claude", id, text, urgency?, waitMs? }`: sends a message to a Claude Desktop conversation listed by `desktop_conversation_list` (registering its `cc:<id>` external row) and waits for its answer in the transcript. Delivery is the daemon's existing external path: a direct wake over the chat's Claude Code socket when `daemon.claudeSocketWake` is on, else the chat's inbox (reported as `delivered.via`, no reply). Codex is refused for now.
