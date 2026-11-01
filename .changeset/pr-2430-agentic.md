---
"@agentproto/runtime": minor
---

Route the five drive tools (`agent_prompt`, `agent_interrupt`, `agent_kill`, `session_restart`, `session_continue_fresh`) through `decide()` so `session.drive` is authoritative, and let explicit `session:prompt` / `session:control` grants under `defaults.messaging.grants` admit a caller the legacy owner gate refuses. With no grants configured behavior is unchanged.
