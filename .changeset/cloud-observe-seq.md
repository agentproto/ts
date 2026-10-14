---
"@agentproto/adapter-claude-code-cloud": patch
"@agentproto/runtime": patch
---

AIP-66 cloud observe fixes. Adapter: the events cursor pages BACKWARD in time (no cursor = newest page; `resume_cursor` = the oldest `sequence_num` on the page, passed back returns the next OLDER page), so `#observeTurn` no longer uses a forward `cursor`/seen-id set — it tracks a per-session `lastSeq`, polls the newest page each tick, walks `cursor` backward only as far as needed (capped at 20 pages/tick), projects new events in ascending `sequence_num` order, and ends a turn only on a vendor `result` whose seq is above the high-water recorded before the prompt. `session/load` seeds `lastSeq` from one newest-page GET (the forward-paging loop and `SEED_EVENT_PAGES_LIMIT` are gone), and the `CloudSessionEvent`/page types now carry `sequence_num`, `source` and `next_cursor`. Runtime: the cloud-spawn refusal message is no longer double-prefixed with `agent_start:`, and `resolveCloudSpawn` records the vendor's harness (`claude-code`) on the descriptor instead of the local relay adapter slug (`claude-code-cloud`) — the adapter stays `claude-code-cloud` (AIP-66 §2).
