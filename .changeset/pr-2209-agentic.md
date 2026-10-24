---
"@agentproto/runtime": patch
---

Keep box sessions alive across a dropped relay stream: re-open the structured `/events/stream` from the last consumed transcript seq with a bounded retry budget instead of declaring the box dead, reconstruct live tool-call phase state from flattened relay `[tool]` lines, and surface ring-buffer output on long-poll timeouts so long-running box builds don't trip the stall watchdog.
