# @agentproto/routine

## 0.4.1

### Patch Changes

- Updated dependencies [e47f3cd]
  - @agentproto/manifest@0.3.0

## 0.4.0

### Minor Changes

- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- 9ae92a7: Wire AIP-41 `schedule.kind: "event"` routines into the daemon: `createReactionWiring`/`sessionFactsOf` turn resolved event bindings into reaction bindings, and `ReactionRunner.replaceBindings` hot-swaps the live binding set on every reconcile/boot. The agent-arm guard now fails closed when an event's session facts cannot be read.

  Document how event routines are resolved in the routine README.

- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [5ab8114]
- Updated dependencies [f18edbc]
- Updated dependencies [5ab8114]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0
  - @agentproto/manifest@0.2.5

## 0.3.3

### Patch Changes

- 1b79127: Bind routine workflow targets to their own workspace root
- 1b79127: Bind AIP-41 routine `target.workflow` targets to the routine's own workspace: relative `file` paths resolve against the workspace root, the dispatched `workflow_run_file` call runs with `cwd` set to it, and `input.repoRoot` defaults to it (an explicit `repoRoot` still wins). Adds an exported `RoutineTargetOptions` type and an optional third parameter to `routineTargetToToolCall`; documents the behavior in the routine README and the repo-maintenance ROUTINE manifests.

## 0.3.2

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4
  - @agentproto/manifest@0.2.4

## 0.3.1

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3
  - @agentproto/manifest@0.2.3

## 0.3.0

### Minor Changes

- 515352b: Cron kind:"agent" and routine target.agent now accept agent_start's full input shape

## 0.2.3

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.2.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2
  - @agentproto/manifest@0.2.2

## 0.2.1

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

## 0.2.0

### Minor Changes

- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.

### Patch Changes

- 5becedc: Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
- 1cbb910: Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

  The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.

## 0.1.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/manifest@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/manifest@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/manifest@0.1.0
