---
"@agentproto/runtime": minor
---

Only a session's owner can drive it through the daemon's drive tools. The owner
of a session is the caller that spawned it (its `parentSessionId`), or the human
operator for a root spawn. `agent_prompt`, `agent_interrupt`, `agent_kill`,
`session_restart`, and `session_continue_fresh` now refuse calls coming from
ANOTHER agent session, unless the target's spawn-time `allowPromptFrom` spawn
option (session ids, or the wildcard `"any"`) names the caller. The
`agent_set_prompt_policy` MCP tool changes the list later — only the session
itself, its owner, or the operator may. The operator (a CLI/HTTP/UI client with
no caller session) keeps full rights, and all existing parent→child flows keep
working: the session owner always passes.

Every accepted `agent_prompt` now also records WHO sent it in the session
events (`session:prompt`: the trusted callerSessionId, or the literal
`"operator"` for a no-caller call) — a session-level audit trail of whose
prompts drive it.

Role enforcement is consistent in box daemons too: a spawn-time role is
forwarded onto a sandbox box's own `agent_start`, so the box daemon applies the
same delegation gate (denyTools on its own daemon self-mount) the host would,
instead of re-resolving the role from nothing executor-side.
