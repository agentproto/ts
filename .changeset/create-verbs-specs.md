---
"@agentproto/company": minor
"@agentproto/skill": minor
"@agentproto/role": minor
"@agentproto/operator": minor
---

Company, skill, role and operator each get a `createVerbs` doctype spec (`companySpec`/`companyVerbs`, `skillSpec`/`skillVerbs`, `roleSpec`/`roleVerbs`, `operatorSpec`/`operatorVerbs`) and one renderer (`renderCompanyMd`, `renderSkillMd`, `renderRoleMd`, `renderOperatorMd`) that `create` and `update` both use. The specs live in the doctype's own package rather than in `@agentproto/manifest`, which would otherwise depend on all four and close a workspace cycle through `@agentproto/agent`. Files go to `companies/<id>/COMPANY.md`, `objectives/<id>/OBJECTIVE.md`, `skills/<name>/SKILL.md`, `roles/<name>/ROLE.md` and `operators/<id>/OPERATOR.md`. Writers emit canonical fields only: the operator renderer drops the handle's `warnings` and `legacy`, `runtime.session` and empty defaults, and writes a ref-only role as a bare string; the skill renderer writes `skill/v1`, never `skills/v1`; `load` and `update` read back the file's own fields, so an unchanged update is byte-identical.

`defineCompany` follows AIP-6 after the office and role moves. `doctype` and `id` are canonical; `kind` and `slug` are read as aliases with no removal date, and a file that carries an alias and its canonical field with different values is refused with `alias_conflict` (`CompanyAliasError`, code `alias_conflict`). The generated schema is re-synced with the vendored `COMPANY.schema.json`. A legacy `doctype: role` file under `company/v1` is still read, now with a `doctype_moved` entry in `handle.warnings`, and is not written back as a company document. `structure.positions`, `structure.roles` and `structure.reports_to` are accepted but never emitted; `structure.objectives` is kept. `CompanyDefinition` and `CompanyHandle` are rewritten around these rules (the handle gains `warnings`, the `Role` interface becomes `LegacyRoleFields`, and `parseCompanyManifest` accepts the aliases and the legacy role form).

Narrowing: a company `update` rewrites the file without the deprecated `structure` fields and an operator `update` drops the inline `governance.policies` and `audit_log` that only lived in `legacy`; both are the intent of canonical-only writers, but a file that still relied on them loses them on its next write.
