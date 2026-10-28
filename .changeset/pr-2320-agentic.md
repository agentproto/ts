---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Collapse restart / continue-fresh / `agent_start.succeeds` lineage chains to their live tail in session listings. Adds the exported `collapseLineageChains` helper, an opt-in `collapseLineage:true` parameter on `session_list` and `GET /sessions`, and always-on collapsing for `agentproto sessions board` so a repeatedly restarted long-lived session no longer accumulates one dead row per restart under the same label. (Confirms/duplicates `.changeset/collapse-lineage-chains.md`, already included in this PR.)
