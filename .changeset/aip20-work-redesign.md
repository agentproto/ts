---
"@agentproto/work": minor
---

AIP-20 redesign port — view mode is gone. Regenerates `schema.ts` + `types.ts` from the redesigned `WORK.schema.json` draft (re-vendored in this PR): `extends`, `appliesTo`, `version`, `agency`, `playbook`, `scope`, `display`, `defaults.approvalClass` and the old `statusRollup.policy` / lint kinds are no longer part of the WORK manifest, replaced by `containment` (child→allowed parents, maxDepth), `coordination` (lease TTL / stale-lock age), `statusRollup.rules[].category`, and `views` (saved queries). The `appliesTo` ⇒ `extends` cross-field rule in `defineWork` was deleted with the view mode it guarded; workspace-tree fixtures now write the view-mode-free WORK.md shape.
