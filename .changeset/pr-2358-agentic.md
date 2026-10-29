---
"@agentproto/operator": major
"@agentproto/role": minor
---

`@agentproto/operator`: rebuild on the merged AIP-9 shape. AGENT fields are carried by reference to `@agentproto/agent`; new `role` (ref string or `{ ref, bind?, with? }`), `home`, `reports_to`; `version` and `profile` are now optional. The handle changes incompatibly: `profile` is `{ role? }`, `memory` and `governance` take the AGENT forms, legacy inline governance is retained only under `legacy`, and the handle gains `warnings` and `legacy`. This removes/changes exported handle fields, so it is a major bump.

`@agentproto/role`: add AIP-47 `slots` (merged by key across `extends`) and export `roleSlotsSchema`, `classifyRef`, `validateRoleBinding` and the related `RoleSlot*`/`RoleBinding*` types.
