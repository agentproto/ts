---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

Add `AgentStep.access` / `AgentStep.route` and forward model-role auth `profile` and `route` to the maintain workflow's reviewer spawns. Add the opt-in `maintain --apply-reviewed` input, which reclaims agreed `review`-class branches subject to `branch_gc`'s line-coverage guard and reports guard refusals in the run report.
