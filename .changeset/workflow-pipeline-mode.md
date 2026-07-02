---
"@agentproto/workflow-runtime": minor
---

Add a `pipeline` step kind: N items each flow through K sequential stage bodies as an
independent chain with no cross-item barrier (item A can be at stage 3 while item B is at
stage 1), bounded only by a shared `concurrency` cap. Complements `map` (barrier-per-chunk)
and `parallel` (fixed branches).