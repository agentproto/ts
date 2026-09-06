---
"@agentproto/app-kit": minor
"@agentproto/workflow": minor
---

**AIP-53 rule 7**: Enforce absolute filesystem paths for `artifact.path` and `skill.path` in `defineApp`. Relative paths have no defined base at emit time and are now rejected with descriptive error messages.

**AIP-15 × AIP-41**: Add optional `routines` field to WorkflowDefinition for declaring ROUTINE.md-driven schedules (preferred form) alongside legacy `triggers: [{ kind: schedule }]` support. Introduces new `RoutineRef` type supporting `ref`, `file`, and `inline` variants.
