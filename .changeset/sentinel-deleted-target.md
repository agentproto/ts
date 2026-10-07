---
"@agentproto/runtime": patch
---

Sentinels: a target session whose row no longer exists (deleted, not merely ended) now parks the event and orphans the sentinel instead of failing the delivery on every poll. Before, the event was never marked seen, so the sentinel never reached its terminal event and retried forever (thousands of `delivery failed: sendMessage: no session` log lines).
