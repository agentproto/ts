---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
---

Agent workflow steps accept `placement` (an ordered sandbox ladder) and `turnRetry` (usage-limit and rate-limit fallback) selectors, and export the `AgentPlacementRef` and `AgentTurnRetryRef` types. The runtime session host forwards both onto the spawn, and a failed sandbox boot now settles its dedupe claim, so a labelled spawn walking a placement ladder moves on to the next rung instead of waiting on its own failed first attempt. The CI review-lane skill doc now describes the placement ladder and the turn-retry fallback.
