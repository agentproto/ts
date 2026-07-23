---
"@agentproto/runtime": patch
---

Add warning system for nested spawns into shared dirty working trees. Nested agent spawns that run implicitly in-place (no explicit `worktree` or `sandbox` request) now emit a non-fatal advisory warning when the inherited cwd is a shared, dirty git checkout. The warning is silenceable via the new `allowSharedCwd: true` parameter on both the MCP `agent_start` tool and HTTP `/sessions/agent` endpoint.

Changes:
- New `allowSharedCwd` parameter on `SpawnAgentSessionInput` (MCP + HTTP)
- New `warnings?: string[]` field on successful spawn results
- New `isSharedDirtyCwd()` function to detect shared dirty trees (skipped for daemon-provisioned worktrees)
- `WorktreeDecision` now carries optional `warn` field for non-fatal notices
- Comprehensive tests: dirty vs clean cwd, with/without `allowSharedCwd`, root vs nested, all three isolation modes

Addresses remaining footgun after PR #622's explicit-worktree-at-depth rejection.
