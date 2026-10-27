# @agentproto/knowledge

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

- 4bab543: AIP-10 `knowledge.entry/v1` and `knowledge.source/v1` now accept a `title` of up to 1000 characters (was 200), so verbatim official legal headings no longer have to be truncated. `slug` and source `id` stay at 96. The change comes from the vendored `KNOWLEDGE.schema.json` (spec: agentproto/agentproto#79) and the regenerated zod in `@agentproto/knowledge`; `@agentproto/corpus-cli` bundles the schema at build, so `validate` / `lint` pick it up on its next publish. Relaxing a maximum is backwards compatible: every previously valid document stays valid.
- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 4bab543: AIP-10 `knowledge.entry/v1` and `knowledge.source/v1` now accept a `title` of up to 1000 characters (was 200), so verbatim official legal headings no longer have to be truncated. `slug`, source `id`, and `knowledge.workspace/v1`'s title are unchanged. The change comes from the vendored `KNOWLEDGE.schema.json` (spec: agentproto/agentproto#79) and the regenerated zod in `@agentproto/knowledge`; relaxing a maximum is backwards compatible, so every previously valid document stays valid.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.1.4

### Patch Changes

- aa5e4bd: fix(knowledge): make defineKnowledge accept valid AIP-10 entries/sources — cross-AIP `description`/id-length defaults and unquoted YAML timestamps were rejecting every valid `knowledge.entry/v1` and `knowledge.source/v1` definition. Un-skips the corpus conformance tests for the AIP-10 knowledge and AIP-12 playbook manifests.
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
