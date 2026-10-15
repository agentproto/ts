---
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": patch
---

Enforce the canonical posture on opencode sessions instead of only announcing
it. opencode advertises no native `bypass`/`accept-edits`/`read-only` mode, so
those postures reached an opencode session as an advisory system-prompt
preamble only, and `posture: "bypass"` still showed opencode's own permission
prompts. The driver now layers a `permission` block into the session's own
`OPENCODE_CONFIG_CONTENT` at spawn/restart (the user's opencode config files are
never touched): `bypass` allows every permission, `accept-edits` sets
`edit: "allow"`, `read-only` sets `edit: "deny"` and `bash: "deny"`. `plan` keeps
opencode's native `plan` agent, and the preamble fallback for harnesses with no
mapping is unchanged. An inline config that is not a JSON object now refuses the
spawn rather than silently dropping the boundary.
