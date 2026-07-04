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

## `worktreeAgentWorkflow`

This package also exports the `RuntimeWorkflow` def that chains the three
tools above around an `AgentStep`: provision → agent (`cwd` bound to the
provisioned worktree) → gate → on pass, human approval → cleanup. On gate
failure the worktree is left in place for inspection.

## `worktree-agent` CLI

A `bin` runs that workflow end-to-end against a real agentproto daemon (the
coding agent is a real, supervisable `agent_start` session — not a bare
subprocess):

```
worktree-agent run \
  --repo <abs repo root> --slug <id> --task "<prompt>" --gate "<check cmd>" \
  [--base origin/main] [--adapter claude-code] [--deps-cmd "pnpm install --prefer-offline"] \
  [--copy-glob <glob>]... [--no-cleanup] [--yes]
```

It connects to the daemon's MCP endpoint (`http://127.0.0.1:18790/mcp`, or
`AGENTPROTO_MCP_URL`) and fails loudly if it can't reach one. The approval
step reads a y/n answer from `/dev/tty`; `--yes` auto-approves, and a
non-interactive run (no TTY) defaults to NOT approving — the worktree is left
in place rather than silently cleaned up.
