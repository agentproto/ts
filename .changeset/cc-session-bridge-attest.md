---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

The stdio `mcp-bridge` now attests the real Claude Code session: when `CLAUDE_CODE_SESSION_ID` is in its environment (and well formed) it sends `x-agentproto-claude-session` on every request it proxies. The daemon resolves a call that carries that header and the shared `claude-desktop` identity (or none) to the external row `cc:<id>`, the one the hooks touch, so `agent_start` attaches children under it, `message_parent` reaches its hook inbox / socket wake, and sent messages are attributed `cc:<id>` (still unverified). A declared `agent_start.parent` equal to that row is accepted, a different one is refused.
