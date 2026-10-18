---
"@agentproto/runtime": minor
---

Default `turnRetry` for executor and sandbox spawns: a spawn that names no policy now retries transient failures (rate-limit, upstream-5xx, no-output-stall; 6 retries; default backoff) instead of stopping the turn, and a free OpenCode model rotates onto other free ids by default. Supervisor spawns stay opt-in, and an explicit `turnRetry: null` or empty `on` disables retrying.
