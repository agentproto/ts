---
"@agentproto/sandbox": minor
---

Pause is the default sandbox teardown: closing a session with no `lifecycle` declaration now pauses the box (`pause({ keepMemory: true })`) instead of killing it, so every closed box stays reattachable via `sandbox.reuse` / `agentproto sandbox attach`. Explicit declarations stay authoritative — `lifecycle.destroy_on` kills, `pause_after_idle` pauses. Paused boxes still die at their own `timeoutMs` (45 min by default), so pauses don't accumulate indefinitely.
