---
"@agentproto/runtime": patch
---

Keep `meta.cloud` (vendor/sessionId/url) and the vendor harness label (`claude-code`) on the descriptor of a restarted AIP-66 cloud session, instead of dropping the cloud binding and falling back to the relay adapter slug (`claude-code-cloud`).
