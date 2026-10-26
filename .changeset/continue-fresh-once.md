---
"@agentproto/runtime": patch
---

Allow at most one continue-fresh per source session: a duplicate or concurrent call now returns the first call's checkpoint and successor instead of spawning a second one.
