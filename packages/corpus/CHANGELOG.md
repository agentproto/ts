# @agentproto/corpus

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
