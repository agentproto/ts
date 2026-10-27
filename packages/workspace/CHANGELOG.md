# @agentproto/workspace

## 1.1.0

### Minor Changes

- 52f8616: Accept the canonical AIP-70 document tags (for example `skill/v1` and `design/v1`) alongside their legacy aliases in every document parser. Writers keep emitting the legacy value until the next major.
- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [f18edbc]
- Updated dependencies [5ab8114]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0
  - @agentproto/work@0.3.0

## 1.0.2

### Patch Changes

- 733a92a: Accept the optional AIP-34 `presence` block in the WORKSPACE.md frontmatter schema so spec-valid manifests are not rejected with an unrecognized-key error. Mirrors the `work` inline/ref/file union and adds a parse test.

## 1.0.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 2760272: Sync `packages/workspace/README.md` with the shipped `workspace/v2` API: replace the stale `0.1.0-alpha` / scaffold-generated note and the outdated example with the current `defineWorkspace` shape (`schema`, `id`, `version`, `name`, `type`, `owner`, `storage`) and accurate prose describing the node fields.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [12639d6]
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/work@0.2.0
  - @agentproto/define-doctype@0.1.4

## 1.0.0

### Major Changes

- 6ec4039: **BREAKING**: `workspace/v2` (AIP-34, tree composition) replaces `workspace/v1` outright — there is no parallel v1 schema, no v1↔v2 mixed tree, and no legacy compatibility path. `defineWorkspace`, `WorkspaceDefinition`/`WorkspaceHandle`, `workspaceFrontmatterSchema`, `parseWorkspaceManifest`/`workspaceFromManifest`/`writeWorkspaceManifest` now mean v2: `schema` is `"workspace/v2"`, and `type` (a node kind resolved against a tree's `TYPES.md`) is a new REQUIRED field. A caller constructing `{ schema: "workspace/v1", ... }` or omitting `type` now fails validation — see AIP-34 §Migrating from workspace/v1 for the (small) field-by-field rewrite note.

  One schema backs load, export, and verify: `writeWorkspaceManifest` (.ts → .md) and `parseWorkspaceManifest`/`workspaceFromManifest` (.md → object) both validate through `workspaceFrontmatterSchema`, so they can never drift from each other.

  New optional fields: `wall` (four visibility levels: shared/isolated/sealed/hard — default isolated), `includes`/`exports` (two-sided consent doors), `agents`/`routines` (declared manifests this node hosts), `secrets`/`uses_secrets` (never-inherited secret grants, pairs with a new additive `workspace:` access-entry kind on AIP-19 SECRETS.md), `apps`/`accepted_apps` (versioned app attachments — crossing to another node needs that node's explicit `accepted_apps` consent, same two-sided shape as includes/exports), `work` (AIP-20 WORK.md reference — a project's status/board, not a flat status file), and `policy.limits` budget aggregation (most-restrictive-wins down the tree). Companion formats: `TYPES.md` (node-type registry), `agentproto.lock` (tree-wide app/pack lockfile), `EXPORT.md` (sealed/hard digest) — each with its own schema + parse/write pair.

  Adds the first version of the cross-node verifier, `checkWorkspaceTree` (`@agentproto/workspace/checker`) and the CLI surface `agentproto workspace check <dir>`: validates node `type` against `TYPES.md` (allowed parents, wall floor, required files), two-sided `includes`/`exports` and `apps`/`accepted_apps` consent, `uses_secrets` grants against the provider's `SECRETS.md` (plus a no-literal-secret-values heuristic), `policy.limits` budget aggregation, and path confinement (tree-relative paths, no `..` traversal, no symlink escape — checked via realpath, not just the string) on every file reference the checker resolves.

  `@agentproto/app-kit`'s `defineApp`/`WorkspaceShorthand`/`emitApp` migrate along with it: a `WorkspaceShorthand` now accepts an optional `type` (defaulting to `"app"` — an app-kit workspace is a standalone root, not a node in anyone's `TYPES.md` tree), and `emitApp` writes `schema: "workspace/v2"` to the WORKSPACE.md it generates. A caller reading an emitted WORKSPACE.md and asserting `schema === "workspace/v1"` needs updating.

### Minor Changes

- 6ec4039: `workspace/v2` (AIP-34 extended) reference implementation: `defineWorkspaceV2` plus `.ts ↔ .md` manifest round-trips backed by a single zod schema, the companion formats (`TYPES.md`, `agentproto.lock`, `EXPORT.md`), the cross-node `checkWorkspaceTree` verifier, and the `agentproto workspace check <dir>` CLI surface. This increment also exports pre-default input types (`TypesManifestFrontmatterInput`, `AgentprotoLockInput`, `ExportManifestFrontmatterInput`) so the `write*` helpers accept author input that omits schema-defaulted fields.

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
