# `agentproto worktree`

```text
agentproto worktree ls      [--repo <dir>] [--status] [--json]
agentproto worktree new     <slug> [--repo <dir>] [--base <ref>] [--branch <name>]
                                   [--root <dir>] [--no-setup] [--json]
agentproto worktree rm      <path> [--repo <dir>] [--base <ref>] [--keep-branch]
                                   [--discard-untracked] [--discard-modified] [--json]
agentproto worktree archive <path> [--repo <dir>] [--base <ref>] [--keep-branch] [--json]
agentproto worktree gc      [--repo <dir>] [--apply] [--salvage-dirty]
                                   [--include-detached] [--json]
```

Create, inspect, and tear down git worktrees. A pure local shell over
`@agentproto/worktree` — no daemon required.

`new` provisions under a single `worktrees.root` so worktrees stop sprawling
across hand-picked parents. `rm`, `archive`, and `gc` are deliberately
root-agnostic on the other side: they take an explicit `<path>` and derive
everything from that path's own git metadata, so they can also tear down
worktrees `new` didn't create.

## `worktrees.root`

Resolved with the same precedence as every other knob (flag > env > config >
default):

| Source | |
|--------|--|
| `--root <dir>` | flag on `new` |
| `AGENTPROTO_WORKTREES_ROOT` | env |
| `worktrees.root` | `~/.agentproto/config.json` |
| `~/.agentproto/worktrees` | default |

## Subverbs

### `ls`

Lists the repo's worktrees. The plain form parses `git worktree list
--porcelain` — a fast local path, no forge round-trip.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo; the main repo root is derived from it. |
| `--status` | `false` | Run the status engine per entry — adds tree/integration/liveness axes, provenance, and a reclaim/salvage/hold class. Needs `gh`/`GITHUB_TOKEN` (memoised in `~/.agentproto/worktree-verdicts.json`). |
| `--json` | `false` | Emit the entries as JSON. |

### `new <slug>`

Creates a worktree at `<worktrees.root>/<repoName>/<slug>` and writes a
creation-provenance marker into its private gitdir.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Repo to cut the worktree from. |
| `--base <ref>` | `origin/main` | Ref the branch is cut from. |
| `--branch <name>` | `wt/<slug>` | Branch to create. |
| `--root <dir>` | *(see above)* | Override `worktrees.root` for this run. |
| `--no-setup` | `false` | Skip the repo's `agentproto.json` setup hooks. |
| `--json` | `false` | Emit the provisioned descriptor as JSON. |

### `rm <path>`

The honest plain-destructive verb. Stops the worktree's services, runs its
committed teardown hooks, then removes it — and **refuses a dirty tree** unless
the flag matching the class of change present authorizes it.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | *(from `<path>`)* | Repo that owns the worktree. |
| `--base <ref>` | `origin/main` | Ref whose committed teardown hooks run. |
| `--keep-branch` | `false` | Keep the branch; by default it's deleted too. |
| `--discard-untracked` | `false` | Authorize discarding unignored untracked files. |
| `--discard-modified` | `false` | Authorize discarding modified tracked files. |
| `--json` | `false` | Emit `{"removed":path,"branch":str\|null}` as JSON. |

### `archive <path>`

Salvage-then-remove. Snapshots the worktree's uncommitted state to
`~/.agentproto/worktree-salvage/` (a `changes.patch`, a copy of every untracked
file, and a `MANIFEST.json`) **before** running the same removal as `rm` with
both discard flags granted — so nothing still on disk is lost. If the salvage
step fails, nothing is removed.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | *(from `<path>`)* | Repo that owns the worktree. |
| `--base <ref>` | `origin/main` | Ref whose committed teardown hooks run. |
| `--keep-branch` | `false` | Keep the branch. |
| `--json` | `false` | Emit `{"archived":path,"branch":…,"salvageDir":path}` as JSON. |

### `gc`

Classifies every linked worktree, then prints the plan. **Dry run by default —
nothing is touched without `--apply`.**

| Class | Definition | `--apply` does |
|-------|-----------|----------------|
| `reclaim` | (merged or fresh) + clean + idle | Removes it (plain, non-force `git worktree remove` — refuses if the tree turned dirty since the plan was made) and deletes its branch. |
| `salvage` | merged + dirty, and not written to in the last 15 minutes | Nothing, unless `--salvage-dirty` — then archives it (snapshot, then remove). |
| `hold` | everything else, including a fresh or merged branch with uncommitted work | **Never touched**, with or without flags. |

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Repo to sweep. |
| `--apply` | `false` | Execute the plan instead of printing it. |
| `--salvage-dirty` | `false` | Also archive salvage-class worktrees. |
| `--include-detached` | `false` | Also reclaim clean, idle detached worktrees. |
| `--json` | `false` | Emit the plan (or the outcomes, with `--apply`) as JSON. |

Between plan and apply, each entry is re-checked: one that reclassified or
vanished is aborted rather than acted on stale.

## Examples

```bash
# What's out there, and what shape is it in
agentproto worktree ls
agentproto worktree ls --status

# Cut a worktree for a branch off origin/main
agentproto worktree new my-feature
agentproto worktree new hotfix --base origin/release --branch fix/urgent

# Tear one down (refuses if dirty)
agentproto worktree rm ~/.agentproto/worktrees/myrepo/my-feature

# Keep the uncommitted work, then remove
agentproto worktree archive ~/.agentproto/worktrees/myrepo/my-feature

# Sweep: look first, then act
agentproto worktree gc
agentproto worktree gc --apply --salvage-dirty
```

## Spawning an agent straight into a worktree

`agent_start` takes a `worktree` field so a spawn isolates itself without a
separate `worktree new` first: `worktree: true` provisions one (branch
`wt/<slug>` cut from `origin/main`, slug auto-minted from the session label)
and lands the session in it; `worktree: { slug, base }` pins either. It bites
only for a **root** spawn whose cwd is inside a git repo — a spawn made through
an orchestrator inherits its parent's tree, and a cwd outside any repo spawns
plain.

The daemon can force the behaviour with `worktrees.isolation` in
`~/.agentproto/config.json` (or `AGENTPROTO_WORKTREES_ISOLATION`): `always`
isolates every root spawn, `never` turns it off (and rejects an explicit
`worktree`), `on-request` (default) honours the field. The provisioned tree is
**not** auto-removed on session exit — it holds the agent's work; reclaim it
with `rm` / `archive` / `gc` above.

## See also

- [`workspace.md`](./workspace.md) — registering workspaces the daemon binds sessions to
- [`sessions.md`](./sessions.md) — `--cwd` a session into a worktree
- [`reference/config-schema.md`](../reference/config-schema.md#worktrees-object) — the `worktrees.isolation` policy knob
