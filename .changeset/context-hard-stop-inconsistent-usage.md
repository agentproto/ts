---
"@agentproto/runtime": patch
---

Context-continuity no longer ends a session on an unreliable reading. A usage frame whose `used` exceeds its own `size` (an adapter's guessed 200k window on a 1M-window model) no longer overrides a larger known or catalog window, and neither the turn-end hard-stop nor the pre-send refusal acts while the latest frame is self-contradictory. A genuine hard-stop now sets `endedReason: "context-hard-stop"`.
