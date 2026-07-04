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
`Authorization: Bearer <token>` — accepted by both Moonshot and OpenRouter.
The token value is never logged.

When `base_url` is set the adapter enters **gateway mode**: it pins every model
tier the harness might internally request — `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` — to the resolved
`model`. Without this, a single-model gateway (e.g. Moonshot serving only
`kimi-k2.7-code`) rejects the harness's background `claude-haiku-*` requests.
Native Anthropic (no `base_url`) leaves tier routing untouched.

Verified live: Moonshot `https://api.moonshot.ai/anthropic` +
`model=kimi-k2.7-code`, and OpenRouter `https://openrouter.ai/api/v1`, both
return valid Anthropic Messages format under `Authorization: Bearer`.

### Gateway presets (modes)

So you don't hand-type the base URL each spawn, two modes pre-wire the gateway
endpoint (`base_url`/`auth_token`/`thinking` still work manually for anything
else):

| mode        | pre-wires                                                        | you supply                          |
| ----------- | --------------------------------------------------------------- | ----------------------------------- |
| `default`   | nothing — native Anthropic                                       | `ANTHROPIC_API_KEY`                 |
| `moonshot`  | `ANTHROPIC_BASE_URL` + `model=kimi-k2.7-code` + `--thinking`     | `auth_token` (Moonshot key)         |
| `openrouter`| `ANTHROPIC_BASE_URL`                                             | `model` (slug) + `auth_token` (key) |

`mode: moonshot` is a one-pick Kimi run; override `model` for another Moonshot
model. `mode: openrouter` still needs a `model` (e.g. `z-ai/glm-5.2`,
`deepseek/deepseek-v4-pro`, `moonshotai/kimi-k2`). The `auth_token` is the
gateway key — the ambient `ANTHROPIC_API_KEY` stays for real Anthropic.

### Extended thinking

Some gateway models are thinking-gated — `kimi-k2.7-code` rejects any request
that omits `thinking` (`invalid thinking: only type=enabled is allowed for this
model`). The SDK's `query()` exposes `Options.thinking?: ThinkingConfig`
(`{ type: 'adaptive' } | { type: 'enabled', budgetTokens? } | { type:
'disabled' }`); the `thinking` boolean option pass-through sets
`options.thinking = { type: 'enabled' }`. Off by default so native Claude models
keep their own (adaptive) thinking behaviour.

See [`claude-sdk.ACP.md`](./claude-sdk.ACP.md) for the full wire profile.
