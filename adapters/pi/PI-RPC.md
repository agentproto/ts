# Pi RPC wire profile

Reverse-engineered from pi source at **0.80.3**
(`github.com/earendil-works/pi`, package `@earendil-works/pi-coding-agent`):

- `packages/coding-agent/src/modes/rpc/rpc-types.ts` — command + response unions
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — the event loop (the
  decisive file: `session.subscribe((event) => output(event))`)
- `packages/coding-agent/src/modes/rpc/jsonl.ts` — framing
- `packages/coding-agent/src/core/agent-session.ts` — `AgentSessionEvent`
- `packages/agent/src/types.ts` — base `AgentEvent`, `AssistantMessageEvent`
- `packages/ai/src/types.ts` — `StopReason`, `Usage`, `ToolCall`, message shapes

## Transport & framing

`pi --mode rpc` is a persistent duplex:

- **stdin** — one command per line: `JSON.stringify(command) + "\n"`.
- **stdout** — one record per line, **LF-only framing** (`\n`). Payloads may
  contain U+2028/U+2029, so records MUST be split on `\n` only (pi deliberately
  avoids Node `readline`). The client mirrors this with a `StringDecoder` +
  manual `\n` scan.

The process stays alive until stdin ends (pi then shuts down) or it receives
`SIGTERM`/`SIGHUP`. `close()` calls `stdin.end()` then `SIGTERM`.

## stdout carries three kinds of record

1. **Responses** — `{ type: "response", command, success, id?, data?, error? }`.
   `id` echoes the command's `id` for correlation. `success:false` carries
   `error: string`.
2. **Session events** — pi's `AgentSessionEvent` union, emitted verbatim by
   `session.subscribe`. These are the stream this adapter maps.
3. **Extension-UI requests** — `{ type: "extension_ui_request", ... }` (and
   `extension_error`). This adapter ignores them (classified as `other`); pi's
   RPC mode does not require a response for the fire-and-forget ones.

Note: `--mode rpc` does **not** emit the `{ type: "session", version, id, ... }`
header that `--mode json` emits. The client obtains the session id via a
`get_state` command instead.

## Commands this adapter sends

| Command | Shape | When |
| ------- | ----- | ---- |
| `get_state` | `{ id, type: "get_state" }` | right after spawn — readiness probe + captures `data.sessionId` |
| `set_thinking_level` | `{ id, type: "set_thinking_level", level }` | after connect, when an `effort` is set (`level ∈ off\|minimal\|low\|medium\|high\|xhigh`) |
| `prompt` | `{ id, type: "prompt", message }` | each turn (fire-and-forget; events follow) |
| `abort` | `{ id, type: "abort" }` | `cancel()` |

Model + resume are passed as **spawn argv**, not RPC commands:
`pi --mode rpc [--model <provider/id>] [--session <resumeSessionId>]`
(flags verified in `packages/coding-agent/src/cli/args.ts`;
`--model` accepts `provider/id` and an optional `:<thinking>` suffix).

### `prompt` is fire-and-forget

Pi acks `prompt` as soon as preflight succeeds
(`{ command:"prompt", success:true }`) — the real work streams as events. A
`{ command:"prompt", success:false, error }` means **no events will follow**, so
the client synthesizes an `error` + `turn-end{error}` on the active turn so
`events()` terminates instead of hanging.

## Session events (`AgentSessionEvent`) and their fields

Base `AgentEvent` (`packages/agent/src/types.ts`):

```
{ type: "agent_start" }
{ type: "agent_end"; messages; willRetry }        // session-extended
{ type: "turn_start" }
{ type: "turn_end"; message: AgentMessage; toolResults }
{ type: "message_start"; message }
{ type: "message_update"; message; assistantMessageEvent }   // streaming
{ type: "message_end"; message }
{ type: "tool_execution_start"; toolCallId; toolName; args }
{ type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
{ type: "tool_execution_end"; toolCallId; toolName; result; isError }
```

Session-only additions: `agent_settled`, `queue_update`, `compaction_*`,
`auto_retry_*`, `entry_appended`, `session_info_changed`,
`thinking_level_changed`.

`AssistantMessageEvent` (carried on `message_update.assistantMessageEvent`):

```
{ type: "text_delta"; delta; contentIndex; partial }
{ type: "thinking_delta"; delta; contentIndex; partial }
{ type: "done"; reason: "stop"|"length"|"toolUse"; message }
{ type: "error"; reason: "error"|"aborted"; error }
  ... plus start/text_start/text_end/thinking_start/thinking_end/toolcall_* (ignored)
```

`StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`.
`Usage = { input, output, totalTokens, cost: { total, ... }, ... }` (on the
assistant message).

## Event → StreamEvent mapping table

| pi event | condition | StreamEvent |
| -------- | --------- | ----------- |
| `message_update` / `text_delta` | — | `text-delta { text: delta }` |
| `message_update` / `thinking_delta` | — | `thought { text: delta }` |
| `message_update` / `done` | — | *(no event)* — records `stopReason` for turn-end |
| `message_update` / `error` | `reason === "error"` | `error { message: errorMessage }` + records `stopReason` |
| `message_update` / `error` | `reason === "aborted"` | *(no event)* — records `stopReason` |
| `tool_execution_start` | — | `tool-call { toolCallId, toolName, arguments: args }` |
| `tool_execution_end` | — | `tool-result { toolCallId, result, isError }` |
| `turn_end` | assistant `message.stopReason` present | records `stopReason` |
| `turn_end` | assistant `message.usage` present | `usage_update` (see note) |
| `agent_end` | `willRetry !== true` | **`turn-end { reason: mapStopReason(lastStopReason) }`** — the turn terminator |
| `agent_end` | `willRetry === true` | *(no event)* — an auto-retry cycle; the turn continues |
| `agent_start` / `turn_start` / `agent_settled` | — | *(no event)* |
| anything else (queue_update, compaction, extension_ui, …) | — | ignored |

### `stopReason` → `turn-end.reason`

| pi StopReason | turn-end reason |
| ------------- | --------------- |
| `stop` | `completed` |
| `aborted` | `cancelled` |
| `error` | `error` |
| `length` | `max_turns` *(closest "hit a budget limit"; see gap below)* |
| `toolUse` | `completed` *(never the settled reason; defensive)* |
| *(absent)* | `completed` |

**Terminator choice.** A prompt turn's RPC stdout sequence ends at `agent_end`
(verified empirically against pi 0.80.3):
`response/prompt → agent_start → turn_start → message_* → turn_end → agent_end`.
Pi's `agent_settled` event is emitted to in-process **extension** listeners
(`_emitAgentSettled`) but is **not** written to the RPC stdout stream, so it
cannot be the terminator. This adapter therefore terminates on `agent_end`,
honoring `willRetry`: an `agent_end{willRetry:true}` (auto-retry) is ignored and
only the final `agent_end{willRetry:false}` emits `turn-end`.

## Known gaps / assumptions

- **`usage_update.size` / `.used`** — pi's per-message `Usage` reports token
  totals + cost, but **no context-window size**. `client.ts` resolves the
  window once per `connect()` from `@agentproto/model-catalog`'s
  `resolveContextWindow(opts.model)` and the mapper surfaces it as `size`;
  when the model isn't in the catalog, `size` is sent as `0` (this
  codebase's "unknown window" sentinel — the runtime only applies `size`
  when `> 0`, so `contextSize` is left unset rather than defaulted to a
  token count). `used` is `usage.totalTokens`. `tokensIn`/`tokensOut` =
  `input`/`output`; `cost = { amount: usage.cost.total, currency: "USD" }`.
  Previously this mapper sent `usage.totalTokens` as BOTH `size` and `used`,
  which pinned `contextPct` at 100% on every turn and tripped the
  context-continuity hard stop immediately — fixed alongside a
  `contextSize === contextUsed` guard in the runtime's
  `computeContextPct` (`packages/runtime/src/context-continuity.ts`). A
  further improvement could issue `get_session_stats` (which carries
  `contextUsage`) for a live `used` figure straight from pi, at the cost of
  an extra round-trip.
- **`length` → `max_turns`** — pi's `length` stop reason is a token/context
  cap, not a turn-count cap. `max_turns` is the closest canonical "budget hit"
  reason; there is no exact equivalent in the `StreamEvent` taxonomy.
- **Multimodal** — pi's `prompt` command accepts `images: ImageContent[]`.
  `capabilities.multimodal` is `true` (pi supports it), but the current client
  extracts **text only** from the host message; image passthrough is not yet
  wired.
- **`plan`** — pi emits no plan/todo event on the RPC stream, so this adapter
  never produces `StreamEvent{kind:"plan"}`.
- **`steer` / `follow_up`** — pi's RPC mode supports these mid-turn duplex
  commands (hence `bidirectional: true`), but the AgentCliClient contract only
  exposes `send` / `cancel`; this adapter maps `send` → `prompt` and `cancel` →
  `abort`. Steering is available on the wire but not surfaced by the current
  contract.
