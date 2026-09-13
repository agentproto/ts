# @agentproto/adapter-claude-sdk

First-party agentproto adapter that runs **Claude Code's agent harness as a
library** — the Claude Agent SDK's headless `query()` async generator — behind
an AIP-44 ACP server. The daemon spawns it like any other agent-CLI arm; a user
can launch it standalone via `agentproto-claude-sdk acp`.

I/O stays **100% Anthropic-native**: the SDK's message stream is relayed to ACP
`session/update`s with no translation of the model I/O.

## Why wrap the SDK directly?

The `@agentproto/adapter-claude-code` adapter wraps the third-party
`@agentclientprotocol/claude-agent-acp` bridge. Driving the SDK directly instead
buys us:

- **Clean model pinning** — `options.model`, no spawn-arg rejection (issue #186).
- **Native usage telemetry** — a `usage_update` per turn (tokens + cost).
- **Custom base URL** — `base_url` → `ANTHROPIC_BASE_URL`, so the same
  Anthropic-native harness can front real Anthropic, Bedrock/Vertex/Azure, or an
  Anthropic-compatible gateway (LiteLLM / claude-code-router). Gateway-side
  translation is out of scope.

## Usage

```bash
# Spawned by the daemon as the `claude-sdk` arm, or standalone:
agentproto-claude-sdk acp [--model claude-opus-4-8] \
  [--base-url https://gateway.example/v1] [--auth-token <token>] [--thinking]
```

Auth is read from the spawn env: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`,
or `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`.

## Options (AIP-45 manifest)

| id           | type    | applied as                                              |
| ------------ | ------- | ------------------------------------------------------- |
| `model`      | string  | `--model <id>` → SDK `options.model`                    |
| `base_url`   | string  | `ANTHROPIC_BASE_URL` in the child env (see below)       |
| `auth_token` | string  | `ANTHROPIC_AUTH_TOKEN` in the child env (`Bearer` auth) |
| `thinking`   | boolean | `--thinking` → SDK `options.thinking = { type: enabled }` |

Injected MCP servers (`session/new.mcpServers`) forward to SDK
`options.mcpServers`, so the daemon can mount a scoped toolset like any other
arm.

### Anthropic-compatible gateways

`base_url` + `auth_token` point one spawn at an Anthropic-compatible gateway
with a per-spawn Bearer key (the ambient `ANTHROPIC_API_KEY` is for real
Anthropic). `auth_token` becomes `ANTHROPIC_AUTH_TOKEN`, which the SDK sends as
`Authorization: Bearer <token>` — accepted by Moonshot, OpenRouter, DeepSeek,
and the local `llm-endpoint` proxy. The token value is never logged.

When `base_url` is set the adapter enters **gateway mode**: it pins every model
tier the harness might internally request — `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` — to the resolved
`model`. Without this, a single-model gateway (e.g. Moonshot serving only
`kimi-k2.7-code`) rejects the harness's background `claude-haiku-*` requests.
Native Anthropic (no `base_url`) leaves tier routing untouched.

The runtime resolver injects the correct `ANTHROPIC_BASE_URL` and credential for
registered gateway providers (Moonshot, OpenRouter, Requesty, OpenCode Go,
OpenCode Zen, DeepSeek, `llm-endpoint`, etc.), so the adapter no longer
hard-codes gateway URLs or modes. You can still override manually with
`base_url` + `auth_token` for a gateway that is not yet in the catalog.

Note the Anthropic-flavored base URLs carry no `/v1`: the SDK appends
`/v1/messages` itself, so a `/v1` in the preset yields `…/v1/v1/messages` → 404.
Verify a gateway by POSTing to `<base_url>/v1/messages` — NOT by curling the
endpoint you think it serves.

### OpenCode Go / OpenCode Zen

Two separate OpenCode billing rails, both Anthropic-compatible and both keyed
on `OPENCODE_API_KEY` (opencode's own convention — same env NAME, two different
secrets, so the per-spawn auth profile's endpoint is what picks the rail):

| Route | Preset base URL | What the Anthropic surface serves |
|-------|-----------------|-----------------------------------|
| `opencode-go` | `https://opencode.ai/zen/go` | 4 of 36 ids: `minimax-m2.5`, `minimax-m2.7`, `minimax-m3`, `qwen3.8-flash` |
| `opencode` (Zen) | `https://opencode.ai/zen` | 20 of 102 ids — the entire Claude family (`claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-fable-5`/`-5-1`, `claude-haiku-4-5`, …) plus `qwen3.5/3.6-plus` and the `minimax-*-free` variants |

Zen is the valuable one here: it drives this very harness on real Claude models
against a Zen balance.

Model ids for these two carry **no `@route` suffix** — the route IS the id's
leading segment (`opencode/claude-sonnet-4-6`, `opencode-go/minimax-m3`),
matching opencode's own config spelling. Each endpoint also serves OpenAI
chat/completions-, OpenAI Responses- and (Zen only) Gemini-flavored models
behind the same base URL; those are unreachable from an Anthropic client and are
deliberately absent from this adapter's menu — run them through the `opencode`
adapter instead. The menu is derived from the catalog's generated per-model
surface discriminator (`listOpencodeAnthropicModelRefs`), never hand-typed.

Not verified live: no OpenCode key was available when this shipped, so unlike
the Moonshot / OpenRouter / Requesty rows above, these base URLs come from
models.dev's published endpoints (`https://opencode.ai/zen/go/v1`,
`https://opencode.ai/zen/v1`) minus the `/v1` the client appends, not from a
successful `claude -p` run.

### Extended thinking

Some gateway models are thinking-gated — `kimi-k2.7-code` rejects any request
that omits `thinking` (`invalid thinking: only type=enabled is allowed for this
model`). The SDK's `query()` exposes `Options.thinking?: ThinkingConfig`
(`{ type: 'adaptive' } | { type: 'enabled', budgetTokens? } | { type:
'disabled' }`); the `thinking` boolean option pass-through sets
`options.thinking = { type: 'enabled' }`. Off by default so native Claude models
keep their own (adaptive) thinking behaviour.

See [`claude-sdk.ACP.md`](./claude-sdk.ACP.md) for the full wire profile.
