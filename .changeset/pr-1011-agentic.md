---
"@agentproto/workspace-brain": minor
"@agentproto/runtime": patch
---

Add skip-tracking to workspace brain to prevent re-ingestion of permanently-unavailable sessions. Skips are recorded in brain-state.json and excluded from pendingSessions backlog, but are not tombstones — explicit re-ingests and later successful ingests clear them automatically.
