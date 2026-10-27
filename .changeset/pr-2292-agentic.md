---
"@agentproto/runtime": minor
---

Add `sandbox_list` / `collectSandboxInventory` for a unified, per-provider sandbox inventory. `sandbox_gc` defaults to `computer` only, and reports an explicit `e2b` sweep as `notScanned` (the shared account writes no daemon marker, so its boxes cannot be attributed to this daemon).
