---
"@agentproto/runtime": patch
---

Pick the most recent checkpoint when a relaunch correlates a dead session by task id, matching the existing most-recent rule for labels, and add regression coverage for inherited correlation keys and non-`wt/` delivery branches.
