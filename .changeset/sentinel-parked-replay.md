---
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Events parked in `sentinels-parked.jsonl` (target dead, retired or unresumable) are now redelivered once when their sentinel gets a reachable target again: the sentinel runtime exposes `replayParked(sessionId?)`, each poll tick replays for sentinels whose target changed since the last attempt (covers retargets and daemon boot), and the daemon replays for a session on `session:spawned`. Delivered lines are dropped from the journal; events parked because their subject was already closed are marked `replay: false` and never replayed.
