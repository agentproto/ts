# @agentproto/corpus

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
