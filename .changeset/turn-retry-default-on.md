---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Graceful turn retry by default for executor and sandbox agent starts: a
spawn without `turnRetry` now gets a default policy (retry on rate-limit,
upstream-5xx and no-output-stall; 6 retries; default backoff) instead of
letting a transient provider failure stop the turn. A free OpenCode model
also rotates onto other free ids on every covered class by default; paid
models never rotate by default. Explicit opt-out is `turnRetry: null`, an
empty `on` list, or the CLI shorthand `--turn-retry off`.
