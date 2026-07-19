# `agentproto models`

```text
agentproto models [adapter] [--json]
```

Lists every model declared by installed agent adapters, annotating each
with its provider and whether a provider API key is configured (✓
runnable, or ✗ missing key). Prices — when known — come from
`@agentproto/model-catalog` ($ per 1M input/output tokens).

If no installed adapter declares a model list, the command prints
`no adapters installed — try: agentproto install claude-code`.

The point: `--model anthropic/claude-opus-4-8` fails at runtime with
"no ANTHROPIC_API_KEY" if you haven't set a key. This surfaces the issue up
front so you pick a model your environment is ready for.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit structured JSON instead of a table. |
| `--help`, `-h` | — | Print usage. |

## Output

Without `--json`, prints one adapter block per installed adapter with
its status, then one model per line:

```text
mastra-agent  (installed)
  ✓ openrouter/z-ai/glm-5.2                 openrouter $0/$0 per 1M
  ✓ openrouter/deepseek/deepseek-v4-pro     openrouter $0/$0 per 1M
  ✗ openai/gpt-5                            openai     $?/$? per 1M

✗ = no provider key. Set one:
    agentproto auth provider set openai <api-key>
```

With `--json`, emits:

```json
{
  "adapters": [
    {
      "adapter": "mastra-agent",
      "status": "installed",
      "models": [
        {
          "id": "openrouter/z-ai/glm-5.2",
          "provider": "openrouter",
          "runnable": true,
          "inputPer1M": null,
          "outputPer1M": null
        },
        {
          "id": "openrouter/deepseek/deepseek-v4-pro",
          "provider": "openrouter",
          "runnable": true,
          "inputPer1M": null,
          "outputPer1M": null
        },
        {
          "id": "openai/gpt-5",
          "provider": "openai",
          "runnable": false,
          "inputPer1M": null,
          "outputPer1M": null
        }
      ]
    }
  ]
}
```

## Provider key sources

A model is marked runnable (✓) when its provider has a key available from
either:

1. The current process environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `OPENROUTER_API_KEY`, etc.
2. The stored provider key file (`agentproto auth provider set …`).

## `catalog_models` (MCP) — the route/vendor/profile-aware catalog

`agentproto models` lists what each **adapter** declares. For the broader view —
every model this host can reach, widened beyond any one adapter's list via
OpenRouter / Requesty / HuggingFace routing — the daemon exposes the read-only
`catalog_models` MCP tool (backed by `GET /catalog/models`):

- entries are keyed by **vendor** / **product** and carry one entry per **route**
  (endpoint rail: `anthropic`, `openrouter`, `requesty`, …);
- each route has a **profile-aware `runnable` flag** — true only when an auth
  profile eligible for that `(adapter × route)` is actually configured on the
  host, so it answers "what is spawnable *right now*", not just "what key env var
  exists";
- filter with `adapter`, `vendor`, `route`, and `runnableOnly`.

Use it before `agent_start` to pick a `(model, route)` pair the host can run, and
alongside the [`access` config axis](./sessions.md#config-axes-mcphttp) (named
auth profiles) that decides which profile pays.

## Examples

```bash
# All adapters, all models
agentproto models

# One adapter in detail
agentproto models mastra-agent

# Machine-readable
agentproto models --json | jq '.adapters[].models[] | select(.runnable) | .id'
```

## See also

- [`auth.md`](./auth.md) — set provider keys with `agentproto auth provider set`
- [`run.md`](./run.md) — pass `--model` to a one-shot turn
- [`chat.md`](./chat.md) — pass `--model` to an interactive session
- [`concepts/adapters.md`](../concepts/adapters.md) — how adapters declare models