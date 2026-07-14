---
name: agentproto-llm-endpoint
description:
  Use the local LLM endpoint proxy (localhost:18090) or the public
  https://llm-endpoint.clipgen.co/ to route Claude Code / Claude SDK through
  custom providers (OpenRouter, Moonshot, Groq, ZAI) via Anthropic-compatible
  gateway. Covers adapter-specific behaviors, auth patterns, proxy codenames,
  and common failure modes.
metadata:
  tags: agentproto, llm-endpoint, proxy, gateway, openrouter, moonshot, groq, zai, xai, grok
---

## When to use

- "Route Claude through OpenRouter / Moonshot / Groq / ZAI / xAI"
- "Use the local LLM proxy" or "use llm-endpoint.clipgen.co"
- "Why is my model codename rejected?"
- "Claude Code vs Claude SDK with custom endpoints"
- Spawn failures: "Invalid API key", "model does not exist", empty turns

## The proxy

The LLM endpoint proxy lives in `projects/agentproto/ts/packages/llm-endpoint`.
It exposes an Anthropic-compatible `/v1/messages` endpoint and maps "secret
codenames" to real provider models.

### Codename → provider mapping

| Code       | Provider   | Real model                              | Claude equivalent |
| ---------- | ---------- | --------------------------------------- | ----------------- |
| `jupiter-7`| Moonshot   | `kimi-k2.7-code`                        | `claude-opus-4-8` |
| `mars-6`   | Moonshot   | `kimi-k2.6`                             | `claude-3-opus`   |
| `saturn-5` | OpenRouter | `deepseek/deepseek-v4-pro`              | `claude-sonnet-5` |
| `neptune-4`| OpenRouter | `anthropic/claude-sonnet-4.6`           | `claude-sonnet-4-6` |
| `uranus-8` | OpenRouter | `google/gemini-3.1-pro-preview`         | `claude-fable-5`  |
| `mercury-9`| OpenRouter | `z-ai/glm-5.2`                          | `claude-3-haiku`  |
| `halley-1` | OpenRouter | `deepseek/deepseek-v4-flash`            | `claude-fable-4`  |
| `orion-2`  | OpenRouter | `xiaomi/mimo-v2.5`                      | `claude-opus-4-6` |
| `pegasus-3`| OpenRouter | `minimax/minimax-m3`                    | `claude-opus-4-9` |
| `lyra-4`   | OpenRouter | `tencent/hy3-preview`                   | `claude-opus-4-7` |
| `vega-5`   | OpenRouter | `stepfun/step-3.7-flash`                | `claude-sonnet-4-5` |
| `venus-3`  | ZAI        | `glm-5.2`                               | `claude-3-5-fable`|
| `pluto-2`  | Groq       | `qwen/qwen3.6-27b`                      | `claude-haiku-4-5`|
| `atlas-6`  | Groq       | `llama-3.3-70b-versatile`               | `claude-3-5-sonnet` |
| `titan-7`  | Groq       | `openai/gpt-oss-120b`                   | `claude-sonnet-4-7` |
| `nova-1`   | xAI        | `grok-4.5`                              | `claude-opus-4-8` |
| `pulsar-2` | xAI        | `grok-3.5`                              | `claude-sonnet-5` |

### Running the proxy locally

```bash
# From repo root
pnpm --filter=@agentproto/llm-endpoint start
# → listens on http://localhost:18090/v1
```

Env vars the proxy reads:
- `MOONSHOT_API_KEY` — Moonshot native `/anthropic` endpoint
- `OPENROUTER_API_KEY` — OpenRouter (OpenAI-compatible adapter)
- `ZHIPUAI_API_KEY` or `ZAI_API_KEY` — ZAI (OpenAI-compatible adapter)
- `GROQ_API_KEY` — Groq (OpenAI-compatible adapter, 128-tool max)

The proxy adapts Anthropic Messages format to OpenAI Chat Completions for
OpenRouter/ZAI/Groq. Moonshot exposes a native `/anthropic` endpoint and needs
no adaptation.

### Client config

```
Base URL:   http://localhost:18090/v1   (local)
            https://llm-endpoint.clipgen.co/v1   (public)
API key:    AAAA   (passthrough sentinel — real upstream key injected server-side)
```

The proxy accepts `?m=<code>` query param override and `?p=<provider>` override.

## Adapter-specific behaviors

### Claude SDK (`claude-sdk` adapter) — RECOMMENDED for proxy

- **Model validation**: NONE. Passes any model string directly to the SDK.
- **How model is sent**: `--model <value>` CLI arg → SDK `options.model`.
- **Base URL**: Set via `options.base_url` → `ANTHROPIC_BASE_URL` env.
- **Auth**: `ANTHROPIC_API_KEY` env (set via `--auth api-key`).

**Working spawn via MCP:**

```json
{
  "adapter": "claude-sdk",
  "auth": { "mode": "api-key" },
  "model": "neptune-4",
  "options": { "base_url": "http://localhost:18090/v1" },
  "prompt": "..."
}
```

**Working spawn via CLI:**

```bash
# DOES NOT WORK — CLI has no --base-url flag
agentproto sessions start claude-sdk --model neptune-4 --auth api-key

# WORKAROUND: set env vars before the CLI command
ANTHROPIC_BASE_URL=http://localhost:18090/v1 \
ANTHROPIC_API_KEY=AAAA \
agentproto sessions start claude-sdk --model neptune-4 --prompt "..."
```

### Claude Code (`claude-code` adapter) — LIMITED with proxy

- **Model validation**: STRICT. The `claude` binary validates `ANTHROPIC_MODEL`
  against Anthropic's real model list. Proxy codenames (`neptune-4`, etc.) are
  **rejected** before any network request.
- **How model is sent**: `ANTHROPIC_MODEL` env var (set via `options.model` →
  adapter manifest `env: { ANTHROPIC_MODEL: "{value}" }`). The ACP wrapper
  applies it via `session/set_config_option(configId: "model")` with
  best-effort fallback to default on rejection.
- **Base URL**: Set via `options.base_url` → `ANTHROPIC_BASE_URL` env.
- **Auth**: `ANTHROPIC_API_KEY` env (api-key mode) or
  `CLAUDE_CODE_OAUTH_TOKEN` (subscription mode).

**Result**: `claude-code` with proxy codenames fails with:
> "There's an issue with the selected model (neptune-4). It may not exist or
> you may not have access to it."

**Workaround**: Use `claude-sdk` instead for proxy access. If you must use
`claude-code`, you are limited to the proxy's regex fallback mappings:

| Model you send | Proxy routes to                        |
| -------------- | -------------------------------------- |
| `claude-sonnet-5` | `openrouter:deepseek/deepseek-v4-pro` |
| `claude-opus-4-8` | `moonshot:kimi-k2.7-code`             |
| `claude-fable-5`  | `moonshot:kimi-k2.7-code`             |
| `claude-haiku-4-5`| `groq:llama-3.3-70b`                  |

These are NOT the same as the codename mappings — you lose fine-grained
provider/model selection.

### Why Claude Desktop works with codenames

Claude Desktop (the app) uses the **Claude SDK directly** (not the `claude`
binary), and the SDK does not validate model names before sending. When you
configure a custom endpoint in Claude Desktop settings, the SDK sends the raw
model string to your proxy, which resolves the codename.

Claude Code (the CLI/`claude-code` adapter) uses the `claude` binary which has
strict model validation — this is why the same codename fails there.

## Auth patterns

### Direct Anthropic API (subscription or api-key)

```json
{
  "adapter": "claude-code",
  "auth": { "mode": "subscription" },
  "prompt": "..."
}
```

Subscription mode uses `CLAUDE_CODE_OAUTH_TOKEN` (bearer token from
`claude auth login`). API-key mode uses `ANTHROPIC_API_KEY`.

### Gateway / proxy (Moonshot, OpenRouter, etc.)

```json
{
  "adapter": "claude-sdk",
  "auth": { "mode": "api-key" },
  "model": "neptune-4",
  "options": {
    "base_url": "http://localhost:18090/v1",
    "auth_token": "AAAA"
  },
  "prompt": "..."
}
```

The `auth_token` option sets `ANTHROPIC_AUTH_TOKEN` (Bearer auth). The proxy
ignores this (uses its own upstream keys), but some gateways require it.

### Per-provider API keys

Stored in `~/.agentproto/providers.json` (mode 0600):

```json
{
  "openrouter": { "apiKey": "sk-or-v1-...", "updatedAt": "..." },
  "moonshot": { "apiKey": "sk-...", "updatedAt": "..." },
  "anthropic": { "apiKey": "sk-ant-api03-...", "updatedAt": "..." }
}
```

Set via: `agentproto auth provider set <provider>` or edit the file directly.

## Common failure modes

### "Invalid API key" / "Invalid bearer token"

- Check `~/.agentproto/providers.json` has the right key for the provider.
- For gateway modes, ensure `auth_token` is set (not just `ANTHROPIC_API_KEY`).
- The `claude-code` adapter scrubs `ANTHROPIC_API_KEY` when `base_url` is set
  (to prevent leaking your real Anthropic key to a third-party gateway).

### "Model does not exist" / "empty turn"

- `claude-code` adapter: you're using a proxy codename. Use `claude-sdk` instead.
- `claude-sdk` adapter: check `ANTHROPIC_BASE_URL` is actually set (CLI doesn't
  support `--base-url`; use env var or MCP `options.base_url`).
- Proxy not running: `curl http://localhost:18090/v1/models` should return the
  codename list.

### "empty turn — no assistant output, no tool call"

- The proxy received the request but the upstream provider returned nothing.
- Check proxy logs: `tail -f /tmp/llm-endpoint.log`
- Common cause: model name mismatch (proxy regex fallback routed to wrong
  provider).

### Double `/v1/v1/` in proxy paths

The proxy base URL should end with `/v1` (e.g., `http://localhost:18090/v1`).
The claude binary appends `/v1/messages`, resulting in `/v1/v1/messages`. The
proxy handles this, but it's noisy in logs.

### Daemon caches old adapter code

The daemon (Node.js) caches `require()`/`import()` results. After editing an
adapter manifest, restart the daemon:

```bash
pkill -f "agentproto serve"
~/.agentproto/start-daemon-local.sh --cli workspace
```

## Quick reference: spawn patterns

| Goal                              | Adapter       | Model        | Base URL                        | Auth     |
| --------------------------------- | ------------- | ------------ | ------------------------------- | -------- |
| Direct Anthropic (subscription)   | `claude-code` | (default)    | (none)                          | `subscription` |
| Direct Anthropic (API key)        | `claude-code` | (default)    | (none)                          | `api-key` |
| OpenRouter Claude Sonnet 4.6      | `claude-sdk`  | `neptune-4`  | `http://localhost:18090/v1`     | `api-key` |
| Moonshot Kimi K2.7                | `claude-sdk`  | `jupiter-7`  | `http://localhost:18090/v1`     | `api-key` |
| Groq Llama 3.3 70B                | `claude-sdk`  | `atlas-6`    | `http://localhost:18090/v1`     | `api-key` |
| Claude Code + proxy (limited)     | `claude-code` | `claude-sonnet-5` | `http://localhost:18090/v1` | `api-key` |

## See also

- `agentproto` skill — general daemon/CLI/MCP usage
- `adapter-setup-kit` skill — tunnel creation, adapter catalog
- `projects/agentproto/ts/packages/llm-endpoint` — proxy source
- `projects/agentproto/ts/adapters/claude-sdk/src/index.ts` — SDK adapter manifest
- `projects/agentproto/ts/adapters/claude-code/src/index.ts` — Code adapter manifest
