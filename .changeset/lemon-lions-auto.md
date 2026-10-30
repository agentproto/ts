---
"@agentproto/runtime": patch
"@agentproto/session-presets": patch
---

Spawn sandbox sessions without the initial prompt, then deliver it over the box's `agent_prompt`, so a cold box's adapter install and first session cannot hold the spawn request open. Keep a bounded `agent_start` request ceiling (5 min, below the outer spawn budget) and log box id, adapter and elapsed ms on boot and restart failures.
