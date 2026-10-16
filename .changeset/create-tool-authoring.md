---
"@agentproto/runtime": minor
---

New `create_tool` / `delete_tool` daemon verbs author an AIP-14/AIP-30
TOOL.md + DRIVER.md pair into the workspace bundle
(`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`). Gated by the
caller's AIP-42 `actions.granted` (default-denied — an agent must grant
`create_tool` in its own manifest), bounded by a minimum lifetime, a
per-agent/day delete limit and an authoring lock, with created tools
defaulting to `approval: "always"`. `isSelfSchedulingTool` now also refuses
`create_*`/`delete_*` authoring verbs (including `create_tool`) as cron
`tool` actions.
