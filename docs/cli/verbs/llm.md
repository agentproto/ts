# `agentproto llm`

```text
agentproto llm endpoints list [--json]
agentproto llm endpoints test [--json]
```

Read-only visibility into the LLM gateway's (`@agentproto/llm-endpoint`)
**named endpoints** — local/LAN OpenAI-compatible model servers (Ollama,
llama-server, vLLM, …) the gateway can route `<id>/<model>` requests to,
alongside its fixed hosted providers and the single `forge` self-hosted slot.

Endpoints are configured in `~/.agentproto/llm-endpoints.json`
(`LLM_ENDPOINT_ENDPOINTS_FILE` overrides the path), not through this CLI —
`add`/`remove` verbs don't exist yet; edit the file directly:

```jsonc
{
  "endpoints": [
    {
      "id": "bonsai",
      "kind": "openai",
      "baseUrl": "http://192.168.1.20:8081/v1",
      "apiKeyEnv": "BONSAI_API_KEY",
      "defaultRequestFields": { "chat_template_kwargs": { "enable_thinking": false } },
      "timeoutMs": { "firstTokenMs": 180000 }
    },
    { "id": "ollama", "kind": "openai", "baseUrl": "http://192.168.1.20:11434/v1" },
    {
      "id": "lmstudio",
      "kind": "openai",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "defaultRequestFields": { "reasoning_effort": "none" }
    }
  ]
}
```

The field names mirror `openagentik/router`'s `providers[]` schema, so a
config is portable between the two gateways. See the
`@agentproto/llm-endpoint` README's "Named endpoints" section for the full
shape and how the gateway routes/merges these at runtime (`GET /v1/models`,
`GET /v1/endpoints`, `defaultRequestFields` merging, and the
`LLM_ENDPOINT_PASSTHROUGH_THINKING` reasoning-content fallback).

## Subverbs

### `endpoints list`

Prints each configured endpoint's id, `baseUrl`, and whether its `apiKeyEnv`
(if any) is currently set in this shell — no network call. An invalid
`llm-endpoints.json` (bad JSON, a bad `baseUrl`, a duplicate id, …) exits `1`
with the same field-scoped errors the gateway itself would log at boot.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{path, endpoints:[{id, baseUrl, apiKeyEnv, apiKeySet}]}` instead of the table. Never includes the key value itself. |

### `endpoints test`

Live reachability check: a `GET <baseUrl>/models` per configured endpoint
(4s timeout each, run in parallel), reporting whether it answered and how
many models it listed. Exits `1` if any endpoint is unreachable — useful as a
quick "is my LAN model server actually up" check before pointing a client at
the gateway.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{path, results:[{id, baseUrl, reachable, models, latencyMs, detail?}]}` instead of the table. |

## Examples

```bash
agentproto llm endpoints list
#   Configured endpoints (~/.agentproto/llm-endpoints.json):
#     bonsai  http://192.168.1.20:8081/v1  key: BONSAI_API_KEY (set)
#     ollama  http://192.168.1.20:11434/v1  key: (keyless — no apiKeyEnv)

agentproto llm endpoints test
#     ✓ reachable  bonsai  http://192.168.1.20:8081/v1  1 model(s), 42ms
#     ✗ unreachable  ollama  http://192.168.1.20:11434/v1  fetch failed

agentproto llm endpoints list --json | jq -r '.endpoints[].id'
```

## See also

- The `@agentproto/llm-endpoint` README's "Named endpoints" section — the
  config file's full shape, routing/merging behavior, and the gateway's own
  `GET /v1/endpoints` health route.
- [`doctor.md`](./doctor.md) — `agentproto doctor` includes an optional
  `local-models` step that probes the same endpoints (plus `forge`, if
  `FORGE_BASE_URL` is set) as part of a full install check.
