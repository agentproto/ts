---
"@agentproto/operator": major
"@agentproto/role": minor
---

Rebuild `@agentproto/operator` from the merged AIP-9 schema and give `@agentproto/role` AIP-47 slots.

`@agentproto/operator`: `OperatorDefinition` now carries the AGENT fields by reference to `@agentproto/agent` (a new dependency) instead of copying them, and adds `role` (a ref string or `{ ref, bind?, with? }`), `home`, `persona`, `identity` and `policy`. `version` and `profile` are optional. When `role` is absent, `defineOperator` reads `metadata.roleSlug`, then `profile.role` when `roleExists` says it is a role slug that resolves, and records a `role_fallback` warning; otherwise it records `role_missing` and sets no role (there is no default role). `company`, `runtime.session`, `profile.voice`, `profile.boundaries` and the inline `memory` and `governance` forms are still accepted, mapped onto their AGENT equivalents, and reported as `operator_field_deprecated`. The handle gains `warnings` and `legacy`; `defineOperator` and `operatorFromManifest` take `DefineOperatorOptions`. Handle fields that changed shape: `profile` is now `{ role? }`, and `memory` and `governance` are the AGENT forms, with the old objects kept in `legacy`.

`@agentproto/role`: a ROLE can declare `slots` (`aip`, `collection`, `tool` `mcp|ref`, `scalar`); a policy-typed slot is refused. `validateRoleBinding` checks an operator's `bind` and `with` against them and reports `role_slot_unknown`, `role_slot_unbound` and `role_slot_type_mismatch` as errors and `role_slot_unresolvable` as a warning. Slots merge by key across `extends`.
