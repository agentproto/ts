---
"@agentproto/runtime": minor
---

The five drive tools (`agent_prompt`, `agent_interrupt`, `agent_kill`, `session_restart`, `session_continue_fresh`) are now decided by `decide()`: `session.drive` is routed and authoritative, with unchanged outcomes. A matching `session:prompt` or `session:control` grant under `defaults.messaging.grants` can now admit a caller the legacy owner gate refuses; with no grants configured nothing changes.
