---
"@agentproto/runtime": patch
---

Test isolation: the runtime test package now runs with an isolated `$HOME` (vitest config/setup), so tests no longer read the real `~/.agentproto/*`. No runtime behavior change.
