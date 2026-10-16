---
"@agentproto/runtime": minor
"@agentproto/agent": minor
---

New `create_tool` / `delete_tool` daemon verbs author an AIP-14/AIP-30
TOOL.md + DRIVER.md pair into the workspace bundle
(`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`). Gated by the
caller's AIP-42 `actions.granted` (default-denied — an agent must grant
`create_tool` in its own manifest). The grant subject is the daemon-resolved
caller session identity — never a caller-supplied tool argument — and an
unresolvable caller fails closed. Bounded by a minimum lifetime, an authoring
marker that protects operator/`emitApp`-authored tools from `force`, a
per-agent/day delete limit and a reclaimable authoring lock; created tools
default to `approval: "always"`. `@agentproto/agent` now exports its
`AGENT_ID_PATTERN` so callers validate AIP-42 ids before resolving them to
paths. `isSelfSchedulingTool` now also refuses `create_*`/`delete_*` authoring
verbs (including `create_tool`) as cron `tool` actions.
