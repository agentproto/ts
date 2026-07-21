# @agentproto/llm-endpoint

A lightweight **multi-surface LLM proxy gateway**. It exposes three API
surfaces from a single port:

- `POST /v1/messages` — Anthropic Messages compatibility. Claude-shaped model
  aliases are supported **only** through an explicit local compatibility pack.
- `POST /v1/chat/completions` — OpenAI Chat Completions compatibility with
  transparent `provider/model` routing.
- `POST /v1/responses` — OpenAI Responses API facade for Codex custom providers.

Requests are fanned out to upstream providers — **Moonshot, OpenRouter, ZAI/Zhipu,
Groq, xAI, and direct OpenAI** — using provider-native model references. The
proxy also handles Anthropic↔OpenAI schema translation, per-provider tool caps,
orphaned-tool-call repair, and thinking-block stripping where needed.

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

You can also force the provider with `?p=<provider>` and send a bare model id.

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
