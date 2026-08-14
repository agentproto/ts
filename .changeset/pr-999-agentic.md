---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Fix phantom-PR regression where sessions at the repo root would incorrectly attribute open PRs that happen to be on the default branch. Add default-branch guard to `makeOpenPrResolver` and only record PRs when actually stamped for the first time, preventing misattribution on idempotent re-reads.
