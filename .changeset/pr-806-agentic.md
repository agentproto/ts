---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

**WP-E (spawn-dedupe-default)**: Add implicit idempotency key derivation to prevent accidental spawn duplicates without requiring explicit opt-in. When a spawn carries a `label` and no `idempotencyKey`, the daemon derives an implicit key from the label plus a hash of the initial prompt. Same-adapter/cwd/key spawns within ~2 minutes are deduped (shorter window than explicit keys to reduce false collisions). Label-gated derivation preserves the fan-out safety pattern where unlabelled parallel spawns must remain distinct. New config field `spawn.dedupe` ("always" default / "on-request") controls policy; per-call `dedupe: false` escape hatch.

**WP-F (worktree async provisioning)**: Enable fast-return session registration with background worktree provisioning, and share a single turbo build cache across all provisioned worktrees. `worktree: { async: true }` opts in: returns immediately with status "starting", provisioning + driver spawn continue in background. New registry methods `spawnAgentPending` / `settlePendingAgent` manage placeholder lifecycle. New `resolveWorktreesTurboCacheDir()` export provides shared cache path to setup hooks, eliminating cold builds on every worktree provision.
