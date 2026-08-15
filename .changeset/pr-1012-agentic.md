---
"@agentproto/workspace-brain": minor
---

Introduce turn-bounded transcript chunking, harness preamble stripping, and skip tracking. Splits long conversations into right-sized knowledge sources (default 3.5KB) to improve BM25 ranking and query snippet accuracy. Strips leading system-role messages to reduce index noise. Records permanently-unavailable sessions (no-transcript, empty-transcript) so `pendingSessions` converges and never retries sessions with no recoverable transcript. Skip entries are not tombstones—explicit re-ingest or later successful ingest clears them. Backward-compatible: single-chunk sessions use the original file path, old brain directories require no migration, old state files without skips field parse as empty skips. Adds `chunkTurns`, `chunkUri`, `renderChunkMarkdown` exports, `BrainStateSkip` type export, new optional `chunkMaxBytes` config, and `skippedSessions` field to `BrainStats`.
