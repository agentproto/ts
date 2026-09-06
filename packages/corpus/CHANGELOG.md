# @agentproto/corpus

## 0.7.1

### Patch Changes

- f9e21fd: AIP-15 P2: `harness.knowledge[]` on `kind: "agent"` steps. A selector pins an AIP-10 corpus workspace (relative paths resolve against the WORKFLOW.md dir at load time; a missing workspace fails the load), `anyOf`/`allOf` tag filters, refined `kinds`, a `maxEntries` cap (default 50, slug-ascending deterministic order) and v1 `mode: "files"`. Before an agent step's spawn, the runtime resolves each selector with the corpus `resolveKnowledge`, writes the matched raw entries to `<stepCwd>/.knowledge/<workspaceBasename>/<slug>.md` plus a deterministic `INDEX.md`, prepends a prompt note pointing at the index, and records `knowledgeApplied: { workspace, matched, written }[]` on the step's run record. An empty match is not an error — it is recorded and emitted as a `session:harness-warning` (`knowledge-empty`). `resolveKnowledge`'s signature is unchanged; the new `filterEntriesByAllOf` helper beside it provides the AND-semantics post-filter.
- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [ece3cae]
  - @agentproto/workflow@0.4.0
  - @agentproto/collection@0.1.1
  - @agentproto/knowledge@0.1.1
  - @agentproto/operator@0.1.1
  - @agentproto/playbook@0.1.1
  - @agentproto/registry@0.1.0
  - @agentproto/routine@0.2.1

## 0.7.0

### Minor Changes

- 4fb28be: Introduce `@agentproto/batch` — a unified batch-inference contract over provider Batch APIs (Anthropic Message Batches, OpenRouter Batch) plus a local-queue emulation for providers without native batch support. Supports submit, status polling, result collection, and cancellation with a driver-agnostic `BatchDriver` interface; includes durable filesystem store with resumption after crashes.

  Add optional `DistillBatchPort` capability to `@agentproto/corpus` for multi-item distillation in a single call, and implement batch distiller in `@agentproto/corpus-cli` with new `anthropic-batch` and `openrouter-batch` engines for the `corpus distill` command. Both existing `DistillPort` single-item and new batch paths are fully supported and tested.

## 0.6.0

### Minor Changes

- 2ac7025: Add optional book publishing features to report engine: `injectAnchors` parameter for HTML anchor injection, `outline` parameter for cross-chapter references in prompts, new schema fields for artifacts (`artifact`), cover body text (`body`), and print/ebook configuration (`bundleRepo`, `pageSize`, `pageBleed`, `epub`). All changes are backward compatible.
- 5864268: Improve applyEdits edit safety: check each edit individually and surface pre-existing defects.

  Previously, if any edit failed post-check (introducing an out-of-range cite or breaking the heading), the entire batch would be reverted silently. Now:
  - Each edit is post-checked individually: a bad edit reverts itself, not the whole chapter
  - Pre-existing defects (e.g., a writer-introduced stray `[0]` citation) no longer block valid edits from landing
  - Contextual checking: replacements are checked both in isolation and in context (composing with surrounding text)
  - New field in stats: `preExistingOutOfRange` surfaces defects that pre-existed the edits

  This enables better resilience: valid edits always land even when the chapter carries pre-existing citation defects, and the draft defects are surfaced in the report rather than silently reverted.

- b7d9221: Add bibliography content-SHA verification to prevent citations from silently mismatching when packs are regenerated mid-run. New exports: `bibliographySha`, `bibShaMarker`, `recordedBibSha`, `stripBibShaMarker`. New optional parameters: `bibSha` in `AssembleOptions`, `bibSha` and `checkBibSha` in `ApplyEditsOptions`/`CollectSectionsOptions`. Enhanced CLI output and error handling.

### Patch Changes

- dee9bd8: Fix citation parsing to safely ignore array indexing in code blocks and inline code; add support for anchor-prefixed chapters from `assembleChapters({ injectAnchors: true })`; improve post-check failure tracking with new `postCheckFailed` stats field.
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

- Updated dependencies [f0c51a7]
  - @agentproto/collection@0.1.1
  - @agentproto/knowledge@0.1.1
  - @agentproto/operator@0.1.1
  - @agentproto/playbook@0.1.1
  - @agentproto/routine@0.2.1
  - @agentproto/workflow@0.3.1

## 0.5.2

### Patch Changes

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow@0.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0

## 0.5.0

### Minor Changes

- bdba3a5: Add PDF fetcher: browser-free extraction with `unpdf` as tier-3 in the import-web fetcher chain. Preserves page breaks, extracts document metadata (page count, sha256, title/author/dates), and fails loudly on encryption/missing text layer. Type-safe integration with backward-compatible additions to `FetchedSource` interface.

## 0.4.0

### Minor Changes

- c4f2908: Adds `pr-review` corpus importer to transform GitHub pull requests into AIP-10 sources. Includes PrReviewImporter (pure, forge-agnostic), GhPrSourceAdapter (GitHub CLI backend), and import-prs CLI command. Sources marked as secondary authority (derived commentary). Supports --dry-run hermetic mode, per-PR error resilience, content-hash deduplication, and diff summaries.
- 8a4fed0: Add CodeImporter — new corpus importer that transforms source code trees into knowledge sources. Maintains strict notes-only seam: no symbol graphs, call graphs, or cross-source ref edges (deferred per AIP-27). Supports file or module granularity, include globs, symbol extraction, and content-hash deduplication. Includes comprehensive test coverage and safe CLI dry-run mode.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [4d200a9]
- Updated dependencies [5becedc]
- Updated dependencies [23fa73e]
- Updated dependencies [1cbb910]
  - @agentproto/routine@0.2.0
  - @agentproto/workflow@0.1.1

## 0.3.0

### Minor Changes

- a59c2d8: Add corpus verify command and lintReportConfig for report-config key hygiene
- e4d9087: Wire chapter.cover and rulesText through to write/review model prompts
- 67aabc9: Add readDistillSources helper — shared frontmatter-id source scan for distill

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- d89f0ad: Fix discover merge-across-runs, validator declared-schema dispatch, social lane test
- Updated dependencies [7b53b8c]
  - @agentproto/collection@0.1.0
  - @agentproto/knowledge@0.1.0
  - @agentproto/operator@0.1.0
  - @agentproto/playbook@0.1.0
  - @agentproto/registry@0.1.0
  - @agentproto/routine@0.1.2
  - @agentproto/workflow@0.1.0

## 0.2.1

### Patch Changes

- 9ab5473: Add YtDlpCaptionsFetcher caption-first video ingestion to import-web

## 0.2.0

### Minor Changes

- 7d1b98c: Add corpus discover command, distill --lang flag, and hermes engine
- a16968b: Add CorpusHost, assembleDimensions, overlay processor factory, and query knowledge tool

### Patch Changes

- a5b12cf: Add domain-agnostic research preset to corpus-presets

## 0.1.1

### Patch Changes

- @agentproto/routine@0.1.1

## 0.1.0

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
  - @agentproto/routine@0.1.0
