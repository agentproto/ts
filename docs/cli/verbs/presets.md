# `agentproto presets`

```text
agentproto presets list [--json]
```

List the built-in provider gateway presets shipped in
`@agentproto/provider-presets` (moonshot, openrouter, deepseek, xai), each with
its live key-env status. A preset is static data a claude-code / claude-sdk
agent can front via a mode or the `base_url` option — there is no install step,
no setup pipeline, and no credentials store.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)). Discovery reads `~/.agentproto/runtime.json`, same
as [`tunnel list`](./tunnel.md).

## Status

Status is answered from the **daemon's** `process.env` — where agents actually
spawn — not from your shell. A preset can read `ready` in the daemon while the
key is unset in the terminal you typed the command into, and vice versa.

| Status | Meaning |
|--------|---------|
| `ready` | The preset's API-key env var is set (e.g. `MOONSHOT_API_KEY`). |
| `available` | The env var isn't set. Export it in the daemon's environment to make the preset ready, or pass an `auth_token` at spawn. |

## Subverbs

### `list`

Lists every preset via `GET /presets`.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the raw `AdapterEntry<PresetInfo>[]` array instead of the table. |

The table prints one row per preset: `ID`, `STATUS`, `SCHEMA`, `KEY ENV`,
`DEFAULT MODEL`, and `BASE URL`. `SCHEMA` is the preset's wire flavor —
`anthropic` for the gateways claude-code/claude-sdk front directly via
`ANTHROPIC_BASE_URL`, `openai` for one reached through the local
OpenAI-compatible proxy. A preset with no default model prints `—`; pick one
per session with `--model`.

## Examples

```bash
# What's shipped, and which keys the daemon can see
agentproto presets list

# Machine-readable — e.g. which presets are ready
agentproto presets list --json | jq -r '.[] | select(.status=="ready") | .slug'
```

```text
ID            STATUS      SCHEMA      KEY ENV                 DEFAULT MODEL       BASE URL
moonshot      ready       anthropic   MOONSHOT_API_KEY        kimi-k2.7-code      https://api.moonshot.ai/anthropic
openrouter    available   anthropic   OPENROUTER_API_KEY      —                   https://openrouter.ai/api
requesty      available   anthropic   REQUESTY_API_KEY        —                   https://router.requesty.ai
deepseek      available   anthropic   DEEPSEEK_API_KEY        deepseek-v4-pro     https://api.deepseek.com/anthropic
xai           available   openai      XAI_API_KEY             grok-4.5            http://localhost:18090/v1
```

Exit codes: `2` when no daemon is found (or an unknown subcommand is passed),
`1` when the `/presets` request fails.

## See also

- [`serve.md`](./serve.md) — the daemon that answers `/presets`
- [`models.md`](./models.md) — runnable models per adapter, with provider-key status
- [`auth.md`](./auth.md) — store provider API keys
