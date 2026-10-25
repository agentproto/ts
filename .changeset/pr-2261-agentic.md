---
"@agentproto/runtime": minor
---

Add in-place merging for queued session-follow digests: a busy follower now receives one persisted digest carrying all coalesced events (with a 50-entry cap) instead of a new digest per flush. This also exposes the digest/merge hook on the sessions registry.
