# `agentproto workspace`

Manage the set of local directories the CLI knows about. A
workspace is a registered repo or project that other verbs (`run`,
`sessions`, the daemon's session APIs) can target by slug instead of
by absolute path.

```
agentproto workspace add <path> [--slug <slug>] [--label <text>]
agentproto workspace list
agentproto workspace use <slug>
agentproto workspace remove <slug>
agentproto workspace remote set <slug> --url <https-url> [--branch <branch>]
                               [--credential-ref <ref> | --token-stdin]
agentproto workspace remote show <slug> [--json]
agentproto workspace remote unset <slug>
agentproto workspace check <dir> [--json] [--max-report-age-hours <n>]
```

`add` / `list` / `use` / `remove` / `remote` manage the registry file
`~/.agentproto/workspaces.json` (mode 0600) — a folder the daemon can spawn
sessions against. `check` is a different concern: it validates an AIP-34
`workspace/v2` tree on disk (see below).

## Subverbs

### `add <path>`

Register a local directory.

```bash
agentproto workspace add ~/code/my-project --slug my-project
agentproto workspace add . --slug current
```

- `--slug <slug>` — kebab-case identifier other verbs use. Defaults to
  the directory basename if omitted.
- `--label <text>` — human-readable description shown by `list`.

If a workspace with the same slug already exists, `add` errors out;
use `remove` first or pick a different slug.

### `list`

Print every registered workspace.

```bash
agentproto workspace list
```

Shows slug, absolute path, label, and which one is currently active
(see `use`).

Add `--json` for machine-readable output.

### `use <slug>`

Make a workspace the active default. Verbs that accept `--workspace
<slug>` use this when the flag is omitted.

```bash
agentproto workspace use my-project
```

The active workspace is stored as `activeWorkspace` in the same
`workspaces.json`.

### `remove <slug>`

Unregister a workspace. The directory on disk is NOT touched — only
the registry entry is removed.

```bash
agentproto workspace remove my-project
```

### `remote set|show|unset <slug>`

Attach an off-machine git clone source to a registered workspace. A
sandbox spawn (`agent_start` with `workspaceSlug` + `sandbox`) clones this
remote into the box, since the host path means nothing there.

```bash
echo "$GITHUB_PAT" | agentproto workspace remote set my-project \
  --url https://github.com/acme/my-project.git --token-stdin
agentproto workspace remote show my-project
agentproto workspace remote unset my-project
```

- `set` requires `--url <https-url>` (https only) and an existing
  workspace. `--branch <branch>` sets the default branch (default `main`).
- The git token is never a flag. `--token-stdin` reads it from stdin and
  stores it in the OS keychain as `agentproto.git.<slug>`;
  `--credential-ref <ref>` names an existing keychain slot instead. The two
  are mutually exclusive. With neither, an existing credential on the
  workspace is kept.
- `show` prints the remote (`--json` for machine-readable output); it exits
  `1` when no remote is set.
- `unset` drops the remote but leaves any keychain token in place.

A sandbox spawn on a workspace with a remote cuts a `wt/<slug>` work branch
in the box by default, from `worktree.base` (default `origin/<branch>`), and
starts the session there; pass `worktree: false` to opt out and work on the
remote's default branch with no work branch (and so no delivery). The token
reaches the box only as the `AGENTPROTO_GIT_TOKEN` env var behind a git
credential helper, and the same token is also set as `GH_TOKEN` so `gh pr
create` works in the box (the token needs Contents + Pull requests write).
Both names are reserved: they are stripped from caller-declared
`env.passthrough` / `env.auth.state.env` / `join.tokenEnv`, and `GH_TOKEN`
never resolves to the daemon's own. Note that the agent running in the
box can read these variables, so register a token scoped to the one repository
and revoke it when the work is done; a box booted with a workspace's token
can only be reused by that same workspace. At teardown the work branch is
pushed to `origin` if it is ahead of its base, with a `git bundle` fallback
saved to `~/.agentproto/sessions/<id>/delivery.bundle`; the outcome is
recorded on the session descriptor as `sandboxDelivery`.

### `check <dir>`

```bash
agentproto workspace check ~/agentproto
agentproto workspace check ~/agentproto --json
agentproto workspace check ~/agentproto --max-report-age-hours 24
```

Verifies an AIP-34 `workspace/v2` **tree** on disk — unrelated to the local
registry above; it never reads or writes `workspaces.json`. Walks every
`WORKSPACE.md` node under `<dir>` and validates:

- each node's `type` against the tree's `TYPES.md` (allowed parents, wall
  floor, required files, with report freshness via `--max-report-age-hours`,
  default `48`);
- two-sided `includes`/`exports` and `apps`/`accepted_apps` consent;
- `uses_secrets` grants against the provider's `SECRETS.md`, plus a
  no-literal-secret-values heuristic;
- `policy.limits` budget aggregation (most-restrictive-wins down the tree);
- path confinement on every resolved file reference (tree-relative, no `..`
  traversal, no symlink escape — checked via realpath).

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit the full `CheckReport` (`ok`, `root`, `nodeCount`, `nodes[]`, `findings[]`). |
| `--max-report-age-hours <n>` | `48` | Age threshold for stale required reports (`work.file`, …). |

Human output lists each node (`id`, type, wall, inherited status, budget)
then one line per finding (`error` `✗` / `warning` `!` / `info` `·`) with
its path. Exit `0` when the tree has no errors, `1` when it has any
(warnings alone still exit `0`), `2` for bad arguments.

## Where workspaces are used

- [`agentproto sessions`](./sessions.md) — `start` and `terminal`
  accept `--workspace <slug>` to set the spawned process's `cwd`.
- [`agentproto serve`](./serve.md) — the daemon's session APIs
  resolve workspace slugs sent from the tunnel host.
- [`agentproto run`](./run.md) — `--cwd` accepts either an absolute
  path or `<slug>` resolved against the registry.

## Examples

```bash
# Register two repos
agentproto workspace add ~/code/my-app --slug my-app
agentproto workspace add ~/code/scratch --slug scratch --label "Throwaway experiments"

# Pin the active one
agentproto workspace use my-app

# Spawn a Claude Code session in scratch without changing the active default
agentproto sessions start claude-code --workspace scratch --attach
```
