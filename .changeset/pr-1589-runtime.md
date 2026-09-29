---
"@agentproto/runtime": patch
---

Fix a cancelled workflow run's stage reporting `status: "failed"` in
`workflow_status` when every step in it was actually done/cancelled/skipped
— it now reports `cancelled`, matching the run's own terminal status. A
stage still reports `failed` if one of its steps genuinely failed before
the cancel landed. Applies to both the live-cancel finalization path and
the boot-time `finalizeStuckSteps` repair for a run found already
terminal-on-disk after a daemon restart.
