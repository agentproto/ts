# @agentproto/workspace-brain

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
