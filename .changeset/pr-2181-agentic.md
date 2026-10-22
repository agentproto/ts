---
"@agentproto/runtime": minor
---

`agent_start` now answers with a compact descriptor by default (identity/routing fields plus counters), with `full: true` restoring the raw descriptor and `fields: [...]` selecting an explicit allowlist. The harness slash-command list moves to the new paginated `session_commands` tool, referenced from `agent_start` via `commandsRef`.
