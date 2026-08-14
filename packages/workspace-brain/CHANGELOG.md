# @agentproto/workspace-brain

## 0.2.1

### Patch Changes

- 545752b: Fix concurrent write race condition in brain-state.json persistence. Serialize all `record()`/`forget()` operations via an enqueue function and add per-call write counters to prevent file corruption when multiple ingests finish inside the same debounce batch.

## 0.2.0

### Minor Changes

- 4b20f1e: **Per-workspace "brain"**: a queryable index of a workspace's agent sessions for agents to recall what work the workspace has done.

  New package `@agentproto/workspace-brain` provides the pure indexing engine (BM25 via `FilesKnowledgeAdapter`, zero runtime deps). The runtime wires it up with three MCP tools (`workspace_brain_query`, `workspace_brain_status`, `workspace_brain_ingest`) and auto-ingests sessions on exit (fire-and-forget, never takes down the exit path). State is persisted atomically to `brain-state.json`; knowledge index lives in `knowledge/sources/` under a per-workspace brain dir.

  Exports from runtime: `registerBrainTools`, `createWorkspaceBrains`, `readSessionForBrain`, `createWorkspaceBrainSubscriber`.

- c3dbdc4: Multi-provider knowledge federation: introduce `FederatedKnowledgeProvider` for concurrent query/ingest across multiple knowledge backends (files, gbrain-doc, qdrant) with min-max score normalization, per-provider weighting, and graceful degradation. Add `provider-resolver.ts` for config-driven adapter instantiation with environment secret resolution and schema validation. Integrate per-workspace `knowledge.json` config loading in workspace-brains with resilient fallback to default single-provider (files) behavior.
