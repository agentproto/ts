# @agentproto/worktree

AIP-14 TOOL contracts + a builtin AIP-30 PROVIDER for provisioning, gating,
and cleaning up a git worktree — the primitive a `@agentproto/workflow-runtime`
`AgentStep` binds its `cwd` to for a "launch an agent in a worktree" workflow.

## Tools

- **`worktree.provision`** — `git worktree add` a new worktree for `repoRoot`
  at `<repoRoot>/../_worktrees/<slug>` on branch `wt/<slug>`, cut from `base`
  (default `origin/main`). Optionally runs `depsCmd` inside it, and copies
  `copyGlobs` (e.g. gitignored local secrets) from `repoRoot` into it at the
  same relative path. Then runs the base tree's `agentproto.json` **setup**
  hooks (unless `runSetup: false`). Returns `{ cwd, branch }`.
- **`worktree.run-gate`** — run a caller-provided command inside a directory
  and report pass/fail from its exit code.
- **`worktree.cleanup`** — stop the worktree's supervised services, run the
  base tree's **teardown** hooks (failures logged, never blocking), then
  `git worktree remove` (+ optional `git branch -D`).
- **`worktree.run-script`** — run a declared `scripts.<name>` command once
  inside a worktree, with the `AGENTPROTO_*` env injected.
- **`worktree.start-service` / `worktree.stop-service` / `worktree.list-services`**
  — start/stop/list the declared `type: "service"` scripts as supervised
  long-running children with allocated ports and a `*.localhost` proxy route.

The gate/provision/cleanup trio is agnostic: no hardcoded package manager, env
layout, or gate command — everything is an input.

## `agentproto.json` — per-repo worktree lifecycle

Drop an `agentproto.json` at the repo root to declare how a fresh worktree is
set up, torn down, and what dev services it runs:

```json
{
  "worktree": {
    "setup": ["pnpm install", "cp \"$AGENTPROTO_SOURCE_CHECKOUT_PATH/.env\" .env"],
    "teardown": "rm -rf .cache"
  },
  "scripts": {
    "test": { "command": "pnpm test" },
    "web":  { "command": "pnpm dev --port $AGENTPROTO_PORT", "type": "service", "port": 3000 },
    "api":  { "command": "pnpm api --port $AGENTPROTO_PORT", "type": "service" }
  }
}
```

- **`worktree.setup` / `worktree.teardown`** — a single (multiline) shell
  string or an array of commands, run sequentially with the worktree as cwd.
  A failing setup command **fails provisioning** with its captured output; a
  failing teardown command is logged but never blocks cleanup.
- **`scripts.<name>`** — `{ command, type?: "service", port? }`. Plain scripts
  run once (`worktree.run-script`); `type: "service"` scripts are supervised
  long-running processes (`worktree.start-service`).

### Security: config is read from the committed base tree

`agentproto.json` is **always** read via `git show <base>:agentproto.json` —
the committed tree of the base ref (default `origin/main`), never a worktree's
working tree. A feature branch or an agent editing files inside a worktree
therefore **cannot inject** setup/teardown hooks or service commands that run
on the host; only what a reviewer merged into the base branch executes.

### Environment

Every hook, script, and service receives:

| Variable | Meaning |
| --- | --- |
| `AGENTPROTO_SOURCE_CHECKOUT_PATH` | Absolute path to the original repo checkout |
| `AGENTPROTO_WORKTREE_PATH` | Absolute path to the worktree directory |
| `AGENTPROTO_BRANCH_NAME` | The worktree's branch name |

Each **service** additionally receives its own `AGENTPROTO_PORT` and
`AGENTPROTO_URL` (its proxy URL), plus peer-discovery vars for every sibling
service in the same worktree: `AGENTPROTO_SERVICE_<NAME>_PORT` and
`AGENTPROTO_SERVICE_<NAME>_URL` (name upper-cased, non-alphanumerics → `_`).

### Services, ports, and the reverse proxy

- **Port allocation** — a service uses its declared `port` when free, else an
  OS-assigned ephemeral port. Ports are reserved up front for every declared
  service so peer discovery is complete.
- **Reverse proxy** — `ProxyTable` + `createProxyServer`/`startProxy` route
  `http://<script>--<branch-slug>--<repo-slug>.localhost:<proxy-port>` to a
  service's local port, with WebSocket upgrade passthrough. On the repo's
  default branch the branch label is dropped:
  `http://<script>--<repo-slug>.localhost:<proxy-port>`. Slugging lowercases,
  maps non-alphanumerics to `-`, collapses repeats, and trims. `*.localhost`
  resolves to `127.0.0.1` on modern systems, so no DNS setup is needed.

### `agentproto worktree` CLI

```
agentproto worktree ls      [--repo <dir>] [--json]
agentproto worktree archive <path> [--base <ref>] [--keep-branch] [--json]
```

`ls` lists the repo's git worktrees; `archive` stops a worktree's services,
runs its teardown hooks, and removes it (deleting the branch unless
`--keep-branch`).

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
