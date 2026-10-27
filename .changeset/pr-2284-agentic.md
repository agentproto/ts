---
"@agentproto/runtime": minor
---

Make the AIP-42 `on` map of a workspace `AGENT.md` live: the daemon rescans `.agents/<id>/AGENT.md` on every routine reconcile, scopes each entry to sessions whose `meta.agentId` matches the declaring agent, and fires the named action for `agentproto:session-completed`.
