# @agentproto/worktree

AIP-14 TOOL contracts + a builtin AIP-30 PROVIDER for provisioning, gating,
and cleaning up a git worktree — the primitive a `@agentproto/workflow-runtime`
`AgentStep` binds its `cwd` to for a "launch an agent in a worktree" workflow.

## Tools

- **`worktree.provision`** — `git worktree add` a new worktree for `repoRoot`
  at `<repoRoot>/../_worktrees/<slug>` on branch `wt/<slug>`, cut from `base`
  (default `origin/main`). Before `depsCmd` runs: `linkPaths` are symlinked in,
  `writeFiles` are written, and `cloneGlobs` (e.g. `node_modules`) are cloned
  in — copy-on-write where the filesystem supports it, else a plain copy,
  never a symlink. Then `depsCmd` runs, then `copyGlobs` (e.g. gitignored
  local secrets) are copied from `repoRoot` into the worktree at the same
  relative path. Finally runs the base tree's `agentproto.json` **setup**
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
    "teardown": "rm -rf .cache",
    "depsCmd": "pnpm install --prefer-offline",
    "linkPaths": ["node_modules"]
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
- **`worktree.depsCmd` / `worktree.linkPaths`** — declarative defaults for
  `worktree.provision`'s own `depsCmd`/`linkPaths` inputs (see above): a
  caller that provisions a worktree WITHOUT passing those inputs explicitly —
  e.g. `agentproto worktree new`, or a spawn-time worktree from
  `agent_start.worktree` — still gets them applied, sourced from here. An
  explicit tool input always wins over this default. Same `runSetup` gate,
  same trust model as `setup`/`teardown` — see the Security section below.
- **`scripts.<name>`** — `{ command, type?: "service", port? }`. Plain scripts
  run once (`worktree.run-script`); `type: "service"` scripts are supervised
  long-running processes (`worktree.start-service`).

### Security: config is read from the committed base tree

`agentproto.json` is **always** read via `git show <base>:agentproto.json` —
the committed tree of the base ref (default `origin/main`), never a worktree's
working tree. A feature branch or an agent editing files inside a worktree
therefore **cannot inject** setup/teardown hooks or service commands that run
on the host; only what a reviewer merged into the base branch executes.

## `<repoRoot>/.agentproto/worktree.json` — local, per-machine worktree defaults

`agentproto.json` is committed and shared by everyone who clones the repo, so
it can't hold anything host-specific — a pnpm store path, whether to clone
`node_modules` at all. `.agentproto/worktree.json` fills that gap: a LOCAL,
gitignored, host-owned file (same idea as `.agentproto/allowed-commands.json`)
that one machine can drop to declare its own worktree defaults, without
committing them:

```json
{
  "cloneGlobs": ["node_modules"],
  "linkPaths": ["../sibling-repo"],
  "copyGlobs": ["envs/**/.env.local"],
  "writeFiles": [
    { "path": "pnpm-workspace.yaml", "content": "\nvirtualStoreDir: /abs/path/.pnpm-vstores/{slug}\n", "mode": "append" }
  ],
  "depsCmd": "pnpm install --prefer-offline"
}
```

- **`cloneGlobs`** — glob patterns (relative to `repoRoot`) of gitignored
  dirs/files cloned into the worktree BEFORE `depsCmd` runs. Copy-on-write
  where the filesystem supports it (macOS APFS `cp -c`/clonefile, Linux `cp
  --reflink=auto`), falling back to a plain copy — never a symlink, so
  `depsCmd` can mutate the clone (e.g. `pnpm install` repairing it) without
  touching the source checkout. A directory match is cloned as a whole unit
  (e.g. `node_modules` costs one `readdir`, not a walk of everything inside
  it); `**` is not supported — name each path segment explicitly.
- **`writeFiles`' `path`/`content`** may use a literal `{slug}` placeholder,
  substituted with the worktree's own slug — e.g. pointing pnpm's
  `virtualStoreDir` at a distinct, collision-free directory per worktree
  (mirrors the real use case this shipped for: `agentik-studio`'s
  `infra/cli/src/commands/wt.ts` `defaultWriteFiles`).
- **`copyGlobs` / `linkPaths` / `depsCmd`** — same shape and semantics as the
  matching `worktree.provision` inputs / `agentproto.json` fields above.

**Precedence** (highest wins): an explicit `worktree.provision` tool input >
this local file > `agentproto.json`'s committed `worktree.depsCmd`/
`worktree.linkPaths` (`copyGlobs`/`cloneGlobs`/`writeFiles` have no committed
equivalent, so for those the chain stops at this file). Same `runSetup` gate
as the committed config.

**Security model**: unlike `agentproto.json`, this file is read straight off
disk (never `git show`) from `repoRoot` — the SOURCE checkout, never the
freshly created worktree, which starts with no copy of it (the directory is
gitignored repo-wide). There is nothing here for the committed-config
guarantee to defend against: a branch can't smuggle this file in, because it
can never be committed at all. The trust model is simply "whoever owns this
machine's filesystem" — same as `allowed-commands.json`.

Path-traversal guard: a `cloneGlobs` pattern that could resolve outside
`repoRoot` (a leading `/`, or any `..` segment) is rejected before any
filesystem access.

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

## Provisioning concurrency (daemon-wide queue)

`worktree.provision` runs its heavy phases (`cloneGlobs`, `depsCmd`,
`copyGlobs`, `setup` hooks) through `provisionScheduler`, a process-wide FIFO
queue with a cap (default 2; `0` = unlimited). One slot covers the whole heavy
segment of one provisioning, so a single spawn never interleaves with itself.
`git worktree add` and the cheap prep (`linkPaths`, `writeFiles`) run before
the queue and are never throttled.

```ts
import { provisionScheduler, parseProvisionLimits, runWithProvisionContext } from "@agentproto/worktree"

provisionScheduler.configure(parseProvisionLimits(config.worktrees))

await runWithProvisionContext(
  { callerKey: parentSessionId, signal, onProgress: p => log(p) },
  () => runTool({ tool: provisionWorktreeTool, candidates, input }),
)
```

- **Fairness.** FIFO, with the caller holding the fewest running slots going
  first, so one orchestrator's burst cannot starve another caller.
- **Cancellation.** Aborting `signal` drops a queued entry, or kills a running
  phase's whole process group (SIGTERM, then SIGKILL after 5s), and rejects
  with `ProvisionCancelledError`. A cancelled provisioning removes its
  half-made worktree and branch; a plain failure keeps the worktree.
- **Progress.** `onProgress` receives `queued` (with `position`), `started`,
  `phase` and `done` (`ok`, `failed` or `cancelled`).
- **Config.** `worktrees.provisionConcurrency`,
  `worktrees.provisionConcurrencyByRepo`, `worktrees.provisionLoadFactor` in
  `~/.agentproto/config.json`; env `AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY`
  wins. See the CLI docs for the full table.
- **Scope.** The queue is per process. The daemon owns the shared one;
  `agentproto worktree new` has its own instance.

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

## `worktree-gc` routine (AIP-41, opt-in)

`routines/worktree-gc/ROUTINE.md` is a reference AIP-41 routine that reaps
merged worktrees on a schedule, so a long-running workspace doesn't accumulate
stale `_worktrees/*` trees and dead `wt/*` branches. It fires the `worktree_gc`
tool (the daemon's MCP/HTTP surface over `planGc` / `applyGc` in `src/gc.ts`)
with `apply: true`, `salvageDirty: false` on a daily cron (`0 4 * * *`, UTC).

**It ships disabled (`enabled: false`)** — it registers but never fires until
you turn it on. To activate it in a workspace:

1. Copy `routines/worktree-gc/` to the workspace's routine library at
   `<workspace>/.routines/worktree-gc/ROUTINE.md` (the path
   `@agentproto/routine`'s `routineSpec.pathOf` expects).
2. Set `enabled: true` in the frontmatter. To pin a specific repo, add
   `repoRoot: <abs path>` or `workspaceSlug: <slug>` to `target.inputs`;
   otherwise the daemon resolves the repo from the **active workspace**.
3. Reload routines so the daemon registers the schedule.

The safety invariants are enforced by the engine and cannot be weakened by the
routine: reclaim is **merge-gated** (integration ∈ {merged, fresh} **and** the
tree is clean) **except** for a narrow dep-bump exemption: a clean `unpushed`
worktree whose commits are all mechanical dependency bumps (`chore(deps)` /
`fix(deps)` subjects and a diff touching only lockfiles + `package.json`) is
also promoted to `reclaim`. An **open** PR or live-session worktree is always
**held**, and a **dirty** integrated worktree is only ever archived — never
discarded — and only when `salvageDirty` is `true`.
