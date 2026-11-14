# @agentproto/role-catalog

## 0.2.0

### Minor Changes

- a73dbd4: AIP-64 catalog members. `pack/v1` gains `roles`, `personas` and `policies`, each an array of `{ path }` to a ROLE.md, PERSONA.md or POLICY.md; the identity comes from the member's own file (`name`, or `id` for a policy, which a listed policy must declare). The manifest schema is now strict at the top level and in every nested object, as the spec says, so an unknown key is a parse error, which is also what refuses an `operators`, `companies` or `offices` member (instances are never pack content). A catalog path that is absolute, has a `..` segment, ends with the wrong filename, or is declared twice (within a member or across `apps`) is refused with no I/O. `readPackCatalog(root)` reads and validates every declared member before anything is registered and names the invalid one; it opens only declared files. `InstalledCatalog` registers a validated pack: refuses an identity another installed pack or a host `reserved` catalog already provides with a typed `PackCatalogConflictError` (code `pack_member_conflict`, naming both sources), replaces a re-applied pack's own members, refuses a gated pack with its blockers, scopes a pack to the node it is attached to, and answers `ws://roles/<name>`, `role:<name>` (and the persona and policy spellings) without any fallback. Installing binds nothing. `@agentproto/pack` now depends on `@agentproto/role`, `@agentproto/persona` and `@agentproto/policy`; a pack that carried an unknown manifest key, which parsed before, is now refused.

  `@agentproto/role` exports `InstalledRoleSource` (adapts an installed catalog to the `RoleSource` seam, so it fits `resolveOperator`'s injected `OperatorSources.roles`), `roleSourceChain` (nodes' sources first, catalog sources after, AIP-47) and `RoleUnresolvableError` (code `role_unresolvable`, with `ref`, `warnings`, `chain`), which `resolveRole` now throws instead of an untyped `Error` with the same message.

  `@agentproto/role-catalog` ships as a pack: `pack/` holds a PACK.md whose `roles` are the 21 in-code entries, rendered by `scripts/render-pack.mjs` (`pnpm render:pack`) with a drift test; `roleCatalogPackRoot()` returns its path. Because `plugin` is still required in `pack/v1`, the pack declares `plugin.inline: true` with an empty `./skills/` directory rather than relaxing the rule. The in-code catalog and `builtinRoleSource()` are unchanged.

### Patch Changes

- 0a684a5: The seed roles no longer use an em dash as punctuation. Every seed body and handle field (description, mission, capabilities, anti-patterns) that used U+2014 now reads with a colon, comma or full stop, with the same meaning, lists and headings; `pack/` is regenerated to match. A new test fails when a seed body or handle string carries U+2014 or a spaced U+2013, so hosts that merge role text into generated manifests no longer need to normalize it.
- Updated dependencies [6991cfa]
- Updated dependencies [ec3a660]
- Updated dependencies [a73dbd4]
- Updated dependencies [c73874f]
- Updated dependencies [ec3a660]
- Updated dependencies [c73874f]
  - @agentproto/role@0.3.0
  - @agentproto/policy@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [5ab8114]
  - @agentproto/policy@0.2.0
  - @agentproto/role@0.2.0

## 0.1.5

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/policy@0.1.5
  - @agentproto/role@0.1.5

## 0.1.4

### Patch Changes

- @agentproto/policy@0.1.4
- @agentproto/role@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [c27f0b8]
  - @agentproto/policy@0.1.3
  - @agentproto/role@0.1.3

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/policy@0.1.2
  - @agentproto/role@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/policy@0.1.1
  - @agentproto/role@0.1.1

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/policy@0.1.0
  - @agentproto/role@0.1.0
