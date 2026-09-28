---
"@agentproto/runtime": minor
"@agentproto/apps": minor
---

`review_ledger` gains `includeRunning`, `requesterSessionId`, and `subtree` (backed by a lazy, incrementally-updated ledger index, never a full re-scan), and `ReviewRunner.list()` surfaces in-flight and settled-in-this-process runs. `session_tree` nodes that requested a review now carry a `reviews` badge (latest 3, newest first). A settled review with a known requester writes a display-only `notice` into that session's transcript (never a prompt, never a wake) via the new `SessionsRegistry.recordNotice`. New builtin panel `agentproto_reviews` (`packages/apps/src/review-panel`) — a verdict list + detail view over the review ledger, mounted alongside sessions-panel/work-board, with cancel / re-run-fresh / PR-status / export actions over the existing `review_*` tools.
