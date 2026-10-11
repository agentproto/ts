---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Add on-disk session retention. A new pass deletes terminal session dirs (`~/.agentproto/sessions/<id>/`) past their age: review lanes (`origin: "review"` / `review:` label) after `daemon.reviewSessionRetentionDays` (default 7), every other session only when `daemon.sessionRetentionDays` is set (default off). Live, pinned, keepAlive sessions and ancestors of a live session are never deleted; registry-held rows are forgotten before their dir is removed. The daemon runs it 10 min after boot and every 6 h (async, batched); `session_gc` gains `retention`/`dryRun`/`reviewMaxAgeDays`/`maxAgeDays`, `POST /sessions/gc` accepts the same, and `agentproto sessions gc --retention [--dry-run]` exposes it. The boot index backfill is now async and batched (`backfillSessionIndexesAsync`) and no longer blocks daemon startup.
