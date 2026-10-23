---
"@agentproto/runtime": minor
---

Make `allowPromptFrom` and `operatorLabel` survive restart/continue-fresh and the HTTP spawn path.

- New MCP tool `agent_set_operator_label`: lets the human operator stamp a
  session's operator-assigned `operatorLabel` directly, without a fresh root
  spawn.
  Needed for a lineage that has lived by resume/continue-fresh since before
  it ever got a label, so there was never a prior label for the existing
  carry-forward logic to propagate.
- `session_restart` and `session_continue_fresh` now also carry forward
  `allowPromptFrom` from the replaced session to its successor, the same way
  they already carry forward `operatorLabel`. Previously a permanent agent's
  drive grants (e.g. a `label:` grant) were silently dropped at the next
  restart/continuation.
- `POST /sessions/agent` now applies `allowPromptFrom` post-spawn, the same
  way the `agent_start` MCP tool handler already does. Previously the HTTP
  spawn path (used by non-MCP callers such as Pygmalion's `EngineClient`)
  silently accepted and dropped the field.
