---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-box": minor
---

Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.
