---
"@agentproto/pairing-host": patch
---

A pairing loop whose park times out with no peer (an offline client, an offer nobody accepts, or a revoked pairing's tombstone whose client never returns) no longer logs `[pairing] handshake for <key> failed: handshake timed out` on every cycle. The 60 s log gate could not absorb it because one park cycle is 110 s plus 30 s of backoff, so every cycle of every loop logged a line: six tombstones produced about 37k lines in five days on one daemon. Loop timing and tombstones are unchanged; a peer that hangs up mid-handshake or sends a bad hello is still logged, gated and naming the step.
