# claude-sdk — ACP wire profile

AIP-44 ACP profile for the first-party Claude Agent SDK adapter. The agent side
is implemented in `src/acp-host.ts` against `@agentclientprotocol/sdk`'s
`AgentSideConnection`, spawned over stdio (`agentproto-claude-sdk acp`). It
drives the Claude Agent SDK's headless `query()` and relays the SDK's native
message stream as ACP `session/update`s. I/O stays 100% Anthropic-native.

## Lifecycle

| Method            | Behaviour                                                        |
| ----------------- | --------------------------------------------------------------- |
| `initialize`      | Returns `PROTOCOL_VERSION` + `agentCapabilities.loadSession=false`. |
| `authenticate`    | No-op (`{}`). Auth is read from the spawn env by the SDK.       |
| `session/new`     | Allocates a UUID session id and records the injected `mcpServers`. The id is PINNED via the SDK's `options.sessionId` on the first turn, so the ACP and SDK session ids are the same value. |
| `session/prompt`  | Extracts the user's text content blocks, drives `query({ prompt, options })`, and relays the SDK stream: `assistant` text → `agent_message_chunk`, `tool_use` → `tool_call`, `tool_result` → `tool_call_update`, `result` → `usage_update`. Resolves with `stopReason: end_turn` (or `cancelled` / `refusal`). |
| `session/cancel`  | Aborts the in-flight turn (via the SDK `options.abortController`). |

## Message mapping

| SDK message (`SDKMessage`)        | ACP `session/update`     |
| --------------------------------- | ------------------------ |
| `assistant` → `text` block        | `agent_message_chunk`    |
| `assistant` → `tool_use` block    | `tool_call` (in_progress)|
| `user` → `tool_result` block      | `tool_call_update`       |
| `result`                          | `usage_update` (tokens + cost) |
| `system` / `init`                 | (captures `session_id`; not surfaced) |

## Usage telemetry

The `result` message's native Anthropic usage is mapped to the runtime's
`usage_update` shape: `size` (context window from `modelUsage`), `used` (tokens
in context), `cost` (from `total_cost_usd`, in USD), and the `tokensIn` /
`tokensOut` extension.

## Resume

Turns resume via the SDK session store: the first turn pins the session UUID
(`options.sessionId`), later turns continue it (`options.resume`). There is no
ACP `session/load` replay surface, so `loadSession` is advertised as `false`.

## Models

`model` is a Claude model id (e.g. `claude-opus-4-8`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`), applied per spawn via the `--model` arg (manifest
`model` option's `bin_args_template`) → SDK `options.model`. Default:
`claude-haiku-4-5-20251001`.

## Base URL / providers

`base_url` sets `ANTHROPIC_BASE_URL` in the child env (manifest `base_url`
option's `env` template), keeping the harness Anthropic-native while pointing at
real Anthropic, Bedrock/Vertex/Azure, or an Anthropic-compatible gateway.
`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`
pass through from the spawn env.

When `base_url` is set the adapter enters **gateway mode** and pins every
internal model tier the harness may request to the resolved `model`:
`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`. This stops a
single-model gateway (e.g. Moonshot serving only `kimi-k2.7-code`) from
receiving a background `claude-haiku-*` request it can't serve. Native Anthropic
(no `base_url`) leaves tier routing untouched.

## Auth / secrets

`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on the spawn env (direct or via an
Anthropic-compatible gateway), or the cloud-provider toggles above. No ACP-level
auth handshake. The `auth_token` option sets `ANTHROPIC_AUTH_TOKEN` in the child
env (manifest `auth_token` option's `env` template) — the SDK sends it as
`Authorization: Bearer <token>`, letting one spawn target a gateway (Moonshot,
OpenRouter) with a per-spawn Bearer key. The token value is never logged.

## Thinking

`thinking` (boolean) appends `--thinking`, which sets SDK
`options.thinking = { type: "enabled" }` (`Options.thinking?: ThinkingConfig`).
Required by thinking-gated gateway models such as `kimi-k2.7-code`, which reject
a request that omits `thinking`. Off by default so native Claude models keep
their own adaptive thinking.

## Permissions

Tool-permission handling defaults to `bypassPermissions` (with the required
danger flag) so the arm can act unattended inside the daemon's sandbox. Override
via `CLAUDE_SDK_PERMISSION_MODE` (`default` | `acceptEdits` | `bypassPermissions`
| `plan` | `dontAsk` | `auto`).
