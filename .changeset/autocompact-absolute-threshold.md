---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Autocompact: an ABSOLUTE token threshold that compacts an idle session's context, plus the resume prompt that follows it.

The context-continuity policy was percent-only (`warnAtPct` / `compactAtPct` / `continueFreshAtPct` / `hardStopAtPct`), which cannot fire on a large window: 558k tokens in a 1M-token context is "55% full", the warn band, so nothing ever compacted while every call re-read the whole context. The new `contextContinuity.autoCompactAtTokens` is a token COUNT, not a percentage, so it behaves the same on a 200k and on a 1M window.

- Threshold: default 150000 tokens, clamped into `[1000, 200000]` (a value above the maximum is clamped down, never rejected), `0` disables. Configurable per session (`agent_start` → `contextContinuity.autoCompactAtTokens`), per agent/adapter default (`defaults.contextContinuity` / `defaults.adapters.<slug>.contextContinuity` in the daemon config) and from the CLI (`agentproto sessions restart --auto-compact-at-tokens <n>`, which also carries the policy across the restart).
- Behaviour: fires at a turn boundary only on an IDLE session (turn ended, no background task outstanding), never twice while a compaction is in flight, and compacts through the same `/compact` path as the `session_compact` verb (a checkpoint is written first).
- Resume: after the compaction a short resume prompt is injected ONLY when a mission is in progress (a non-empty `goal` section in the continuity checkpoint written just before the compaction). The prompt cites the path of the full transcript, so the session can look up anything the summary dropped.
- `session_context_status` now reports `autoCompactAtTokens` and `autoCompactAboveThreshold`.

Conversation resumption: two new MCP tools, `transcript_search` and `transcript_read`, that look back along a session's LINEAGE.

After a restart (or a continue-fresh handoff) the history a session is carrying on lives in its predecessors' transcripts, not in its own: the new row starts with an empty `events.jsonl`. The two tools walk that lineage (the restart link `resumedFrom`, the continue-fresh link `continuedFrom` and the handover link `succeeds`) and return DATED EXCERPTS, never a whole transcript: a per-excerpt cap, a total character cap and a result cap, with the transcript streamed (never slurped).

The shared logic lives in the runtime package (`@agentproto/runtime` → `transcript-search.ts`), so consumers import it from there instead of from the vscode package: the vscode extension's `searchTranscripts` command is a UI over the daemon's brain query (`GET /brain/query`), which needs an ingested corpus, while these tools read the transcripts directly and need none.
