# @agentproto/manifest

## 0.3.0

### Minor Changes

- e47f3cd: AIP-42 `AgentEntry`, one AGENT.md renderer, and a configurable instructions composer.

  - `@agentproto/agent` exports `AgentEntry { agent, body? }` and `renderAgentMd(entry)`, the single AGENT.md renderer. `agentVerbs` (create and update) and the app emitter both go through it, so the same agent renders to the same bytes on either path. The body is trimmed on render, so an update no longer grows blank lines.
  - `defineAgent` refuses a missing or blank `model` with `model is required` (the generated schema types `model` as `any`, so a blank string used to pass).
  - `composeInstructions(handle, body, opts?)` takes `boundariesHeader` and `sectionOrder`. The default boundaries header is now `Hard rules (these MUST be followed):`, without the em dash.
  - `@agentproto/manifest`: `DoctypeSpec` gains an optional `render(handle, body)` hook that `create` and `update` use in place of the generic frontmatter renderer.
  - `@agentproto/skill` exports `SkillEntry { skill, body }`.
  - `@agentproto/app`: `renderAgentManifest` and `emitApp` delegate to `renderAgentMd`; ref comments cite AIP-54.

## 0.2.5

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0

## 0.2.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.2.3

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.2.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1

## 0.2.0

### Minor Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool

## 0.1.0

### Minor Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
