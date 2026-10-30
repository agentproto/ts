---
"@agentproto/runtime": patch
"@agentproto/session-presets": patch
---

runtime: spawn a box session without the initial prompt and deliver it with the box's own `agent_prompt` afterward, both on boot and restart, so a cold box that installs an adapter before answering does not time out the spawn dial. Log sandbox `agent_start` failures with box id, adapter and elapsed ms.

session-presets: keep the `agent_start` request ceiling at 5 minutes, below the outer spawn budget, instead of raising it to the outer budget.
