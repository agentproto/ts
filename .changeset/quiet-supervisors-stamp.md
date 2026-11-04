---
"@agentproto/runtime": patch
---

Fix the PR provenance footer crediting a supervisor instead of its executor: the reconciler's branch lane no longer stamps a session that supervises a child sharing its cwd, so a body that lost its footer is restamped by the executor that wrote the PR (agentproto/ts#2541, #2542).
