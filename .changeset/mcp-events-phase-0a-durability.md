---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

MCP Events: Agentpush sentinel deliveries are now durable. The webhook outbox enqueue is atomic, synced and awaited before a poll ack or push 2xx; a poll batch ack covers only items that were delivered or quarantined (malformed items are quarantined, not skipped). Providers can `renew(handle, until)` and `events/subscribe` refresh renews the remote subscription, with typed handling for an already expired or deleted backing subscription. Cancellation is tracked in remote-id keyed tombstones that retry until the remote is gone, so an immediate re-subscribe cannot race a cancel. New Agentpush subscriptions reject legacy body-only sha256 signatures.
