---
"@agentproto/runtime": patch
---

Record a host-side `silent` turn-end when an agent acks its wake as an explicit `inbox_ack({ noop: true })` no-op, and let session-follow skip or deliver it like an empty turn.
