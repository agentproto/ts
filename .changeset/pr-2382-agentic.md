---
"@agentproto/identity": minor
---

Follow AIP-23 `work` narrowing (agentproto/agentproto#146): the frontmatter schema regenerated from the vendored `IDENTITY.schema.json` now accepts `work` only as the AIP-54 ref of the node's WORK.md, `ws://workspaces/@<owner>/<slug>/WORK.md`, matching the AIP-22 OFFICE field. The canonical spec pin must move to `b318fc25ec497235369498f43ac5ac830914e135` so the vendored schema stays in sync.
