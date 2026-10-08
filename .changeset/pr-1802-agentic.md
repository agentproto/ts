---
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-codex": patch
"@agentproto/runtime": patch
---

Add optional `stateHome.seed` (name → content) to the agent-cli driver, written into the isolated per-session home on confined spawns. The codex adapter uses it to ship `project_root_markers = []`. Runtime change is test-only.
