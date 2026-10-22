---
"@agentproto/runtime": patch
---

Forward the agent-level `hooks` object (including `hooks.clerk`) from `POST /sessions/agent` and `POST /sessions/chat` to the shared spawn core, so an HTTP spawn no longer silently drops a manifest's `metadata.hooks.clerk` and behaves like the MCP `agent_start` path.
