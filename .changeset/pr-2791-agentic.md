---
"@agentproto/runtime": patch
---

Tests in `model-list-store.test.ts` no longer hard-code the real catalog id `big-pickle`: the zero-cost membership assertion takes its model from the shared `FREE_MODEL` helper (a live zero-priced opencode id), and the fail-closed missing/cyclic list checks use a synthetic `acme/some-model` id, so a weekly Catalog Sync retiring `big-pickle` can no longer break the suite.
