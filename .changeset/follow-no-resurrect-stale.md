---
"@agentproto/runtime": patch
---

session-follow no longer resurrects a dead follower id that already has a live replacement: a digest batch queued before a follow was re-pointed to a revived follower (or whose dead descriptor's `continuedTo` already links to one) now delivers to that live session instead of calling `restartSession` again. Concurrent deliveries racing for the same dead id now share a single in-flight revival instead of each spawning their own.
