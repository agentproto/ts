# @agentproto/workspace-brain

## 0.4.2

### Patch Changes

- Updated dependencies [4fb28be]
  - @agentproto/corpus@0.7.0
  - @agentproto/adapter-knowledge-files@0.2.5

## 0.4.1

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
  - @agentproto/adapter-knowledge-gbrain-doc@0.2.2
  - @agentproto/adapter-knowledge-qdrant@0.2.2
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/adapter-knowledge-files@0.2.4

## 0.4.0

### Minor Changes

- 88134e9: Signal sources ingested with a stale pipeline version. Introduces `PIPELINE_VERSION` constant and `isStaleRecord()` helper to detect when ingested data was produced by an older version of the chunking/processing logic. When `ingestPending()` completes, it now reports `staleSources` (count of records behind the current pipeline version) and `currentPipelineVersion`. The new optional `reindexStale` parameter to `ingestPending()` forces re-ingestion of stale sources. Updated `workspace_brain_status` and `workspace_brain_ingest` tool descriptions to explain the new `staleSources` signal.

### Patch Changes

- 4ac9d37: Documentation sync: Update MCP tool naming conventions (resource_action pattern), version bumps (0.12.0 → 0.14.0), and add docs for new features (daemon status build identity, pack build subcommand, workspace-brain transcript chunking, ops-panel app).
  - @agentproto/corpus@0.5.2
  - @agentproto/adapter-knowledge-files@0.2.3

## 0.3.0

### Minor Changes

- d63cd31: Add skip-tracking to workspace brain to prevent re-ingestion of permanently-unavailable sessions. Skips are recorded in brain-state.json and excluded from pendingSessions backlog, but are not tombstones — explicit re-ingests and later successful ingests clear them automatically.
- 632b011: Introduce turn-bounded transcript chunking, harness preamble stripping, and skip tracking. Splits long conversations into right-sized knowledge sources (default 3.5KB) to improve BM25 ranking and query snippet accuracy. Strips leading system-role messages to reduce index noise. Records permanently-unavailable sessions (no-transcript, empty-transcript) so `pendingSessions` converges and never retries sessions with no recoverable transcript. Skip entries are not tombstones—explicit re-ingest or later successful ingest clears them. Backward-compatible: single-chunk sessions use the original file path, old brain directories require no migration, old state files without skips field parse as empty skips. Adds `chunkTurns`, `chunkUri`, `renderChunkMarkdown` exports, `BrainStateSkip` type export, new optional `chunkMaxBytes` config, and `skippedSessions` field to `BrainStats`.

## 0.2.1

### Patch Changes

- 545752b: Fix concurrent write race condition in brain-state.json persistence. Serialize all `record()`/`forget()` operations via an enqueue function and add per-call write counters to prevent file corruption when multiple ingests finish inside the same debounce batch.

## 0.2.0

### Minor Changes

- 4b20f1e: **Per-workspace "brain"**: a queryable index of a workspace's agent sessions for agents to recall what work the workspace has done.

  New package `@agentproto/workspace-brain` provides the pure indexing engine (BM25 via `FilesKnowledgeAdapter`, zero runtime deps). The runtime wires it up with three MCP tools (`workspace_brain_query`, `workspace_brain_status`, `workspace_brain_ingest`) and auto-ingests sessions on exit (fire-and-forget, never takes down the exit path). State is persisted atomically to `brain-state.json`; knowledge index lives in `knowledge/sources/` under a per-workspace brain dir.

  Exports from runtime: `registerBrainTools`, `createWorkspaceBrains`, `readSessionForBrain`, `createWorkspaceBrainSubscriber`.

- c3dbdc4: Multi-provider knowledge federation: introduce `FederatedKnowledgeProvider` for concurrent query/ingest across multiple knowledge backends (files, gbrain-doc, qdrant) with min-max score normalization, per-provider weighting, and graceful degradation. Add `provider-resolver.ts` for config-driven adapter instantiation with environment secret resolution and schema validation. Integrate per-workspace `knowledge.json` config loading in workspace-brains with resilient fallback to default single-provider (files) behavior.
