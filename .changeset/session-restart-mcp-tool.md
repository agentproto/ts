---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add a `session_restart` MCP tool so an orchestrator can bring a killed agent-cli or terminal session back with conversation continuity, without shelling out to the CLI. The resume decision tree (provider-native resume vs ACP resume vs plain PTY re-run vs unsupported) is now shared between `agentproto sessions restart` and the new tool via `resume-strategies.ts`, so the two surfaces can't drift apart.
