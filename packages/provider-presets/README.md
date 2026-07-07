# `@agentproto/provider-presets`

Concrete provider/backend **preset registry** — the shared, adapter-agnostic
facts about a backend an Anthropic/OpenAI-compatible client can front: base URL,
the conventional env var holding its API key, the core env vars to scrub, and an
optional default model. **Pure TS data; projection stays in the consumer.**

## Why

`@agentproto/adapter-claude-code` and `@agentproto/adapter-claude-sdk` both front
Anthropic-compatible gateways (Moonshot, OpenRouter, DeepSeek, …). The `claude` binary and
the Claude Agent SDK both honor `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, so
the *facts* about a gateway — its URL, its key env, its default model — are
identical across both. Those facts used to be inlined (and copy-pasted) in each
adapter's mode table, drifting independently. This package is the single source
of truth for them.

## Layering

The registry is **data only**. It does not know about `claude-code` vs
`claude-sdk`. How a given adapter projects a preset into its own manifest
(modes, options, `env_unset`, `bin_args_append`) stays in the adapter.

```
@agentproto/provider-presets        ← concrete preset DATA (this package)
   ↑ consumed by
@agentproto/adapter-claude-code     ← projects preset → AgentCliMode (+ cloud-toggle scrub)
@agentproto/adapter-claude-sdk      ← projects preset → AgentCliMode (+ CLAUDE_SDK_* env, --thinking)
   ↑ composed with
@agentproto/provider-kit            ← catalog MECHANICS (lister, wizard, MCP tools) — skeleton only
```

This keeps `@agentproto/provider-kit` (the catalog mechanics) and the generic
`@agentproto/driver-agent-cli` both free of concrete provider URLs — data flows
down, projection stays in the consumer.

## Surface

| Export | Purpose |
|---|---|
| `ANTHROPIC_GATEWAY_PRESETS` | `Record<id, ProviderPreset>` — the registry |
| `anthropicGatewayPresetList` | flat `ProviderPreset[]` for catalog UIs |
| `getAnthropicGatewayPreset(id)` | lookup; throws on unknown id (loud at load, not a silent no-baseUrl mode) |
| `AnthropicGatewayPresetId` | `"moonshot" \| "openrouter" \| "deepseek"` |
| `ProviderPreset` | the data shape |

## Stage

- **Stage 1 (this package):** the registry data; `claude-code` / `claude-sdk`
  consume it. ✅
- **Stage 2:** `agentproto presets list` CLI + `list_provider_presets` MCP tool +
  daemon `GET /presets`, with `ready`/`available` status from key presence. ✅
- **Stage 3:** an AIP-45 `presets` manifest field so external adapters declare
  their own gateway presets, merged into the listing at runtime. ✅

## Built-in vs adapter-declared presets

Built-in presets (this registry) are for **public, fixed-endpoint** gateways —
Moonshot, OpenRouter, DeepSeek all expose one canonical Anthropic-compatible URL.
That fixed `baseUrl` is exactly what makes them safe to ship as a preset: it's
the source of truth, no operator input needed.

A **self-hosted** gateway — e.g. a LiteLLM proxy at `<your-host>/anthropic`
(default `http://localhost:4000`) — has no canonical URL, so it does *not* belong
in this registry (a hardcoded `baseUrl` would silently hit localhost for anyone
not running it there). It's the canonical use case for the **Stage 3
adapter-declared `presets`** field: an adapter author (or operator) declares
their own preset with their real proxy URL.

```ts
// In an adapter's AgentCliDefinition — a self-hosted LiteLLM preset
import type { AgentCliDefinition } from "@agentproto/driver-agent-cli"

export const definition: AgentCliDefinition = {
  // …adapter fields…
  presets: [
    {
      id: "litellm",
      label: "LiteLLM proxy (self-hosted)",
      description:
        "A self-hosted LiteLLM proxy speaking the Anthropic Messages API. " +
        "Set baseUrl to <your-proxy>/anthropic.",
      schemaFlavor: "anthropic",
      baseUrl: "http://localhost:4000/anthropic", // ← override per deployment
      keyEnv: "LITELLM_API_KEY",
      scrubEnv: ["ANTHROPIC_API_KEY"],
      homepage: "https://docs.litellm.ai",
    },
  ],
}
```

Declared presets are merged into `agentproto presets list` alongside the
built-ins, keyed by `id` (adapter-declared entries do not shadow built-ins).

## Adding a gateway

Add an entry to `ANTHROPIC_GATEWAY_PRESETS` in `src/anthropic-gateways.ts`. The
`satisfies Record<string, ProviderPreset>` guard checks the shape; the test suite
checks `id` matches the key, the URL/keyEnv shapes, and that the ambient
`ANTHROPIC_API_KEY` is scrubbed. Then project it into each adapter's mode table.

A gateway belongs here only if it has a **fixed public endpoint**. If the base
URL is operator-defined (self-hosted proxy, on-prem gateway), declare it as an
adapter preset instead — see above.
