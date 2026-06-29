# mastra-agent — ACP wire profile

AIP-44 ACP profile for the first-party Mastra agent. The agent side is
implemented in `src/acp-host.ts` against `@agentclientprotocol/sdk`'s
`AgentSideConnection`, spawned over stdio (`agentproto-mastra acp`).

## Lifecycle

| Method            | Behaviour                                                        |
| ----------------- | --------------------------------------------------------------- |
| `initialize`      | Returns `PROTOCOL_VERSION` + `agentCapabilities.loadSession=false`. |
| `authenticate`    | No-op (`{}`). The model provider key is read from the spawn env. |
| `session/new`     | Allocates a random session id; agent is built lazily on first prompt. |
| `session/prompt`  | Extracts the user's text content blocks, drives the Mastra agent's `stream()`, and relays each text delta as an `agent_message_chunk` `session/update`. Resolves with `stopReason: end_turn` (or `cancelled` / `refusal`). |
| `session/cancel`  | Aborts the in-flight turn for that session.                     |

## Models

The `model` is a Mastra-routable `provider/model` id (e.g.
`anthropic/claude-opus-4-8`, `openrouter/z-ai/glm-5.2`), resolved by Mastra's
model gateway using the provider key in the environment. Override per spawn via
the `--model` arg (wired through the manifest `model` option's
`bin_args_template`).

## Auth / secrets

One provider key for the chosen model, on the spawn env: `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (and the other gateway-supported
providers). No ACP-level auth handshake.
