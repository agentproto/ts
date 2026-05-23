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
