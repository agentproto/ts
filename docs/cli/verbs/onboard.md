# `agentproto onboard`

```text
agentproto onboard [--yes] [--no-skills] [--skills <slug>] [--agent <name>...]
```

First-run umbrella that wires your coding agents to the daemon in one pass:
register the daemon's MCP server, then install the agentproto skill pack.

It's a thin wrapper over two verbs that stay independently usable and
unchanged — reach for those directly when you only want one half:

| Step | Runs | Standalone verb |
|------|------|-----------------|
| ① MCP registration | Registers the daemon's MCP server with every detected agent | [`install-mcp`](./install-mcp.md) |
| ② Skill pack | Installs `skill/agentproto-pack` into skill-capable agents | [`install skill/<name>`](./install.md) |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--yes` | `false` | Non-interactive — forwarded to `install-mcp`. |
| `--no-skills` | `false` | Skip step ②. Step ① still runs. |
| `--skills <slug>` | `skill/agentproto-pack` | Install this skill instead of the full pack. A bare slug is accepted — `--skills nested-orchestration` becomes `skill/nested-orchestration`. |
| `--agent <name>` | *(all detected)* | Limit MCP registration to these agents; repeatable. Passed straight through to `install-mcp --agent`, so the same names apply: `claude`, `cursor`, `codex`, `claude-desktop`, `aider`, `hermes`. With none given, `install-mcp --all` runs. |

## Output

Each step reports, then a summary lists both as `ok`, `skipped`, or
`failed (exit N)`:

```text
onboarding summary
  MCP registration : ok
  skill pack       : ok

Next: `agentproto daemon install` then `agentproto serve`.
```

The exit code is the MCP step's code when that failed, otherwise the skill
step's (`0` when skipped) — so a green `onboard` means both halves landed.

## Examples

```bash
# The usual first run — wire everything detected, no prompts
agentproto onboard --yes

# MCP only, no skills
agentproto onboard --yes --no-skills

# Just Claude Code, and only one skill instead of the pack
agentproto onboard --agent claude --skills nested-orchestration
```

## See also

- [`install-mcp.md`](./install-mcp.md) — step ① on its own, plus `--update` / `--uninstall`
- [`install.md`](./install.md) — step ② on its own, and adapter/profile installs
- [`daemon.md`](./daemon.md) — the suggested next step: install the background service
