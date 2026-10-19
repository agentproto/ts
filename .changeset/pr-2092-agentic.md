---
"@agentproto/worktree": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Add `agentproto sandbox checkpoint-gc` plus the underlying `@agentproto/worktree` engine (`planSandboxCheckpointGc` / `applySandboxCheckpointGc` / `reclaimOneSandboxCheckpoint`) that reaps stale remote `agentproto-checkpoint/*` refs whose rescued work is provably elsewhere (PR merged/closed, snapshot tree already in the work or base branch, or a clean snapshot whose parent landed via merge/squash/patch). Dry run is the default; `--apply` re-plans fresh before each delete. A new best-effort `SandboxCheckpointReclaimer` port is wired into the daemon so a sandboxed session's own ref is deleted at exit when superseded, never failing the session.
