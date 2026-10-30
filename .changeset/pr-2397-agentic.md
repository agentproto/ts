---
"@agentproto/runtime": major
"@agentproto/apps": patch
---

Adds `contextSettings` as the AIP-46 name of the context-continuity block on `agent_start`, `POST /sessions/agent` and in `defaults.contextSettings` / `defaults.adapters.<slug>.contextSettings`, keeping `contextContinuity` as an alias. Spawn defaults now layer context settings setting by setting across the daemon, adapter and request blocks, with each layer winning only the keys it sets; this changes the effective policy for callers that previously passed a partial `contextContinuity` block and relied on whole-object replacement (e.g. a partial request block now inherits the daemon's percent bands and auto-compact threshold instead of the built-in defaults), hence the major bump. The config UI registers the new keys alongside the legacy ones.
