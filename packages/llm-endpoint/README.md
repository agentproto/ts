# @agentproto/llm-endpoint

A lightweight **multi-surface LLM proxy gateway**. It exposes three API
surfaces from a single port:

- `POST /v1/messages` — Anthropic Messages compatibility. Claude-shaped model
  aliases are supported **only** through an explicit local compatibility pack.
- `POST /v1/chat/completions` — OpenAI Chat Completions compatibility with
  transparent `provider/model` routing.
- `POST /v1/responses` — OpenAI Responses API facade for Codex custom providers.

Requests are fanned out to upstream providers — **Moonshot, OpenRouter, ZAI/Zhipu,
Groq, xAI, direct OpenAI, Nebius AI Studio, a self-hosted "forge" server for
fine-tunes, and any number of named local/LAN model servers** (Ollama,
llama-server, vLLM, …, configured from `~/.agentproto/llm-endpoints.json`) —
using provider-native model references. The proxy also handles
Anthropic↔OpenAI schema translation, per-provider tool caps, orphaned-tool-call
repair, and thinking-block stripping where needed.

- **Package:** `@agentproto/llm-endpoint`
- **Entry:** `src/cli.ts` → `start()` in `src/index.ts`
- **Default port:** `18090` (override with `LLM_ENDPOINT_PORT`, or `PORT`)

---

## Quick start (client config)

Point any Anthropic- or OpenAI-compatible client at the proxy:

| Setting | Value |
| :--- | :--- |
| **Base URL** | `http://localhost:18090/v1` (local), or your own public origin + `/v1` |
| **API key** | The proxy injects the *real* upstream key server-side, so the client key is never your provider key. If the [inbound access gate](#securing-a-public-deployment) is enabled, send one of its tokens as the bearer; if it is not, any non-empty value passes. |

The client asks for a model by its **provider-transparent reference**
(`provider/model`, e.g. `moonshot/kimi-k2.7-code`, `openai/gpt-4.1`); the proxy
routes it to the right upstream endpoint.

---

## Model catalog

### Transparent routing (`provider/model`)

On the OpenAI surfaces (`/v1/chat/completions` and `/v1/responses`) the model
field is parsed as `provider/model`:

| Provider | Example reference | Upstream endpoint |
| :--- | :--- | :--- |
| Moonshot | `moonshot/kimi-k2.7-code` | `api.moonshot.ai/v1/chat/completions` |
| OpenRouter | `openrouter/anthropic/claude-3-5-sonnet-20241022` | `openrouter.ai/api/v1/chat/completions` |
| Requesty | `requesty/sference/thinkingcap-qwen3.6-27b` | `router.requesty.ai/v1/chat/completions` |
| ZAI | `zai/glm-5.2` | `open.bigmodel.cn/api/paas/v4/chat/completions` |
| Groq | `groq/llama-3.3-70b-versatile` | `api.groq.com/openai/v1/chat/completions` |
| xAI | `xai/grok-4.5` | `api.x.ai/v1/chat/completions` |
| OpenAI | `openai/gpt-4.1` | `api.openai.com/v1/chat/completions` |
| Forge (self-hosted) | `forge/my-lora-v3` | `$FORGE_BASE_URL/chat/completions` |
| Nebius AI Studio | `nebius/meta-llama/Llama-3.1-8B-Instruct` | `api.studio.nebius.com/v1/chat/completions` (or `$NEBIUS_BASE_URL`) |

You can also force the provider with `?p=<provider>` and send a bare model id.

### Adding an OpenAI-compatible upstream provider

`forge` and `nebius` are both **configurable providers**: any OpenAI-compatible
upstream wired up from exactly two env vars, `<PROVIDER>_BASE_URL` (scheme,
host, port, path prefix) and `<PROVIDER>_API_KEY` (sent as `Authorization:
Bearer <key>`) — no code change needed to point either one at a different
host. They differ in one way: whether the base URL has a working default.

| Provider | `..._BASE_URL` | Default when unset | `..._API_KEY` |
| :--- | :--- | :--- | :--- |
| `forge` (self-hosted) | `FORGE_BASE_URL` | *(none — provider only exists once set)* | `FORGE_API_KEY` — **optional**; omitted entirely, no `Authorization` header sent, for a server with no auth (private network) |
| `nebius` (Nebius AI Studio) | `NEBIUS_BASE_URL` | `https://api.studio.nebius.com/v1` | `NEBIUS_API_KEY` — **required**, like every other provider (401 when missing) |

Both `http://` and `https://` are supported, with any host/port/path prefix —
unlike every fixed-hostname provider above, these two read their wire format
from the env var rather than a hardcoded `https://` + well-known host. An
unset `FORGE_BASE_URL` (no default) or a malformed override on either
provider makes `forge/...`/`nebius/...` requests fail with a clear 4xx, never
a crash.

Both work on all three surfaces (`/v1/messages`, `/v1/chat/completions`,
`/v1/responses`) with the same Anthropic↔OpenAI translation, streaming, and
tool-cap handling as every other OpenAI-compatible provider. `GET /v1/models`
additionally proxies `GET ${FORGE_BASE_URL}/models` and merges the results
into the default pack's listing (ids prefixed `forge/`) — forge-only, since
its LoRA adapters are registered on the server itself rather than known ahead
of time; nebius's catalog is the well-known set of ids you already pass in.

```sh
# forge — self-hosted vLLM, no auth
curl http://localhost:18090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"forge/my-lora-v3","messages":[{"role":"user","content":"hi"}]}'

# nebius — hosted, requires NEBIUS_API_KEY
curl http://localhost:18090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"nebius/meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"hi"}]}'
```

### Named endpoints — N local/LAN model servers (`~/.agentproto/llm-endpoints.json`)

`forge` is one keyless self-hosted server. Real setups often have several —
Ollama, llama-server, vLLM — each on its own host/port, possibly on another
LAN machine. Named endpoints generalize `forge`'s mechanism to N of them,
configured from a JSON file instead of a pair of env vars per server:

```jsonc
// ~/.agentproto/llm-endpoints.json (path overridable via LLM_ENDPOINT_ENDPOINTS_FILE)
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
    { "id": "ollama", "kind": "openai", "baseUrl": "http://192.168.1.20:11434/v1" }
  ]
}
```

The field names deliberately mirror `openagentik/router`'s `providers[]`
schema (`kind`, `baseUrl`, `apiKeyEnv`, `defaultRequestFields`, `timeoutMs`) so
a config is portable between the two. Each entry becomes a routable provider
`<id>/<model>` — `bonsai/bonsai-27b`, `ollama/qwen2.5-coder` — going through
the exact same dispatch path as `forge`/`nebius` above: all three surfaces,
Anthropic↔OpenAI translation, streaming, tool-cap handling, and `GET
/v1/models` merging (an unreachable endpoint is skipped with a warning, never
a 500 for the whole listing). `forge` itself keeps working unchanged — it's
the implicit endpoint that `FORGE_BASE_URL`/`FORGE_API_KEY` configure; a file
entry may not reuse the id `"forge"`.

- **`apiKeyEnv`** names an env var (never the key itself). Absent, or the env
  var unset, means the endpoint is always keyless — no `Authorization` header
  sent, same as `forge` with no `FORGE_API_KEY`.
- **`defaultRequestFields.chat_template_kwargs`** is merged UNDER the client's
  own request value (a client-supplied key always wins) — the vLLM
  OpenAI-compatible extension `forge` already documents above. Needed in
  practice: Qwen3.6-based models (e.g. a Bonsai-served 27B) default to a
  "thinking" chat template and, on a tight `max_tokens` budget, can spend the
  whole budget reasoning and return empty content — `enable_thinking: false`
  avoids that unless the caller explicitly opts back in.
- When the upstream *still* returns only `reasoning_content` (no visible
  `content`) — a model-level defect, not a config one — set
  `LLM_ENDPOINT_PASSTHROUGH_THINKING=1` to surface it as an Anthropic
  `thinking` block instead of an empty message.
- **`GET /v1/endpoints`** (and `/endpoints`) reports live health per endpoint —
  forge (if configured) plus every named endpoint, never nebius (a hosted
  provider with a well-known catalog, not a local/LAN server): `{id, baseUrl
  (no credential), reachable, models, latencyMs}`. Gated by the same
  access-token check as `/v1/upstreams` (not the `/v1/models` public
  exemption).
- A `packs.local.json` route may target a named endpoint id as its
  `provider` — an id that resolves to neither a canonical upstream, `forge`,
  `nebius`, nor a configured endpoint is a clear load-time error instead of a
  confusing 400 the first time a client hits that code.

```sh
curl http://localhost:18090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"bonsai/bonsai-27b","messages":[{"role":"user","content":"hi"}]}'

curl http://localhost:18090/v1/endpoints
```

### Anthropic Messages surface (`/v1/messages`)

The default public pack lists provider-transparent model IDs (the same values
you would send to the upstream provider). Real Claude model IDs are preserved
only when they route to an actual Anthropic target.

If you need the `claude` CLI or another Anthropic-only client to accept
non-Anthropic backends, either flip on the **Anthropic-style format** (below —
works with any pack) or create a **local compatibility pack** (further below).
Both surface `equivalentClaudeName` aliases that are matched **only** when
enabled.

### `coding` pack (curated OpenRouter coding models)

The committed `coding` pack is a small, production-only portfolio of coding
models, all routed through OpenRouter's native Anthropic-compatible endpoint:

| Code (transparent id) | Tier → family |
| :--- | :--- |
| `openai/gpt-5.5` | extra-high → fable |
| `anthropic/claude-opus-4.8` | high → opus |
| `deepseek/deepseek-v4-pro` | high → opus |
| `anthropic/claude-sonnet-5` | medium → sonnet |
| `z-ai/glm-5.2` | medium → sonnet |
| `minimax/minimax-m3` | small → haiku |

Select it like any pack (`X-Proxy-Pack: coding`, `?pack=coding`, or
`/v1/coding/messages`). The list is curated by hand against OpenRouter's live
Models API/rankings (`GET https://openrouter.ai/api/v1/models?supported_parameters=tools`);
availability and pricing drift, so re-check before relying on a route. Anything
outside the pack is still reachable via transparent `openrouter/vendor/model`
routing.

### Anthropic-style format (`?format=anthropic`)

Any pack can be relabeled on the fly so an Anthropic-only client gets
Claude-shaped model ids — **without impersonating a real Anthropic model**.
Send `X-Proxy-Format: anthropic` (or `?format=anthropic`) and each route's id
becomes an opaque, deterministic `claude-<family>-<sha>` value, where the family
comes from the route's tier (`extra-high→fable`, `high→opus`, `medium→sonnet`,
`small→haiku`) and the suffix is a sha of the upstream id. The real route stays
as the model's `display_name`.

Discover the current ids, then use one as the model:

```bash
# Discover (Anthropic-formatted model list)
curl -s -H 'anthropic-version: 2023-06-01' -H 'X-Proxy-Format: anthropic' \
  http://localhost:18090/v1/coding/models
# → { "data": [ { "id": "claude-opus-5246108", "display_name": "anthropic/claude-opus-4.8", … }, … ] }

# Use it (Messages path resolves the id back to the real OpenRouter route)
env -u ANTHROPIC_API_KEY \
  ANTHROPIC_BASE_URL="http://localhost:18090" \
  ANTHROPIC_CUSTOM_HEADERS="X-Proxy-Pack: coding, X-Proxy-Format: anthropic" \
  ANTHROPIC_AUTH_TOKEN="unused-the-proxy-holds-the-real-key" \
  ANTHROPIC_MODEL="claude-opus-5246108" \
  claude -p "…"
```

The ids are stable across restarts (they are derived from the upstream id, not
random), so a discovered id keeps working until the underlying route changes.

---

## Local compatibility packs

Create a `packs.local.json` file (gitignored) in the workspace root, the package
root, or next to `src/index.ts`:

```json
{
  "packs": {
    "local-claude": {
      "id": "local-claude",
      "label": "Local Claude compat",
      "description": "Claude-shaped aliases for my preferred backends",
      "models": {
        "my-opus": {
          "provider": "moonshot",
          "model": "kimi-k2.7-code",
          "equivalentClaudeName": "claude-opus-4-8"
        }
      }
    }
  }
}
```

Then select the pack via header (`X-Proxy-Pack: local-claude`), query param
(`?pack=local-claude`), or URL path (`/v1/local-claude/messages`). The alias
`claude-opus-4-8` will route to `moonshot/kimi-k2.7-code` **only** on the
Messages path and **only** when `local-claude` is active.

### Driving the `claude` CLI through a local pack

Use the **header**, not the URL path. The claude binary appends `/v1/messages`
to `ANTHROPIC_BASE_URL` itself, so a base of `…/v1/local-claude` becomes
`/v1/local-claude/v1/messages`, which matches no pack route — the request
silently falls back to the default pack and 400s with "Unable to resolve model".
Point the base at the proxy root and select the pack by header:

```bash
env -u ANTHROPIC_API_KEY \
  ANTHROPIC_BASE_URL="http://localhost:18090" \
  ANTHROPIC_CUSTOM_HEADERS="X-Proxy-Pack: local-claude" \
  ANTHROPIC_AUTH_TOKEN="unused-the-proxy-holds-the-real-key" \
  ANTHROPIC_MODEL="claude-opus-4-8" \
  ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5" \
  claude -p "…"
```

Pin `ANTHROPIC_SMALL_FAST_MODEL` too, or the harness's background calls request
a Claude tier the pack does not alias. Give reasoning models real `max_tokens`
headroom: a thinking model can spend a small budget entirely inside its thinking
block, and since those blocks are stripped (see below) the client then sees an
empty `content` with `stop_reason: max_tokens`.

---

## Per-request overrides (query string)

| Param | Effect |
| :--- | :--- |
| `?p=<provider>` | Force the provider (`moonshot`, `openrouter`, `zai`, `groq`, `xai`, `openai`) |
| `?m=<code>` | Force a pack code on the **Messages** path |
| `?format=anthropic` | Relabel the active pack to opaque `claude-<family>-<sha>` ids (also via `X-Proxy-Format: anthropic`) |
| `?tools=<names>` | Tool allow-list (e.g. `?tools=Bash,Read,Write`) — drop everything else |
| `?notools=1` | Strip **all** tools (+ `tool_choice`) → "lean" mode for strict-cap backends |

---

## OpenAI Responses API facade (Codex custom providers)

The proxy exposes a focused `POST /v1/responses` endpoint that implements the
OpenAI Responses API on top of the existing OpenAI-compatible chat/completions
providers. Codex custom providers can set `wire_api = "responses"` and point their
base URL at this proxy.

The facade is intentionally narrow: it supports the constructs that map cleanly to
a chat/completions request and rejects everything else up front. It routes through
the **transparent** `provider/model` surface, not through alias packs.

### Supported

- `model` — transparent `provider/model` reference (e.g. `openai/gpt-4.1`).
- `input` — a plain string or an array of `message` items (`input_text`) and
  `function_call_output` items.
- `instructions` — injected as a leading `system` message.
- `tools` — only `type: "function"` tools are accepted.
- `tool_choice` — `"auto"`, `"none"`, `"required"`, or `{ type: "function", name }`.
- `stream` — when `true`, upstream SSE is re-emitted as Responses API SSE events
  (`response.created`, `response.output_text.delta`, `response.completed`, …).
- Standard sampling params: `max_output_tokens` / `max_tokens`, `temperature`,
  `top_p`, `parallel_tool_calls`.
- `reasoning.effort` — mapped to the upstream `reasoning_effort` parameter.

### Explicitly unsupported (returns 400)

- `previous_response_id` — the facade is stateless; each request is translated
  independently.
- `text.format` / structured output.
- Non-`function` tool types (e.g. `web_search`).
- Image, audio, or other non-text content items.

---

## Batches

`POST /v1/messages/batches` (and `/v1/{pack}/messages/batches`) exposes the
Anthropic Message Batches API on top of the proxy's own routing — a client
pointed at the proxy can use the Anthropic SDK's batches surface unchanged
(`client.messages.batches.create/retrieve/results/cancel/list/delete`) with
`params.model` being **any** model the active pack routes. Batch is a delivery
mode, not a model: each item's `params` is the same Messages body the sync
`/v1/messages` route understands, so per-item routing, tool-trimming, and
translation are all reused, not reimplemented.

| Route | Behaviour |
| :--- | :--- |
| `POST /v1/messages/batches` | `{ requests: [{ custom_id, params }] }`. Validated (unique `custom_id`, no `stream`/`speed`/`fallbacks`/forced `tool_choice`, resolvable `model`) — 400 lists every offending item. Returns a `message_batch` object. |
| `GET /v1/messages/batches/{id}` | Aggregate status across sub-batches: `processing_status`, `request_counts`, `results_url` (once ended). |
| `GET /v1/messages/batches/{id}/results` | 404 until ended, then JSONL — one `{ custom_id, result }` line per item, cached after the first fetch so a repeat GET doesn't re-hit the provider. |
| `POST /v1/messages/batches/{id}/cancel` | Fans out to every sub-batch; a provider that doesn't support cancel (OpenRouter) is recorded, not fatal. |
| `GET /v1/messages/batches` | List, newest first (`?limit=`). |
| `DELETE /v1/messages/batches/{id}` | Only once ended (else `409`); best-effort forwarded to Anthropic for native sub-batches. |

### Native vs emulated

A batch whose items resolve to several providers is split into per-provider
sub-batches and re-aggregated by `custom_id`:

- **`anthropic`** and **`openrouter`** run on that provider's own async Batch
  API — **50% of token price**, up to a 24h window.
- **Everything else** (`moonshot`, `requesty`, `zai`, `groq`, `xai`, `openai`)
  has no batch API of its own, so items run through a local-queue emulation:
  the proxy submits each item to its **own** `/v1/messages` over loopback, so
  tool caps, thinking-strip, and empty-turn retry all still apply. **Full
  price** — there is no provider-side discount to draw from.

### Credentials

Batches reuse the same per-provider credential resolution as `/v1/messages`.
One exception: if the resolved `anthropic` credential is a subscription OAuth
token (`sk-ant-oat…`) rather than an API key, batch creation fails closed with
a `401` — the Anthropic Batches API only accepts API keys, so the proxy never
attempts to send a subscription token to it.

### Config

| Env var | Effect |
| :--- | :--- |
| `LLM_ENDPOINT_STATE_DIR` | Where batch records + local-queue results are persisted. Default `~/.agentproto/llm-endpoint`. |
| `LLM_ENDPOINT_BATCH_CONCURRENCY` | Concurrent in-flight loopback requests per local-queue sub-batch. Default `4`. |

Batch records outlive the process — on restart, a native sub-batch simply
re-polls the provider by its stored id, and an unfinished local-queue
sub-batch resumes only the items still missing a result.

---

## Tool handling

### Automatic trimming

The `claude` CLI loads its full MCP config (`~/.claude` + `.mcp.json` + skills), which
often exceeds a provider's tool limit (e.g. **Groq: 128 max** →
`400 'tools': maximum number of items is 128`). The proxy truncates `payload.tools` to
the provider cap (`PROVIDER_MAX_TOOLS` in [`src/index.ts`](src/index.ts), currently
`groq: 128`) **before** reshaping tools for the provider. Providers without a cap
(moonshot, openrouter, zai, openai) are untouched. Use `?tools=` / `?notools=1` for finer control.

### Orphaned tool calls

When `tools` is truncated, conversation history can still contain `tool_use` blocks for
**undeclared** tools (e.g. the CLI's `Agent` sub-agent). Groq validates strictly and
rejects: `400 tool call validation failed: attempted to call tool 'X' which was not in
request.tools`. During Anthropic→OpenAI conversion the proxy converts those orphaned
`tool_use` (and their matching `tool_result`) into **plain text**
(`[Used tool X with args …]` / `[Tool result: …]`), preserving context without breaking
validation. Declared-tool `tool_use` blocks pass through normally as OpenAI `tool_calls`.

---

## Running it

No bespoke start script — it's a normal workspace package, driven by `pnpm` scripts:

```bash
# Dev: run the server with hot-reload (tsx watch)
pnpm --filter @agentproto/llm-endpoint serve

# Watch-rebuild the bundle (tsup --watch) — for consumers importing the package
pnpm --filter @agentproto/llm-endpoint dev

# Build the bundle (dist/index.mjs + dist/cli.mjs + types)
pnpm --filter @agentproto/llm-endpoint build

# Run the built server
pnpm --filter @agentproto/llm-endpoint start

# Type-check
pnpm --filter @agentproto/llm-endpoint check-types
```

Override the port with `LLM_ENDPOINT_PORT=18099 pnpm --filter @agentproto/llm-endpoint serve`.

The package also exports `start()` and the underlying `server` for embedding:

```ts
import { start } from '@agentproto/llm-endpoint'
start(18090)
```

### Live end-to-end suite

`src/__tests__/e2e.live.ts` hits a **running** proxy (`localhost:18090`) with **real**
provider keys, so it is deliberately kept off the vitest glob (it is not a unit test).
Start the server first, then:

```bash
pnpm --filter @agentproto/llm-endpoint test:e2e
```

---

## Securing a public deployment

The proxy holds **real upstream provider keys**, so any host that can reach it can
spend your credits. Never expose it publicly without an inbound gate.

### Inbound access gate

Set `LLM_ENDPOINT_ACCESS_TOKENS` to a comma-separated allow-list of secret tokens.
When it is set, every request must present a listed token as either
`Authorization: Bearer <token>` **or** an `X-Proxy-Access: <token>` header — anything
else gets `401`. When the variable is **unset the gate is open** (no inbound auth):
fine for `localhost`, unsafe for a public origin.

> **`x-api-key` is not accepted.** Some Anthropic-compatible clients default to
> sending the credential as `x-api-key`; the gate only reads `Authorization:
> Bearer` and `X-Proxy-Access`. Set the client's auth scheme to **Bearer**.

```bash
LLM_ENDPOINT_ACCESS_TOKENS="$(openssl rand -hex 24)" \
  pnpm --filter @agentproto/llm-endpoint start
```

### Public model discovery (optional)

Clients that auto-discover models (e.g. Claude Desktop's launch-time model
fetch) probe `GET /v1/models` **without** a credential, so the access gate
`401`s them and the connection test fails. Set `LLM_ENDPOINT_PUBLIC_MODELS=1` to
exempt **only** the default model-list path (`/v1/models`, `/models`) from every
gate. Pack-scoped lists (`/v1/<pack>/models`) and all other paths stay gated, so
no pack config leaks. Unset (default) keeps discovery gated too.

### Edge / WAF token layer

`LLM_ENDPOINT_EDGE_TOKENS` is a second, independent allow-list checked via the
`X-Edge-Auth: <token>` header. It's meant to be enforced **at the edge** (a
Cloudflare WAF rule in front of the tunnel) so unauthenticated traffic never
reaches the origin — and it's also re-checked in-process as a fallback. Each
layer is independent; unset means off. Reusing the same secret as
`LLM_ENDPOINT_ACCESS_TOKENS` (via `Authorization: Bearer`) is fine too — one
secret, both the edge rule and the app gate.

### Generating the Cloudflare rule (`print-waf-rule`)

`llm-endpoint print-waf-rule` prints a Cloudflare custom-rule (wirefilter)
expression that **blocks** any request lacking a valid token, so the secret
lives in one place and the edge rule is generated, not hand-typed. It reads
`LLM_ENDPOINT_EDGE_TOKENS` (→ `X-Edge-Auth`) when set, else
`LLM_ENDPOINT_ACCESS_TOKENS` (→ `Authorization: Bearer`); `--host <h>` (or
`LLM_ENDPOINT_PUBLIC_HOST`) scopes the rule to one hostname. `OPTIONS` preflight
is always allowed.

```bash
LLM_ENDPOINT_ACCESS_TOKENS="$SECRET" llm-endpoint print-waf-rule --host llm.example.com
# → (http.host eq "llm.example.com" and http.request.method ne "OPTIONS"
#     and not any(http.request.headers["authorization"][*] eq "Bearer $SECRET"))
```

Paste the output into a Cloudflare **Block** custom rule. If you also enabled
`LLM_ENDPOINT_PUBLIC_MODELS`, add a carve-out so discovery bypasses the edge as
well: `… and http.request.uri.path ne "/v1/models" and http.request.uri.path ne
"/models" and …`.

### Exposing the port

Any HTTP tunnel or reverse proxy that forwards to `http://localhost:18090` works
(Cloudflare Tunnel, ngrok, a VPS + nginx, …). Whichever you pick: keep the access
gate enabled, and consider an **edge control** as defense-in-depth (e.g. a Cloudflare
WAF rule or Cloudflare Access policy keyed on the same token) so unauthenticated
traffic is rejected before it ever reaches the origin.
