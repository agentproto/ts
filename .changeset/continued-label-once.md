---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Continue-fresh no longer renames the session: the new session keeps EXACTLY the previous label and title (like a session that compacts in place), and the continuation lineage is shown separately via a new `continuationGeneration` descriptor field (previous generation + 1, starting at 1; exposed in the session list/show/tree/evidence projections). Sessions still carrying a legacy ` (continued)` / ` (continued N)` suffix get their clean name back on their next continuation (`stripContinuedSuffix`). VS Code session rows show a `↻ N` badge with a "Continued N times — previous: <prev>" tooltip and an action to open the previous session in the chain.
