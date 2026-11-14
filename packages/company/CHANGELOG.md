# @agentproto/company

## 0.3.0

### Minor Changes

- 6991cfa: Company, skill, role and operator each get a `createVerbs` doctype spec (`companySpec`/`companyVerbs`, `skillSpec`/`skillVerbs`, `roleSpec`/`roleVerbs`, `operatorSpec`/`operatorVerbs`) and one renderer (`renderCompanyMd`, `renderSkillMd`, `renderRoleMd`, `renderOperatorMd`) that `create` and `update` both use. The specs live in the doctype's own package rather than in `@agentproto/manifest`, which would otherwise depend on all four and close a workspace cycle through `@agentproto/agent`. Files go to `companies/<id>/COMPANY.md`, `objectives/<id>/OBJECTIVE.md`, `skills/<name>/SKILL.md`, `roles/<name>/ROLE.md` and `operators/<id>/OPERATOR.md`. Writers emit canonical fields only: the operator renderer drops the handle's `warnings` and `legacy`, `runtime.session` and empty defaults, and writes a ref-only role as a bare string; the skill renderer writes `skill/v1`, never `skills/v1`; `load` and `update` read back the file's own fields, so an unchanged update is byte-identical.

  `defineCompany` follows AIP-6 after the office and role moves. `doctype` and `id` are canonical; `kind` and `slug` are read as aliases with no removal date, and a file that carries an alias and its canonical field with different values is refused with `alias_conflict` (`CompanyAliasError`, code `alias_conflict`). The generated schema is re-synced with the vendored `COMPANY.schema.json`. A legacy `doctype: role` file under `company/v1` is still read, now with a `doctype_moved` entry in `handle.warnings`, and is not written back as a company document. `structure.positions`, `structure.roles` and `structure.reports_to` are accepted but never emitted; `structure.objectives` is kept. `CompanyDefinition` and `CompanyHandle` are rewritten around these rules (the handle gains `warnings`, the `Role` interface becomes `LegacyRoleFields`, and `parseCompanyManifest` accepts the aliases and the legacy role form).

  Fail closed: a writer never drops a legacy field it cannot express. `renderCompanyMd` refuses a handle carrying non-empty `structure.positions`, `structure.roles` or `structure.reports_to` with `CompanyLegacyFieldError` (code `legacy_field_unwritable`, naming the fields and pointing at the AIP-22 office), and `renderOperatorMd` refuses a handle carrying a legacy `governance` object (`policies`, `audit_log`) or legacy memory fields with no canonical form (`share_with`, `policy`, `external.namespace`, `operator-context`) with `OperatorLegacyFieldError`, naming the fields and the AIP-9 migration (`governance.policies` and `audit_log` to `policy` and the AIP-7 `governance` ref, `governance.autonomy` to `autonomy`). Because `create` and `update` both render, an `update` of such a file is refused before anything is written and the file is left unchanged; migrate the field, then update. `create` from canonical input is unaffected.

### Patch Changes

- Updated dependencies [e47f3cd]
  - @agentproto/manifest@0.3.0

## 0.2.0

### Minor Changes

- 52f8616: Accept the canonical AIP-70 document tags (for example `skill/v1` and `design/v1`) alongside their legacy aliases in every document parser. Writers keep emitting the legacy value until the next major.
- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.

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
