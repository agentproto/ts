---
"@agentproto/cli": patch
---

Declare `@agentproto/sandbox-computer` as a dependency and keep it external in the bundle, so the `computer` sandbox provider resolves from a daemon started with `agentproto serve` instead of listing as "not installed".
