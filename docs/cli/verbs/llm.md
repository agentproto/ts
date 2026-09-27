# `agentproto llm`

```text
agentproto llm endpoints list [--json]
agentproto llm endpoints test [--json]
agentproto llm endpoints add <name> --url <baseUrl> [--connector <id>] [--api-key-env VAR] [--json]
agentproto llm endpoints remove <name> [--json]
agentproto llm endpoints detect [--dry-run] [--json]
agentproto llm endpoints sync-pi [--dry-run] [--json]
```

Read/write visibility into the LLM gateway's (`@agentproto/llm-endpoint`)
**named endpoints** — local/LAN OpenAI-compatible model servers (LM Studio,
Ollama, llama-server, vLLM, …) the gateway can route `<id>/<model>` requests
to, alongside its fixed hosted providers and the single `forge` self-hosted
slot.

Endpoints are configured in `~/.agentproto/llm-endpoints.json`
(`LLM_ENDPOINT_ENDPOINTS_FILE` overrides the path). `list`/`test` are
read-only; `add`/`remove`/`detect` edit the file for you — a hand edit still
works too:

```jsonc
{
  "endpoints": [
    {
      "id": "bonsai",
      "kind": "openai",
      "baseUrl": "http://192.168.1.20:8081/v1",
      "connector": "llama-server",
      "apiKeyEnv": "BONSAI_API_KEY",
      "defaultRequestFields": { "chat_template_kwargs": { "enable_thinking": false } },
      "timeoutMs": { "firstTokenMs": 180000 }
    },
    { "id": "ollama", "kind": "openai", "baseUrl": "http://192.168.1.20:11434/v1", "connector": "ollama" },
    {
      "id": "lmstudio",
      "kind": "openai",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "connector": "lmstudio",
      "defaultRequestFields": { "reasoning_effort": "none" }
    }
  ]
}
```

The field names mirror `openagentik/router`'s `providers[]` schema, so a
config is portable between the two gateways. `connector` is new: it names
which local/LAN runtime `baseUrl` points at (`lmstudio`, `ollama`, `vllm`,
`llama-server`, or the generic `openai-compatible` fallback) — it never
affects request routing, only which connector's model listing/context-size
detail `test`/`detect`/`doctor` show. See the `@agentproto/llm-endpoint`
README's "Named endpoints" section for the full shape and how the gateway
routes/merges these at runtime (`GET /v1/models`, `GET /v1/endpoints`,
`defaultRequestFields` merging, and the `LLM_ENDPOINT_PASSTHROUGH_THINKING`
reasoning-content fallback).

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
many models it listed — plus, for a reachable endpoint, its connector's own
`listModels()` detail (per-model load state and context size, e.g. `ctx=
62976/262144`). Exits `1` if any endpoint is unreachable — useful as a quick
"is my LAN model server actually up" check before pointing a client at the
gateway.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{path, results:[{id, baseUrl, connector, reachable, models, connectorModels, latencyMs, detail?}]}` instead of the table. |

### `endpoints add <name> --url <baseUrl>`

Adds one named endpoint and writes it to the file (creating
`~/.agentproto/llm-endpoints.json` and its parent directory if missing).
`--connector` defaults to `auto`: probes `<baseUrl>` to identify which
runtime is serving it, falling back to `openai-compatible` (with a warning,
not a failure — the entry is still useful once the server comes up) if
nothing answers there yet. An explicit `--connector <id>` skips probing.
Rejects a duplicate/reserved id (`forge`) without writing anything.

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | — | Required. The endpoint's OpenAI-compatible base URL, e.g. `http://127.0.0.1:1234/v1`. |
| `--connector` | `auto` | `auto`, or one of `lmstudio`, `ollama`, `vllm`, `llama-server`, `openai-compatible`. |
| `--api-key-env` | — | Name of an env var holding the key (never the key value itself). Omit for a keyless endpoint. |
| `--json` | `false` | Emit the written `EndpointConfig` instead of a confirmation line. |

### `endpoints remove <name>`

Removes one named endpoint from the file. Exits `1` (naming the known ids)
if `<name>` isn't configured.

### `endpoints detect`

Probes the default local ports (LM Studio 1234, Ollama 11434, llama-server
8080, vLLM 8000) on `127.0.0.1` and adds/updates the matching endpoint —
keyed by connector id (`lmstudio`, `ollama`, `llama-server`, `vllm`) — for
each one found running. A re-run is idempotent (updates the same entry in
place); unrelated entries are left untouched. Nothing running on any of
those ports is a normal outcome, not an error (exit `0`).

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Report what would change without writing the file. |
| `--json` | `false` | Emit `{detected:[{id, baseUrl, connector, action}], path}` instead of the table. |

### `endpoints sync-pi`

Regenerates the matching provider entry in `~/.pi/agent/models.json` (the
`pi` harness's own model registry) for every configured endpoint, from its
connector's LIVE loaded models — `contextWindow` is always the loaded ctx,
never the max, so pi's config can't drift stale the way a hand edit does.
Ownership of what this command wrote is tracked in
`~/.agentproto/pi-models-managed.json`; only those model ids are ever
added/updated/removed on a re-run — a hand-added provider or model in the
same file is left exactly as-is. A model with no loaded instance right now
is simply skipped, not an error.

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Report what would change without writing either file. |
| `--json` | `false` | Emit the full per-endpoint sync result instead of the table. |

## Examples

```bash
agentproto llm endpoints list
#   Configured endpoints (~/.agentproto/llm-endpoints.json):
#     bonsai  http://192.168.1.20:8081/v1  key: BONSAI_API_KEY (set)
#     ollama  http://192.168.1.20:11434/v1  key: (keyless — no apiKeyEnv)

agentproto llm endpoints test
#     ✓ reachable  bonsai  http://192.168.1.20:8081/v1  connector=llama-server  1 model(s), 42ms
#         - bonsai-27b  state=loaded ctx=32768/32768
#     ✗ unreachable  ollama  http://192.168.1.20:11434/v1  connector=ollama  fetch failed

agentproto llm endpoints detect
#   Detected lmstudio at http://127.0.0.1:1234/v1 -> wrote endpoint "lmstudio"

agentproto llm endpoints add bonsai --url http://192.168.1.20:8081/v1 --connector llama-server
#   Added endpoint "bonsai" (connector: llama-server) -> http://192.168.1.20:8081/v1

agentproto llm endpoints sync-pi
#     lmstudio  http://127.0.0.1:1234/v1  added  models: bonsai-27b-win
#   Wrote /Users/you/.pi/agent/models.json

agentproto llm endpoints list --json | jq -r '.endpoints[].id'
```

## See also

- The `@agentproto/llm-endpoint` README's "Named endpoints" section — the
  config file's full shape, routing/merging behavior, and the gateway's own
  `GET /v1/endpoints` health route.
- [`doctor.md`](./doctor.md) — `agentproto doctor` includes an optional
  `local-models` step ("Inference endpoints") that probes the same endpoints
  (plus `forge`, if `FORGE_BASE_URL` is set) as part of a full install check.
