# `@agentproto/provider-presets`

Concrete provider/backend **preset registry** — the shared, adapter-agnostic
facts about a backend an Anthropic/OpenAI-compatible client can front: base URL,
the conventional env var holding its API key, the core env vars to scrub, and an
optional default model. **Pure TS data; projection stays in the consumer.**

## Why

`@agentproto/adapter-claude-code` and `@agentproto/adapter-claude-sdk` both front
Anthropic-compatible gateways (Moonshot, OpenRouter, …). The `claude` binary and
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
| `AnthropicGatewayPresetId` | `"moonshot" \| "openrouter"` |
| `ProviderPreset` | the data shape |

## Stage

- **Stage 1 (this package):** the registry data; adapters consume it. No
  user-facing surface yet.
- **Stage 2 (planned):** `agentproto presets list` CLI + daemon endpoint,
  composing `@agentproto/provider-kit`'s lister/wizard over this data.
- **Stage 3 (planned):** an AIP-45 `presets` manifest field so external adapters
  declare their own; resolution semantics.

## Adding a gateway

Add an entry to `ANTHROPIC_GATEWAY_PRESETS` in `src/anthropic-gateways.ts`. The
`satisfies Record<string, ProviderPreset>` guard checks the shape; the test suite
checks `id` matches the key, the URL/keyEnv shapes, and that the ambient
`ANTHROPIC_API_KEY` is scrubbed. Then project it into each adapter's mode table.
