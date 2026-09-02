# @agentproto/corpus-cli

## 0.9.0

### Minor Changes

- 4fb28be: Introduce `@agentproto/batch` — a unified batch-inference contract over provider Batch APIs (Anthropic Message Batches, OpenRouter Batch) plus a local-queue emulation for providers without native batch support. Supports submit, status polling, result collection, and cancellation with a driver-agnostic `BatchDriver` interface; includes durable filesystem store with resumption after crashes.

  Add optional `DistillBatchPort` capability to `@agentproto/corpus` for multi-item distillation in a single call, and implement batch distiller in `@agentproto/corpus-cli` with new `anthropic-batch` and `openrouter-batch` engines for the `corpus distill` command. Both existing `DistillPort` single-item and new batch paths are fully supported and tested.

### Patch Changes

- Updated dependencies [4fb28be]
  - @agentproto/batch@0.2.0
  - @agentproto/corpus@0.7.0
  - @agentproto/corpus-presets@0.2.8

## 0.8.0

### Minor Changes

- b7d9221: Add bibliography content-SHA verification to prevent citations from silently mismatching when packs are regenerated mid-run. New exports: `bibliographySha`, `bibShaMarker`, `recordedBibSha`, `stripBibShaMarker`. New optional parameters: `bibSha` in `AssembleOptions`, `bibSha` and `checkBibSha` in `ApplyEditsOptions`/`CollectSectionsOptions`. Enhanced CLI output and error handling.

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

- Updated dependencies [2ac7025]
- Updated dependencies [dee9bd8]
- Updated dependencies [5864268]
- Updated dependencies [f0c51a7]
- Updated dependencies [b7d9221]
  - @agentproto/corpus@0.6.0
  - @agentproto/corpus-presets@0.2.7

## 0.7.3

### Patch Changes

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1
  - @agentproto/corpus@0.5.2
  - @agentproto/corpus-presets@0.2.6

## 0.7.2

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.7.1

### Patch Changes

- @agentproto/corpus@0.5.1
- @agentproto/corpus-presets@0.2.5

## 0.7.0

### Minor Changes

- bdba3a5: Add PDF fetcher: browser-free extraction with `unpdf` as tier-3 in the import-web fetcher chain. Preserves page breaks, extracts document metadata (page count, sha256, title/author/dates), and fails loudly on encryption/missing text layer. Type-safe integration with backward-compatible additions to `FetchedSource` interface.

### Patch Changes

- Updated dependencies [bdba3a5]
  - @agentproto/corpus@0.5.0
  - @agentproto/corpus-presets@0.2.4

## 0.6.0

### Minor Changes

- c4f2908: Adds `pr-review` corpus importer to transform GitHub pull requests into AIP-10 sources. Includes PrReviewImporter (pure, forge-agnostic), GhPrSourceAdapter (GitHub CLI backend), and import-prs CLI command. Sources marked as secondary authority (derived commentary). Supports --dry-run hermetic mode, per-PR error resilience, content-hash deduplication, and diff summaries.
- 8a4fed0: Add CodeImporter — new corpus importer that transforms source code trees into knowledge sources. Maintains strict notes-only seam: no symbol graphs, call graphs, or cross-source ref edges (deferred per AIP-27). Supports file or module granularity, include globs, symbol extraction, and content-hash deduplication. Includes comprehensive test coverage and safe CLI dry-run mode.

### Patch Changes

- Updated dependencies [c4f2908]
- Updated dependencies [8a4fed0]
- Updated dependencies [04aedad]
  - @agentproto/corpus@0.4.0
  - @agentproto/corpus-presets@0.2.3

## 0.5.0

### Minor Changes

- f4470d1: Add --lens/--lens-file to corpus distill, with a built-in craft lens

## 0.4.0

### Minor Changes

- a59c2d8: Add corpus verify command and lintReportConfig for report-config key hygiene

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- d89f0ad: Fix discover merge-across-runs, validator declared-schema dispatch, social lane test
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- Updated dependencies [7b53b8c]
- Updated dependencies [d89f0ad]
- Updated dependencies [a59c2d8]
- Updated dependencies [e4d9087]
- Updated dependencies [67aabc9]
  - @agentproto/cli-exec@0.1.0
  - @agentproto/corpus-presets@0.2.2
  - @agentproto/corpus@0.3.0

## 0.3.0

### Minor Changes

- 9ab5473: Add YtDlpCaptionsFetcher caption-first video ingestion to import-web

### Patch Changes

- Updated dependencies [9ab5473]
  - @agentproto/corpus@0.2.1
  - @agentproto/corpus-presets@0.2.1

## 0.2.0

### Minor Changes

- 7560f31: Add ffmpegLocation option and harden YouTube yt-dlp args in import-web
- 7d1b98c: Add corpus discover command, distill --lang flag, and hermes engine

### Patch Changes

- Updated dependencies [a5b12cf]
- Updated dependencies [7d1b98c]
- Updated dependencies [a16968b]
  - @agentproto/corpus-presets@0.2.0
  - @agentproto/corpus@0.2.0

## 0.1.1

### Patch Changes

- @agentproto/corpus@0.1.1
- @agentproto/corpus-presets@0.1.1

## 0.1.0

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
- Updated dependencies [44192c9]
  - @agentproto/corpus@0.1.0
  - @agentproto/corpus-presets@0.1.0
