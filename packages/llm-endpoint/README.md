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
| **Base URL** | `https://llm-endpoint.clipgen.co/v1` (public) or `http://localhost:18090/v1` (local) |
| **API key** | `AAAA` — a passthrough sentinel; the proxy injects the *real* upstream key server-side |

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
non-Anthropic backends, create a **local compatibility pack** (see below). Local
packs can define `equivalentClaudeName` aliases; those aliases are matched **only**
when that pack is explicitly selected.

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

---

## Per-request overrides (query string)

| Param | Effect |
| :--- | :--- |
| `?p=<provider>` | Force the provider (`moonshot`, `openrouter`, `zai`, `groq`, `xai`, `openai`) |
| `?m=<code>` | Force a pack code on the **Messages** path |
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

## Public exposure (Cloudflare named tunnel)

The proxy is exposed publicly at `llm-endpoint.clipgen.co` via a **dedicated** Cloudflare
named tunnel called `llm-endpoint` (tunnel id `6614ae24-…`), configured in
`~/.cloudflared/llm-endpoint.yml`:

```yaml
tunnel: 6614ae24-3acc-4b6a-8c0f-ac81713f3186
credentials-file: /Users/jeremy/.cloudflared/6614ae24-...json

ingress:
  - hostname: llm-endpoint.clipgen.co
    service: http://localhost:18090
  - service: http_status:404
```

Run the tunnel:

```bash
cloudflared tunnel --config /Users/jeremy/.cloudflared/llm-endpoint.yml run llm-endpoint
```

> **History note:** this hostname previously rode a shared tunnel named `postiz` (its
> first tenant was a local Postiz instance). It has been moved onto its own dedicated
> `llm-endpoint` tunnel so the naming reflects the service — `postiz` was never related
> to this proxy.
