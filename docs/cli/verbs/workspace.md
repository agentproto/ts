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
```

Registry file: `~/.agentproto/workspaces.json` (mode 0600).

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

When a sandbox spawn also passes `worktree`, the daemon cuts `wt/<slug>`
from `worktree.base` (default `origin/<branch>`) in the box and starts the
session there. The token reaches the box only as the `AGENTPROTO_GIT_TOKEN`
env var behind a git credential helper. Note that the agent running in the
box can read that variable, so register a token scoped to the one repository
and revoke it when the work is done; a box booted with a workspace's token
can only be reused by that same workspace. At teardown the work branch is
pushed to `origin` if it is ahead of its base, with a `git bundle` fallback
saved to `~/.agentproto/sessions/<id>/delivery.bundle`; the outcome is
recorded on the session descriptor as `sandboxDelivery`.

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
