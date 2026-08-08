# @agentproto/corpus-cli

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
