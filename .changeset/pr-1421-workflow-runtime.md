---
"@agentproto/workflow-runtime": patch
"@agentproto/runtime": patch
"@agentproto/workflow": patch
"@agentproto/skill-pack-agentproto": patch
---

Step cache fixes: a declarative `kind: "tool"` step's `cacheable: true` now survives compilation and replays from the journal; each `map`/`pipeline` item gets its own journal key (`[i]` path) instead of all items overwriting one entry; a cache-hit step still fires `onStepStart`/`onStepComplete` (with a new `info` argument, `{ cached: true }`), so `workflow_status` lists it as `done` with `cached: true`, and AIP-58 `step.started`/`step.succeeded` events carry `data.cached`.
