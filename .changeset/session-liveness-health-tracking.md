---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/acp": minor
"@agentproto/cli": patch
---

Add session liveness / health tracking: real `pid` threading from the spawned
adapter process through to `SessionDescriptor` (was hardcoded `null` for every
agent-cli session), a new `lastActivityAt` heartbeat that pulses on ANY ACP
JSON-RPC traffic — not just ring-buffer output lines — so it stays current
during long internal tool-call chains where `lastOutputAt` goes stale, and a
`processAlive` field computed at read time via `process.kill(pid, 0)`. All
three surface automatically on `session_list` / `agent_sessions_list` /
`session_monitor` — no new MCP tool.
