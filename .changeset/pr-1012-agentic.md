---
"@agentproto/workspace-brain": minor
---

Introduce turn-bounded transcript chunking and harness preamble stripping. Splits long conversations into right-sized knowledge sources (default 3.5KB) to improve BM25 ranking and query snippet accuracy. Strips leading system-role messages (harness preamble) to reduce index noise. Backward-compatible: single-chunk sessions use the original file path, old brain directories require no migration. Adds `chunkTurns`, `chunkUri`, `renderChunkMarkdown` exports and new optional `chunkMaxBytes` config.
