---
"@agentproto/runtime": patch
---

Sandbox sessions gain a periodic in-turn checkpoint on its own `on: ["interval"]` trigger (configurable via `sandbox.checkpoint.intervalMs`, default every 10 minutes), so a turn running longer than the box lifetime is checkpointed mid-flight and not lost with the box. The periodic tick now also guards the box's free disk: under 10% it forces a checkpoint even when the tree looks unchanged and emits a warning.
