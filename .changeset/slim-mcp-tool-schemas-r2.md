---
"@agentproto/runtime": patch
---

Slim the daemon's always-on MCP `tools/list` payload again. `agent_start`
drops from ~28.2 KB to ~9.8 KB and the deferred always-on set from ~63.0 KB
to ~39.0 KB, with no parameter rename, behaviour, default or runtime-validation
change.

The remaining weight was structural: roughly fifty parameters, many rarely
used, with nested object schemas enumerating every sub-field. `agent_start`'s
structured nested options (`sandbox`, `worktree`, `orchestrator`, `inference`,
`auth`, `access`, `mcpServers`, `contextContinuity`, `restartPolicy`,
`costBudget`, `appServe`, `attach`, `options`, `route`, `browser`, `prompt`)
are now advertised as opaque values (`tool-schema-opaque.ts`, the
`sandboxCheckpoint` pattern) so `tools/list` sends `{description}` instead of
every sub-field, while the REAL zod validation at spawn time still runs,
returns the schema's parsed output (transforms, defaults and unknown-key
stripping all preserved, e.g. `browser: true` still normalizes to
`"headless"`) and still reports the original issue path and message (e.g.
`access.profileRef: ...`). The full sub-field detail moved to
`docs/mcp-tools/*.md`, fetched on demand via
`tool_help {name:"agent_start", topic:"<field>"}`.

The next five always-on tools (`session_list`, `task_create`, `task_update`,
`agent_prompt`, `message_parent`) get the same treatment at smaller scale, with
new `tool_help` docs for their opaque nested options. `turnRetry` is untouched
(another change edits it). The schema-budget test now also caps any single
always-on tool at 12 KB.
