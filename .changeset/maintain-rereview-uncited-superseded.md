---
"@agentproto/apps": patch
"@agentproto/runtime": patch
"@agentproto/worktree": patch
---

The repo-maintenance `maintain` workflow now re-reviews, once per tip, a tip whose stored verdict says superseded (triage and gate), agreed, cites no PR and sits under branch_gc's line-coverage guard, so the verified-pr pass can reclaim it once the reviewer cites the merged PR that landed the work (or the reviewer changes the verdict). Re-reviews come after every unreviewed tip under the same `maxReviews`, the report's Review section counts them, and `rereviewUncited: false` turns them off. The verdict store stamps `revision` on a record that replaces an earlier verdict for the same tip (so a re-review is never repeated), and branch_gc's plan entry verdict summary now carries `gateVerdict`, `citedPrs` (from `citedPrsOf`) and `revision`.
