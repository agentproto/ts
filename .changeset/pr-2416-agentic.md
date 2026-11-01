---
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Sentinel now redelivers events parked in `sentinels-parked.jsonl` once their sentinel gets a reachable target again: `SentinelRuntime.replayParked(sessionId?)` redelivers and drops the delivered journal lines, each poll tick replays for sentinels whose target changed since the last attempt (covering retargets and daemon boot), and the daemon replays for a session on `session:spawned`. Events parked because their subject was already closed are marked `replay: false` and never replayed.

The daemon wires the new hook so a session that registers receives notices parked while it was unreachable.
