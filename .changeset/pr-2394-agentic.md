---
"@agentproto/runtime": patch
---

Stop injecting an undeclared `base_url` option when resuming a session. Lazy in-place resume now builds its launch config through the same route-aware builder as fresh spawn and restart, so a derived-from-model adapter (e.g. opencode-Go) receives no `base_url` and a stale persisted one is stripped instead of crashing manifest validation with `unknown_option`.
