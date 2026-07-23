---
"@agentproto/cli": patch
---

Fix daemon discovery priority and honor explicit ~/.agentproto/runtime.json pins.

The resolver now checks ~/.agentproto/runtime.json early (if present and live), allowing users to explicitly pin a daemon endpoint. When reading the registry, it prefers entries matching config.json's declared daemon port over transient entries, fixing the issue where short-lived ephemeral daemons would hijack every CLI call away from the long-running declared serve daemon.
