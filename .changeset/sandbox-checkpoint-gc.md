---
"@agentproto/worktree": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Sandbox checkpoint refs no longer accumulate forever. `agentproto sandbox checkpoint-gc` (dry run by default, `--apply` to delete) lists every remote `agentproto-checkpoint/*` ref with its work branch, PR state, and verdict: safe when the PR of `wt/<slug>` is merged or closed on the forge, when the snapshot's tree is already the remote work branch's or the base branch's tree, or (for a clean snapshot) when the parent's commits are merged, squash-merged or patch-merged into the base. A snapshot whose tree differs from its parent's counts as uncommitted work and can only be proven safe by the PR or tree tiers; anything else is kept. The daemon also runs the same classification best-effort at a sandboxed session's exit and deletes the session's own ref when it is superseded, logged, never failing the session.
