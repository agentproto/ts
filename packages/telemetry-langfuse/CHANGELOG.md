# @agentproto/telemetry-langfuse

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
