---
"@agentproto/runtime": patch
"@agentproto/sentinel": patch
---

Route a retired follower's digest to its live parent with its level kept and `routedTo` in the ledger, replay parked follow digests when the follower respawns (the retirement sweep replays before cancelling), and forward a sentinel notice for a closed session at its own level.
