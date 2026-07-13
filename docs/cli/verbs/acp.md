# `agentproto acp`

```text
agentproto acp ls  [--json]
agentproto acp add <slug> --bin <bin> [--args <arg>…] [--name <name>]
                          [--desc <text>] [--env <K=V>…] [--resumable] [--json]
agentproto acp rm  <slug> [--json]
```

Manage **generic ACP agents** — any CLI that already speaks the
[Agent Client Protocol](https://agentclientprotocol.com), connectable with
zero adapter code. See [`concepts/adapters.md`](../concepts/adapters.md#generic-acp-agents-zero-code)
for the full model (curated catalog vs config-defined agents, resolution
precedence).

`ls` reflects both the built-in `ACP_CATALOG` and your
`~/.agentproto/config.json` `acpAgents`; `add`/`rm` only ever touch the
config file — the curated catalog is read-only.

## `acp ls`

Lists the curated ACP catalog plus your config-defined agents, each with a
status derived from bin presence:

- `available` — the `bin` is found on `PATH`.
- `supported` — not installed; the install hint is shown beneath the row.

```text
SLUG              STATUS      SOURCE        NAME
gemini-cli        supported   acp-catalog   Gemini CLI
                  ↳ install: npm install -g @google/gemini-cli
my-agent          available   acp-config    My Agent
```

`--json` emits the entries as a JSON array instead.

## `acp add`

Registers a generic ACP agent in `~/.agentproto/config.json` under
`acpAgents.<slug>`. A config entry **shadows** a catalog entry of the same
slug.

| Flag | Purpose |
|------|---------|
| `--bin <bin>` | Executable to spawn (**required**). |
| `--args <arg>…` | Extra argv, e.g. the ACP flag. Repeatable. |
| `--name <name>` | Display name. Default: the slug. |
| `--desc <text>` | One-line description. |
| `--env <K=V>…` | Always-on spawn env var. Repeatable. |
| `--resumable` | Advertise `resumable` + native-resume continuation. |
| `--install-hint <text>` | Shown in `acp ls` when the bin is missing. |
| `--json` | Emit the written entry as JSON. |

The slug must be lower-kebab and ≥2 chars (AIP-45 id rule); an invalid
slug or field is rejected before anything is written.

```bash
agentproto acp add my-agent --bin my-agent --args acp --resumable
agentproto acp add gemini-cli --bin gemini --args --experimental-acp
```

After a successful add the verb prints how to run it:

```text
Added generic ACP agent 'my-agent'.
  Run it with:  agentproto run my-agent --prompt "..."
```

## `acp rm`

Removes one of your config-defined agents. Curated catalog entries have no
config entry and cannot be removed (the verb says so and exits `1`). When
the last config agent is removed the `acpAgents` key is dropped entirely.

```bash
agentproto acp rm my-agent
```

## See also

- [`concepts/adapters.md`](../concepts/adapters.md) — adapters, generic ACP
  agents, resolution precedence.
- [`run.md`](./run.md) — spawn any resolved slug for a single turn.
- [`config.md`](./config.md) — the `~/.agentproto/config.json` surface.
