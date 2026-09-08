---
"@agentproto/runtime": patch
---

Aligns runtime with the new sandbox pause-by-default teardown: updated the sandbox-reconnect regression test to assert that a plain ephemeral spawn (no `lifecycle`, no `reuse`) pauses on close, and refreshed the `lifecyclePolicy` docblock in `sandbox-agent-session-proxy.ts`. No exported surface change.
