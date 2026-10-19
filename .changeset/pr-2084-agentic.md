---
"@agentproto/runtime": minor
---

Session-owner prompt gate: `agent_prompt` / `agent_interrupt` / `agent_kill` /
`session_restart` / `session_continue_fresh` now refuse calls from another agent
session unless the caller is the target's owner (the spawner, via
`parentSessionId`, or any ancestor with subtree authority for transitive
descendants), the target itself, the operator, or named in the target's
spawn-time `allowPromptFrom` option (session ids or the `"any"` wildcard). Adds
the `agent_set_prompt_policy` MCP tool for changing the allow-list later, the
`allowPromptFrom` spawn option and `SessionDescriptor.allowPromptFrom` field,
exported `session-owner.ts` gate helpers, and a `session:prompt` audit event
recording who sent each accepted prompt. Spawn-time roles are also forwarded
onto sandbox box daemons so delegation gates apply consistently.
