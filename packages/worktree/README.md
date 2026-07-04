# @agentproto/worktree

AIP-14 TOOL contracts + a builtin AIP-30 PROVIDER for provisioning, gating,
and cleaning up a git worktree — the primitive a `@agentproto/workflow-runtime`
`AgentStep` binds its `cwd` to for a "launch an agent in a worktree" workflow.

## Tools

- **`worktree.provision`** — `git worktree add` a new worktree for `repoRoot`
  at `<repoRoot>/../_worktrees/<slug>` on branch `wt/<slug>`, cut from `base`
  (default `origin/main`). Optionally runs `depsCmd` inside it, and copies
  `copyGlobs` (e.g. gitignored local secrets) from `repoRoot` into it at the
  same relative path. Returns `{ cwd, branch }`.
- **`worktree.run-gate`** — run a caller-provided command inside a directory
  and report pass/fail from its exit code.
- **`worktree.cleanup`** — `git worktree remove` (+ optional `git branch -D`).

All three are agnostic: no hardcoded package manager, env layout, or gate
command — everything is an input.

See `examples/worktree-agent` for the full provision → agent → gate →
approval → cleanup workflow.
