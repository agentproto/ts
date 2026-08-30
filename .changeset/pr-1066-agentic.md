---
"@agentproto/model-catalog": patch
"@agentproto/runtime": patch
---

Make live OpenRouter pricing resilient to testing via snapshots instead of hardcoded assertions. Prices are re-synced weekly by catalog-sync, so snapshot diffs show legitimate changes as reviewable without breaking CI. Also fixes changeset naming collision in sync script that broke #1040/#1063.
