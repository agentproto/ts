---
"@agentproto/runtime": patch
---

A retired session is never revived by an automated path. One `isRetired` predicate (archived, a deliberate `endedReason`, a `continuedTo` successor, or the new `retiredAt` stamp) now gates session-follow digests, sentinel notices, cron `prompt-session`, inbound/message routing and the restart helpers, in place and under a new id: notices for a retired follower/target go to the end of its `continuedTo` chain (and the follow/sentinel is re-pointed there) or are parked. A human prompt to a superseded row fails with `session_superseded` naming the successor (HTTP 409; `forceResume: true` in the body overrides). `kill` with a deliberate reason on an already-ended row now stamps `retiredAt` instead of no-oping, and retiring a session re-points or drops its follows and sentinels.
