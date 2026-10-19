# @agentproto/telemetry-langfuse

## 0.2.25

### Patch Changes

- @agentproto/eval@0.3.13

## 0.2.24

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/eval@0.3.12
  - @agentproto/telemetry@0.2.4

## 0.2.23

### Patch Changes

- @agentproto/eval@0.3.11

## 0.2.22

### Patch Changes

- @agentproto/eval@0.3.10

## 0.2.21

### Patch Changes

- @agentproto/eval@0.3.9

## 0.2.20

### Patch Changes

- @agentproto/eval@0.3.8

## 0.2.19

### Patch Changes

- @agentproto/eval@0.3.7

## 0.2.18

### Patch Changes

- @agentproto/eval@0.3.6

## 0.2.17

### Patch Changes

- @agentproto/eval@0.3.5

## 0.2.16

### Patch Changes

- @agentproto/eval@0.3.4

## 0.2.15

### Patch Changes

- @agentproto/eval@0.3.3

## 0.2.14

### Patch Changes

- @agentproto/eval@0.3.2

## 0.2.13

### Patch Changes

- @agentproto/eval@0.3.1

## 0.2.12

### Patch Changes

- Updated dependencies [c1a662e]
- Updated dependencies [1ad2f1c]
  - @agentproto/eval@0.3.0

## 0.2.11

### Patch Changes

- Updated dependencies [c27f0b8]
  - @agentproto/eval@0.2.11

## 0.2.10

### Patch Changes

- @agentproto/eval@0.2.10

## 0.2.9

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/eval@0.2.9
  - @agentproto/telemetry@0.2.3

## 0.2.8

### Patch Changes

- @agentproto/eval@0.2.8
- @agentproto/telemetry@0.2.2

## 0.2.7

### Patch Changes

- @agentproto/eval@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/eval@0.2.6

## 0.2.5

### Patch Changes

- @agentproto/eval@0.2.5

## 0.2.4

### Patch Changes

- @agentproto/eval@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [04aedad]
  - @agentproto/telemetry@0.2.2
  - @agentproto/eval@0.2.3

## 0.2.2

### Patch Changes

- @agentproto/eval@0.2.2

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/eval@0.2.1
  - @agentproto/telemetry@0.2.1

## 0.2.0

### Minor Changes

- aa70df9: Add Langfuse telemetry sink and eval-reporter adapter-kit family
- d9726d3: Add trace input/output, per-case span tree, and dedup-safe envelope ids to Langfuse eval sink
- a7ccd54: Add langfuseSessionTracer and extract shared createIngestionClient with atomic-drain flush

### Patch Changes

- 310de1a: Fix Langfuse ingestion: use string body id as batch-envelope id, not numeric counter
- Updated dependencies [559cd7d]
- Updated dependencies [fd03d7a]
  - @agentproto/telemetry@0.2.0
  - @agentproto/eval@0.2.0
