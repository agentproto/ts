---
"@agentproto/worktree": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/apps": patch
---

`branch gc --include-reviewed`: a third deterministic pass, `history-covered`, runs when verified-pr and dep-bump both refuse. It reclaims a guard-refused tip with an agreeing `obsolete` or `superseded` verdict when every changed file is proven by the dep-bump per-file rules, or is a text file that deletes no line base still has and whose every uncovered added line was added to that same path (or the path base moved it to) by a commit in base's history. Lines from other paths never count. Each path's history is read once per plan, bounded at 50 files and 32 MiB of history per tip, and past the bound it refuses. The pass is recorded as `guard: "history-covered"` + `historyCovered` (files checked, lines matched, per file the oldest and newest base commit) on the plan entry, the apply outcome and the restore log; a refusal sets `historyRefusal`. The maintain report gains an "Auto-passed by history-covered" section and a "history refused" fragment on human queue rows. `requireOperatorBelowGuard` turns it off with the other two passes.
