# @agentproto/operator

## 1.0.0

### Major Changes

- ec3a660: Rebuild `@agentproto/operator` from the merged AIP-9 schema and give `@agentproto/role` AIP-47 slots.

  `@agentproto/operator`: `OperatorDefinition` now carries the AGENT fields by reference to `@agentproto/agent` (a new dependency) instead of copying them, and adds `role` (a ref string or `{ ref, bind?, with? }`), `home`, `persona`, `identity` and `policy`. `version` and `profile` are optional. When `role` is absent, `defineOperator` reads `metadata.roleSlug`, then `profile.role` when `roleExists` says it is a role slug that resolves, and records a `role_fallback` warning; otherwise it records `role_missing` and sets no role (there is no default role). `company`, `runtime.session`, `profile.voice`, `profile.boundaries` and the inline `memory` and `governance` forms are still accepted, mapped onto their AGENT equivalents, and reported as `operator_field_deprecated`. The handle gains `warnings` and `legacy`; `defineOperator` and `operatorFromManifest` take `DefineOperatorOptions`. Handle fields that changed shape: `profile` is now `{ role? }`, and `memory` and `governance` are the AGENT forms, with the old objects kept in `legacy`.

  `@agentproto/role`: a ROLE can declare `slots` (`aip`, `collection`, `tool` `mcp|ref`, `scalar`); a policy-typed slot is refused. `validateRoleBinding` checks an operator's `bind` and `with` against them and reports `role_slot_unknown`, `role_slot_unbound` and `role_slot_type_mismatch` as errors and `role_slot_unresolvable` as a warning. Slots merge by key across `extends`.

- ec3a660: `@agentproto/operator`: rebuild on the merged AIP-9 shape. AGENT fields are carried by reference to `@agentproto/agent`; new `role` (ref string or `{ ref, bind?, with? }`), `home`, `reports_to`; `version` and `profile` are now optional. The handle changes incompatibly: `profile` is `{ role? }`, `memory` and `governance` take the AGENT forms, legacy inline governance is retained only under `legacy`, and the handle gains `warnings` and `legacy`. This removes/changes exported handle fields, so it is a major bump.

  `@agentproto/role`: add AIP-47 `slots` (merged by key across `extends`) and export `roleSlotsSchema`, `classifyRef`, `validateRoleBinding` and the related `RoleSlot*`/`RoleBinding*` types.

### Minor Changes

- b67f58e: AGENT.md `tools` accepts the AIP-42 structured item `{ kind: mcp, server, allow?, deny? }` and refuses a malformed one (missing `server`, a `/` in a name, an extra key, an unknown `kind`); the item is part of the generated agent schema and exported as `McpToolRef` / `ToolRef`. The operator `tools` item is that same schema, taken from the agent package, and still accepts the deprecated scoped form `{ id, source?, scope? }`. `projectAgentToSpawn` maps each structured item to a per-server `allowTools` / `denyTools` (`servers` on the projection) instead of dropping it with a warning; a deny wins over an allow and over any other item admitting the same tool, and a bare string joins the `agentproto` server. The spec generator gains `--inline-ref <def>` and proves disjoint closed-object `oneOf` branches, so the agent package is now covered by `check:spec-drift`. The vendored specs are re-synced, which regenerates the memory frontmatter schema line; the bridge and `refKey` in the app package take the widened `ToolRef` (a server ref keys as `mcp:<server>`).

  Narrowing: a `server` in an operator or agent `tools` item must now match `^[A-Za-z0-9_.-]+$`, so a URL such as `https://mcp.local` is refused; use a host name such as `mcp-local`. The spawn still carries a single `allowTools` list for the daemon gateway, so a filter on any other server, or a `denyTools` with no allowlist, is exposed on `servers` and reported as a harness warning ("not applied") rather than enforced. The corpus validator and the corpus-cli bundle register the AIP-42 AGENT schema they now `$ref`.

- 6991cfa: Company, skill, role and operator each get a `createVerbs` doctype spec (`companySpec`/`companyVerbs`, `skillSpec`/`skillVerbs`, `roleSpec`/`roleVerbs`, `operatorSpec`/`operatorVerbs`) and one renderer (`renderCompanyMd`, `renderSkillMd`, `renderRoleMd`, `renderOperatorMd`) that `create` and `update` both use. The specs live in the doctype's own package rather than in `@agentproto/manifest`, which would otherwise depend on all four and close a workspace cycle through `@agentproto/agent`. Files go to `companies/<id>/COMPANY.md`, `objectives/<id>/OBJECTIVE.md`, `skills/<name>/SKILL.md`, `roles/<name>/ROLE.md` and `operators/<id>/OPERATOR.md`. Writers emit canonical fields only: the operator renderer drops the handle's `warnings` and `legacy`, `runtime.session` and empty defaults, and writes a ref-only role as a bare string; the skill renderer writes `skill/v1`, never `skills/v1`; `load` and `update` read back the file's own fields, so an unchanged update is byte-identical.

  `defineCompany` follows AIP-6 after the office and role moves. `doctype` and `id` are canonical; `kind` and `slug` are read as aliases with no removal date, and a file that carries an alias and its canonical field with different values is refused with `alias_conflict` (`CompanyAliasError`, code `alias_conflict`). The generated schema is re-synced with the vendored `COMPANY.schema.json`. A legacy `doctype: role` file under `company/v1` is still read, now with a `doctype_moved` entry in `handle.warnings`, and is not written back as a company document. `structure.positions`, `structure.roles` and `structure.reports_to` are accepted but never emitted; `structure.objectives` is kept. `CompanyDefinition` and `CompanyHandle` are rewritten around these rules (the handle gains `warnings`, the `Role` interface becomes `LegacyRoleFields`, and `parseCompanyManifest` accepts the aliases and the legacy role form).

  Fail closed: a writer never drops a legacy field it cannot express. `renderCompanyMd` refuses a handle carrying non-empty `structure.positions`, `structure.roles` or `structure.reports_to` with `CompanyLegacyFieldError` (code `legacy_field_unwritable`, naming the fields and pointing at the AIP-22 office), and `renderOperatorMd` refuses a handle carrying a legacy `governance` object (`policies`, `audit_log`) or legacy memory fields with no canonical form (`share_with`, `policy`, `external.namespace`, `operator-context`) with `OperatorLegacyFieldError`, naming the fields and the AIP-9 migration (`governance.policies` and `audit_log` to `policy` and the AIP-7 `governance` ref, `governance.autonomy` to `autonomy`). Because `create` and `update` both render, an `update` of such a file is refused before anything is written and the file is left unchanged; migrate the field, then update. `create` from canonical input is unaffected.

- 812c17c: Add `resolveOperator(entry, sources)`, the pure AIP-9 §Resolution step that turns an operator and its OPERATOR.md body into an AGENT entry. Every referenced template (base agent chain, identity, persona, role chain, role skills, policy) is read through an injected `OperatorSources` loader; the function does no I/O. The body follows the merge table (agent, identity, persona, role, slot bindings, operator, host sections, boundaries), role slot bindings are checked with `validateRoleBinding`, the agent chain (5) and role chain (8) limits are enforced, and tools are the union of agent, role intent, slot-bound and operator tools filtered by the operator's AIP-38 `tool:invoke` policy: a declared tool with no grant refuses resolution, a role-intent tool with no grant is dropped with an `intent_unsatisfied` warning. The result carries a stable sha256 `digest` of its inputs for the AIP-46 `operatorDigest`, anchors memory on `operator:<slug>`, and `toolDenyGrants` turns an `{kind: mcp, deny}` tool item into AIP-38 deny grants. Adds `@agentproto/identity`, `persona`, `policy`, `role` and `skill` as dependencies.

### Patch Changes

- Updated dependencies [b67f58e]
- Updated dependencies [6991cfa]
- Updated dependencies [36442e9]
- Updated dependencies [152ec6e]
- Updated dependencies [e47f3cd]
- Updated dependencies [ec3a660]
- Updated dependencies [a73dbd4]
- Updated dependencies [c73874f]
- Updated dependencies [152ec6e]
- Updated dependencies [ec3a660]
- Updated dependencies [c73874f]
  - @agentproto/agent@0.6.0
  - @agentproto/skill@0.4.0
  - @agentproto/role@0.3.0
  - @agentproto/identity@0.3.0
  - @agentproto/manifest@0.3.0
  - @agentproto/policy@0.3.0

## 0.2.0

### Minor Changes

- 6b78431: Accept the AIP-70 registry spec names on every read path and keep emitting the legacy tags for now. `@agentproto/governance` exports `SPEC_NAME = "governance/v1"` plus `LEGACY_SPEC_NAMES` and `EMITTED_SPEC_NAME`; the signature, audit-event, and policy schemas accept `governance/v1` and `agentgovernance/v1`, while newly signed artifacts, audit rows, and policy handles still carry `agentgovernance/v1` (it flips to the new name at the next major; old verifiers in the field only know the old tag, and the tag is part of the hashed audit-row bytes, so verification always uses the tag stored in the row). `@agentproto/operator` sets `SPEC_NAME = "operator/v1"` and its OPERATOR.md frontmatter enum now accepts `operator/v1` alongside the legacy `agentoperators/v1` and `agentoperator/v1`.

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0

## 0.1.5

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.1.4

### Patch Changes

- 444efc5: Accept the canonical AIP-9 spec tag `agentoperators/v1` (plural) in OPERATOR.md frontmatter, and make it the exported `SPEC_NAME`. The old singular `agentoperator/v1` is still accepted but deprecated.
- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.1.3

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.1.1

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
