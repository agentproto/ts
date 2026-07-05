---
"@agentproto/runtime": minor
---

Add spawn-time role profiles (executor/supervisor) with a hard delegation-tool gate — `agent_start` gains `role` + `promptAppend`, and a role that denies delegation strips `agent_start`/`agent_prompt` from the child's toolset (orchestrator requests dropped, hermes-default gateway gated via `denyTools`). Spawns made through an orchestrator now default to `executor` unless `role` is passed explicitly or `defaults.defaultRoleDepthCutoff` is raised in config.json.
