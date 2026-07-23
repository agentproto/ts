---
"@agentproto/runtime": patch
---

Reject explicit worktree requests on nested spawns (depth > 0) to prevent silent data corruption. A nested spawn that passes an explicit `worktree: true` or `{slug}` request now fails loudly with a clear error message, pointing users to the `sandbox` pattern for isolated nested spawns. Implicit requests (no field or `false`) continue to silently spawn in-place as before, respecting the parent's working tree per AIP-46 §Delegation.
