---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Collapse restart/continue-fresh/`agent_start.succeeds` chains in session listing instead of showing every retired hop under the same label. `session_list`'s new `collapseLineage:true` and `GET /sessions?collapseLineage=true` hide a row whenever another row in the same result points back to it via `resumedFrom`, `continuedFrom` or `succeeds`; `agentproto sessions board` always applies it, since a glanceable one-row-per-session board was otherwise accumulating one dead row per restart for any long-lived session (a persistent brain, a PM) that gets restarted repeatedly.
