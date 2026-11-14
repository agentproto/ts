---
"@agentproto/runtime": patch
---

A Claude Desktop supervisor can now drive the children it spawns. `agent_start` from the shared `claude-desktop` identity with `parent: "cc:<id>"` and no `allowPromptFrom` records `["claude-desktop"]` on the child, so `agent_kill`, `agent_prompt`, `agent_interrupt`, `session_restart` and `session_continue_fresh` are no longer refused as owner-only (the recorded owner is a `cc:` row a Desktop call cannot present). An explicit `allowPromptFrom`, including `[]`, is never touched, and verified or identity-less callers get no new right.
