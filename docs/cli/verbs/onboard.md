# `agentproto onboard`

```text
agentproto onboard [--yes] [--no-skills] [--skills <slug>] [--agent <name>...]
```

Alias of the onboarding wizard, [`agentproto setup`](./setup.md) with no
slug. Its original flags keep working, mapped onto the wizard:

| Flag | Maps to |
|------|---------|
| `--yes` | `setup --yes` — apply the defaults without prompting (never secrets). |
| `--no-skills` | `setup --skip skills`. |
| `--skills <slug>` | The skills step installs this skill instead of the full pack. A bare slug is accepted — `--skills nested-orchestration` becomes `skill/nested-orchestration`. |
| `--agent <name>` | MCP registration is limited to these clients; repeatable. Names as in [`install-mcp`](./install-mcp.md): `claude`, `cursor`, `codex`, `claude-desktop`, `aider`, `windsurf`, `hermes`. |

Exit codes and output are the wizard's — see [`setup.md`](./setup.md).

## Examples

```bash
# Unattended first run
agentproto onboard --yes

# Everything but the skill pack
agentproto onboard --yes --no-skills

# Just Claude Code, and one skill instead of the pack
agentproto onboard --agent claude --skills nested-orchestration
```

## See also

- [`setup.md`](./setup.md) — the wizard itself, all flags
- [`install-mcp.md`](./install-mcp.md) — MCP registration on its own
- [`install.md`](./install.md) — skill-pack install on its own
