# @agentproto/pack

## 0.3.0

### Minor Changes

- c6e0daa: Export each package's AIP-70 registry spec id as `SPEC_NAME`, and make `check-names` flag registered packages that export none.
- c6e0daa: Export each package's AIP-70 registry spec id as `SPEC_NAME`, and make `check-names` flag registered packages that export no `SPEC_NAME`/`SPEC_ID` constant (mirrors `.changeset/e33-spec-name-constants.md`).

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0

## 0.2.6

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.2.5

### Patch Changes

- 88c6d45: Renumber PACK to AIP-64 and fix definePack error prefix

## 0.2.4

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.2.3

### Patch Changes

- 835738c: Corrects the incorrect AIP-52 attribution in `@agentproto/pack`: PACK.md has no assigned AIP (AIP-52 is ADAPTER, implemented by `@agentproto/mastra`). Updates package metadata, docs, and comments accordingly; runtime error strings are unchanged.

## 0.2.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.2.0

### Minor Changes

- 9f584c4: Rename "plugins" to "adapters" in the CLI to free up "plugin" for Agent Plugins v1.0.0 standard. This is a breaking change: `agentproto plugins` → `agentproto adapters`, config key `plugins[]` → `adapters[]`, manifest schema `agentproto/plugin/v1` → `agentproto/adapter/v1`.

  Introduce `@agentproto/pack` (AIP-52 PACK.md reference implementation) and `@agentproto/plugin` (Agent Plugins v1.0.0 reference implementation) packages.
