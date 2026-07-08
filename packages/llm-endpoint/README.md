# @agentproto/llm-endpoint

A lightweight **Anthropic-Messages-compatible proxy gateway**. It presents a single
Claude (`/v1/messages`, `/v1/models`) API surface and fans requests out to multiple
upstream providers — **Moonshot, OpenRouter, ZAI/Zhipu, Groq** — behind stable alias
codenames. Along the way it handles Anthropic↔OpenAI schema translation, per-provider
tool caps, orphaned-tool-call repair, and thinking-block stripping, so a client that
only speaks the Anthropic API (e.g. the `claude` CLI) can transparently drive a
non-Anthropic model.

- **Package:** `@agentproto/llm-endpoint`
- **Entry:** `src/cli.ts` → `start()` in `src/index.ts`
- **Default port:** `18090` (override with `LLM_ENDPOINT_PORT`, or `PORT`)

---

## Quick start (client config)

Point any Anthropic-API client at the proxy:

| Setting | Value |
| :--- | :--- |
| **Base URL** | `https://llm-endpoint.clipgen.co/v1` (public) or `http://localhost:18090/v1` (local) |
| **API key** | `AAAA` — a passthrough sentinel; the proxy injects the *real* upstream key server-side |

The client asks for a model by its **alias** (a Claude family name the client's TUI
accepts, or a codename directly); the proxy resolves it to a real upstream model.

---

## Model catalog

The client sends a Claude-family **alias** (or a codename via `?m=`); the proxy maps it
to a real provider + model. Alias names use the *current* Claude family (Opus 4.8 /
Fable 5 / Sonnet 5 / Haiku 4.5) so the `claude` CLI accepts them at startup — the proxy
accepts a `claude-<family>-N` range, not a fixed list.

### Moonshot — direct, native Anthropic endpoint (no translation)

| Codename | Real model | Claude alias | Notes |
| :--- | :--- | :--- | :--- |
| **`jupiter-7`** | `kimi-k2.7-code` | `claude-opus-4-8` | *Thinking* mode on (4000 tokens) |
| `mars-6` | `kimi-k2.6` | `claude-3-opus` | Standard multitask (legacy) |

### OpenRouter — top popular models

| Codename | Real model | Claude alias | Notes |
| :--- | :--- | :--- | :--- |
| **`saturn-5`** | `deepseek/deepseek-v4-pro` | `claude-sonnet-5` | DeepSeek V4 Pro |
| **`halley-1`** | `deepseek/deepseek-v4-flash` | `claude-fable-4` | DeepSeek V4 Flash (fast) |
| **`mercury-9`** | `z-ai/glm-5.2` | `claude-3-haiku-20240307` | GLM 5.2 (1M ctx, coding) |
| **`orion-2`** | `xiaomi/mimo-v2.5` | `claude-opus-4-6` | Xiaomi MiMo-V2.5 |
| **`pegasus-3`** | `minimax/minimax-m3` | `claude-opus-4-9` | MiniMax M3 |
| **`lyra-4`** | `tencent/hy3-preview` | `claude-opus-4-7` | Tencent Hy3 preview |
| **`vega-5`** | `stepfun/step-3.7-flash` | `claude-sonnet-4-5` | Step 3.7 Flash (fast) |
| `neptune-4` | `anthropic/claude-sonnet-4.6` | `claude-sonnet-4-6` | Claude Sonnet 4.6 via OpenRouter |
| `uranus-8` | `google/gemini-3.1-pro-preview` | `claude-fable-5` | Gemini 3.1 Pro |

### ZAI / Zhipu — direct (BigModel)

| Codename | Real model | Claude alias | Notes |
| :--- | :--- | :--- | :--- |
| **`venus-3`** | `glm-5.2` | `claude-3-5-fable` | GLM 5.2 direct — reasoning isolated in `reasoning_content` (not surfaced) |

### Groq — ultra-fast inference (128-tool cap)

| Codename | Real model | Claude alias | Notes |
| :--- | :--- | :--- | :--- |
| `pluto-2` | `qwen/qwen3.6-27b` | `claude-haiku-4-5` | `reasoning_effort:"none"` (drops `<think>`) |
| **`atlas-6`** | `llama-3.3-70b-versatile` | `claude-3-5-sonnet-20241022` | Non-reasoning |
| **`titan-7`** | `openai/gpt-oss-120b` | `claude-sonnet-4-7` | `include_reasoning:false` |

Model → provider mapping and reasoning params live in `SECRET_CODE_MAPPING` in
[`src/index.ts`](src/index.ts). Upstream API keys are resolved from the monorepo env
files (`MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, `ZHIPUAI_API_KEY`/`ZAI_API_KEY`,
`GROQ_API_KEY`).

---

## Per-request overrides (query string)

Override the provider/model of a single request without touching the JSON body:

| Param | Effect |
| :--- | :--- |
| `?m=<codename>` | Force an explicit codename (e.g. `?m=pluto-2`) — bypasses alias resolution |
| `?p=<provider>` | Force the provider (`moonshot`, `openrouter`, `zai`, `groq`) |
| `?tools=<names>` | Tool allow-list (e.g. `?tools=Bash,Read,Write`) — drop everything else |
| `?notools=1` | Strip **all** tools (+ `tool_choice`) → "lean" mode for strict-cap backends |

---

## Tool handling

### Automatic trimming

The `claude` CLI loads its full MCP config (`~/.claude` + `.mcp.json` + skills), which
often exceeds a provider's tool limit (e.g. **Groq: 128 max** →
`400 'tools': maximum number of items is 128`). The proxy truncates `payload.tools` to
the provider cap (`PROVIDER_MAX_TOOLS` in [`src/index.ts`](src/index.ts), currently
`groq: 128`) **before** reshaping tools for the provider. Providers without a cap
(moonshot, openrouter, zai) are untouched. Use `?tools=` / `?notools=1` for finer control.

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
