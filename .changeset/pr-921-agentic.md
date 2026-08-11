---
"@agentproto/workspace-brain": minor
"@agentproto/runtime": minor
---

**Per-workspace "brain"**: a queryable index of a workspace's agent sessions for agents to recall what work the workspace has done.

New package `@agentproto/workspace-brain` provides the pure indexing engine (BM25 via `FilesKnowledgeAdapter`, zero runtime deps). The runtime wires it up with three MCP tools (`workspace_brain_query`, `workspace_brain_status`, `workspace_brain_ingest`) and auto-ingests sessions on exit (fire-and-forget, never takes down the exit path). State is persisted atomically to `brain-state.json`; knowledge index lives in `knowledge/sources/` under a per-workspace brain dir.

Exports from runtime: `registerBrainTools`, `createWorkspaceBrains`, `readSessionForBrain`, `createWorkspaceBrainSubscriber`.
