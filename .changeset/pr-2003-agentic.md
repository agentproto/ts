---
"@agentproto/runtime": minor
---

New `create_tool` / `delete_tool` daemon MCP verbs that author an AIP-14
`TOOL.md` (+ AIP-30 `DRIVER.md`) pair into the workspace bundle
(`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`), gated by the
caller's AIP-42 `actions.granted` and bounded by a minimum lifetime, a
per-agent/day delete limit and an authoring lock, with created tools
defaulting to `approval: "always"`. `isSelfSchedulingTool` now also refuses
`create_*`/`delete_*` authoring verbs as cron `tool` actions.
