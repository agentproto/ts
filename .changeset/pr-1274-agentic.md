---
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
---

`agent_prompt` now queues by default: a prompt sent to a mid-turn session is parked on the session's FIFO `promptQueue` and dispatched at turn end (matching the CLI and HTTP arms). Explicit `queue: false` still rejects with a `mid-turn` error. `inbound-router.ts` always passes `{ queue: true }`. Skill docs updated to describe the new queue-by-default behavior.