# @agentproto/workspace-brain

A **brain per workspace**: indexes the conversations of a workspace's agent
sessions into a queryable knowledge store so downstream agents can recall what
that workspace's sessions actually did.

Phase 1 makes conversations **queryable** — nothing smarter yet. Every time a
daemon session exits, its transcript is ingested into a per-workspace BM25
index; an agent can then ask `workspace_brain_query` and get ranked hits over
everything that workspace has worked on.

This package is **pure engine** — it does not read a real conversation store.
The bridge between a session's exported transcript and the corpus
`ConversationSourcePort` is injected via `BrainConfig.readSession`, so the same
engine runs over any source of transcripts (the daemon wires it to
`CONVERSATION_STORES` + the `events.jsonl` fallback in
`packages/runtime/src/workspace-brains.ts`).

## Layout

```
~/.agentproto/workspaces/<slug>/brain/
├── brain-state.json          # which sessions were ingested or skipped (atomic, never corrupts)
└── knowledge/
    └── sources/              # one markdown chunk per ingested chunk
        ├── sess-abc123.md    # chunk 0 of a session (or a pre-chunking session)
        ├── sess-abc123#1.md  # chunk 1 of a long session
        └── sess-def456.md
```

The `knowledge/` directory is exactly what `@agentproto/adapter-knowledge-files`'
`FilesKnowledgeAdapter` indexes with BM25 (zero deps, no embeddings, no API key).

Long transcripts are split into **turn-bounded chunks** (default ~3.5 KB) so
each chunk ranks independently and query snippets land near the matched
passage. Chunk 0 keeps the bare session id, so a single-chunk session (the
common case) writes to the same path the pre-chunking pipeline used. A session
with no readable transcript or an empty transcript is recorded as a **skip** in
`brain-state.json` so `pendingSessions` converges instead of retrying forever —
it's not a tombstone; an explicit re-ingest or later successful ingest clears
it.

## What's here

- `types.ts` — `BrainStateRecord`, `BrainStateSkip`, `BrainStats`, `BrainConfig`.
- `brain-state.ts` — atomic read/write of `brain-state.json` (tmp+rename, like
  the workspace-bucket snapshot writer; a corrupt file reads back as empty).
  Also records skipped sessions.
- `session-source-port.ts` — `BrainSessionSourcePort`, a corpus
  `ConversationSourcePort` that turns an injected exported transcript into
  `ConversationTurn`s.
- `chunking.ts` — turn-bounded transcript chunking (`chunkTurns`, `chunkUri`,
  `renderChunkMarkdown`) with a default `DEFAULT_CHUNK_MAX_BYTES` ceiling
  (~3.5 KB).
- `ingest-pipeline.ts` — the import loop: enumerate sessions → flatten turns →
  chunk → markdown per chunk → `provider.ingest()` (which also invalidates the
  BM25 cache).
- `brain-manager.ts` — the orchestrator: lazily creates the `FilesKnowledgeAdapter`
  rooted at `brain/knowledge/`, exposes `ingestSession` / `ingestPending` /
  `status` / `getProvider`.

## Usage

```ts
import { createBrainManager } from "@agentproto/workspace-brain"

const manager = createBrainManager({
  workspace: "agentik-studio",
  brainDir: "/Users/you/.agentproto/workspaces/agentik-studio/brain",
  readSession: async (sessionId) => await loadSessionTranscript(sessionId),
  listSessionRefs: async () => await listSessionIds(),
})

await manager.ingestSession("sess-abc123")
const result = await manager.getProvider().query({ query: "what did we do about auth?", topK: 5 })
```
