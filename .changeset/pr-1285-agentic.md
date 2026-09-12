---
"@agentproto/cli": minor
---

`sessions start` gains `--max-cost-usd` (hard turn-end spend ceiling, the CLI twin of the MCP `agent_start.maxCostUsd` kill switch) and `--cost-budget` (windowed governance cap `{maxCostUsd, window, scope}` that never kills the session, the twin of `agent_start.costBudget`), accepting both a compact `<usd>:<window>[:<scope>]` spelling and a full JSON object.

---
"@agentproto/runtime": minor
---

`POST /sessions/agent` (and the create-variant chat route) now forwards `maxCostUsd` and `costBudget` from the JSON body onto the spawn input via `buildSpawnSessionHttpArgs`, so HTTP spawns carry the same spend caps as MCP `agent_start`. Malformed values are dropped rather than guessed.
