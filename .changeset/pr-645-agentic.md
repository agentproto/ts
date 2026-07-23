---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Add `agentproto sessions gc` CLI command and `POST /sessions/gc` HTTP endpoint for bulk garbage collection of terminal-status sessions. Supports `--older-than-days` (cutoff filter), `--forget` (permanent deletion vs. reversible archival), and `--json` (scripting output).
