---
"@agentproto/runtime": patch
---

`agent_prompt`, `agent_interrupt` and `agent_kill` accept `sessionId` (or `id`) as `"label:<operatorLabel>"`, resolved by the same resolver as `message_send` to the single live session carrying that immutable operator label (no live match is `no_live_session_for_label`, several is `ambiguous_label`). The owner gate and `session:prompt` / `session:control` grants run on the resolved session, so a label never widens who can drive it.
