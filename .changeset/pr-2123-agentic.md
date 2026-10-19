---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

Add the `sandbox_checkpoint_gc` MCP tool (plus `sandbox_checkpoint_gc_status`) for sweeping stale `agentproto-checkpoint/*` refs, a `SandboxCheckpointGcRunner` port wired through the serve gateway, and checkpoint plan/apply steps in the repo-maintenance `maintain` workflow.
