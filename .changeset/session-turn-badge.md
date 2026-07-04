---
"@agentproto/runtime": patch
---

Sessions panel: turn-aware status badge for agent-cli sessions. A running agent-cli process now shows `working` (turn in flight), `waiting` (awaiting input), or `idle` (process alive, no turn running) instead of a flat `running`, reading the `busy`/`awaitingInput` descriptor fields.
