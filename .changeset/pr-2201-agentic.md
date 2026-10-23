---
"@agentproto/runtime": minor
---

Add `turnRetry.fallback` overlays that move a failed session across models, auth profiles and harnesses after same-config retries are exhausted, recording each step and emitting a `session:fallback` event.
