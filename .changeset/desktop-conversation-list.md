---
"@agentproto/runtime": minor
---

New read-only MCP tool `desktop_conversation_list`: lists the Claude Desktop (Code tab) and Codex Desktop conversations from the apps' own local stores (`Claude` and `Claude-3p` `claude-code-sessions/*.json`, `~/.codex/state_5.sqlite`), newest first, with the `cc:<id>` / `codex:<id>` address each chat uses when it calls the daemon. Includes chats that never called agentproto.
