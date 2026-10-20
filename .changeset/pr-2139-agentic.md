---
"@agentproto/runtime": minor
---

Sandbox sessions gain a periodic in-turn checkpoint on its own `on: ["interval"]` trigger, configurable via `sandbox.checkpoint.intervalMs` (default every 10 minutes), so a turn running longer than the box lifetime is checkpointed mid-flight instead of being lost with the box. The periodic tick also guards the box's free disk: under 10% free it emits a warning and forces a checkpoint even when the tree looks unchanged, while `turn-end` now only wires the per-turn hook (explicit `on: ["turn-end"]` configs no longer imply the periodic timer).
