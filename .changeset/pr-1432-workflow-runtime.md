---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": patch
"@agentproto/workflow": patch
---

`kind: branch` arms are now exclusive with an explicit join (F22): exactly one arm body runs (its target up to the next arm's target / the optional `join:` step), then execution continues at the join. `fallthrough: true` keeps the legacy target-plus-every-later-sibling semantics. Untaken arms' steps are reported via a new `onStepSkipped` hook and surface as `skipped` rows plus AIP-58 `step.skipped` events.
