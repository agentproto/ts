# @agentproto/policy

## 0.3.0

### Minor Changes

- c73874f: `@agentproto/policy` gains `evaluateGrants(inputs, request)`, a pure AIP-38 evaluator: the union of allow grants, a matching deny wins over any allow in any composed policy, `default: deny` prevails over `default: allow`, and revoked, expired (`ttl_seconds`, a missing `granted_at` counts as expired) and unsatisfied-condition grants contribute nothing. Scopes follow rules 1, 2 and 5, plus the typed forms (`label:`, `workspace:`) and `selector:<id>` that the caller declares; a scope that cannot be resolved fails closed (an allow does not match, a deny matches). A malformed grant throws `PolicyGrantError` instead of being guessed at. `evaluateToolInvoke` and `qualifyToolName` implement the `tool:invoke` scope of AIP-38 §Tool names: an exact `<server>/<name>`, `<server>/*` and `<server>/<prefix>*` through rule 2, a bare name matches nothing, a legacy bare built-in becomes `agentproto/<name>` before the requested scope is formed, and a tool that declares `implements` is decided under both `tool:invoke` and the implemented action (a deny on either refuses, an allow on either admits). The `Grant` type gains `effect?: "allow" | "deny"`.

  `decide()` in `@agentproto/runtime` accepts `PermissionContext.policy` (`{ inputs, principals?, now?, resolveSelector?, evaluateCondition? }`) and reads it per call, so a revoked grant applies on the next call. An explicit deny of `session:message` removes the grant-derived reasons of `session.message` (sibling and peer) and never a tree edge, the operator or the system (AIP-46 rule 3); malformed grants refuse those same reasons. The new `tool.invoke` action takes a `{ kind: "tool", name, implements? }` resource and is decided by `evaluateToolInvoke`; it is declared `routed: false` because no dispatch site calls it yet. No existing caller passes `policy`, so no current decision changes.

- c73874f: `@agentproto/policy` adds `evaluateGrants`/`combineDecisions` (a pure AIP-38 grant evaluator where a matching deny wins over any allow across composed policies, `default: deny` prevails, revoked/expired/condition-failing grants contribute nothing, and unresolvable scopes fail closed), `evaluateToolInvoke`/`qualifyToolName` for the `tool:invoke` action (exact `<server>/<name>`, `<server>/*`, `<server>/<prefix>*`, legacy bare built-in names qualified to `agentproto/<name>`, and `implements` actions decided together), plus the new `Grant.effect?: "allow" | "deny"` field.

  `@agentproto/runtime` accepts an optional `PermissionContext.policy` (`{ inputs, principals?, now?, resolveSelector?, evaluateCondition? }`) read per call: an explicit deny removes the grant-derived `session.message` reasons (sibling/peer, never tree edges, operator or system), malformed grants refuse those same reasons, and the new `tool.invoke` action takes a `{ kind: "tool", name, implements? }` resource. No existing caller passes `policy`, so current decisions are unchanged.

## 0.2.0

### Minor Changes

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
