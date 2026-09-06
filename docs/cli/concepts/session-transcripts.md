# Session transcripts

Every `agent-cli` session the daemon spawns (claude-code, hermes,
mastra-agent, …) gets a structured, append-only transcript on disk —
independent of the adapter's own persistence, and independent of the
in-memory ANSI ring buffer that powers `sessions --attach`. It's what
lets `agentproto sessions export`, the raw events endpoint, or any
other frontend reconstruct a session's actual turns (prompts, text,
tool calls, plans, usage) instead of replaying raw stream bytes.

## What's persisted, and where

```text
~/.agentproto/sessions/<sessionId>/events.jsonl
```

One JSON object per line, written at the same tap point that flattens
`StreamEvent`s into the ring buffer — but *before* that flattening, so
no structure is lost. Every line has:

```jsonc
{ "seq": 42, "ts": "2026-07-03T01:12:04.512Z", "kind": "text-delta", "sessionId": "ses_abc12", /* …kind-specific fields */ }
```

- `seq` — monotonically increasing per session, starts at 1. Used as
  the cursor for incremental polling (see
  [`verbs/sessions.md`](../verbs/sessions.md#raw-events-http)).
- `ts` — ISO 8601, stamped at write time.
- `kind` — one of the event kinds below.

The file is opened in append mode and only ever grows. It's plain
on-disk state, not held in the daemon's memory, so a session's
history is still there — readable by `sessions export` or the raw
events endpoint — after a daemon restart, even though the in-memory
ring buffer is not. A session that gets a fresh agentproto id (e.g.
via `sessions restart`) gets its own new `events.jsonl`; it doesn't
append to a prior session's file.

## Event kinds

| Kind | Fields (beyond `seq`/`ts`/`kind`/`sessionId`) | Notes |
|------|------------------------------------------------|-------|
| `user-prompt` | `text`, `source?` | The outgoing message for a new turn. Named `user-prompt` (not ACP's `agent-prompt`) to avoid clashing with the kind below, which means the opposite direction. `source` records prompt provenance when a supervisor/session injected the prompt (e.g. `agent:<sessionId>`), surfaced in UIs as "SUPERVISOR ASKED". |
| `text-delta` | `text`, `partial?` | Assistant reply text. Streamed chunks are coalesced up to each newline; a trailing fragment with no newline yet is flushed after a 250ms debounce with `partial: true`. |
| `thought` | `text`, `partial?` | Same coalescing/debounce behavior as `text-delta`, for reasoning/thinking output. |
| `tool-call` | `toolCallId`, `toolName`, `arguments` | One record per tool invocation. |
| `tool-result` | `toolCallId`, `result`, `isError` | Correlates to a prior `tool-call` via `toolCallId`. |
| `agent-prompt` | `toolCallId`, `options` | The agent asking the human a question (e.g. a tool permission prompt) — ACP's own "agent-prompt" direction. |
| `permission-resolved` | `toolCallId`, `decision`, `optionId?` | Durable counterpart to an `agent-prompt` ask, written when the request is approved, denied, or cancelled. `decision` is `"approve"`, `"deny"`, or `"cancelled"`; `optionId` mirrors the chosen option when one was offered (e.g. `allow_always`). |
| `plan` | `entries` (`{content, priority, status}[]`) | Structured plan/todo-list snapshot. |
| `usage_update` | `size`, `used`, `cost?` | Context window usage; `cost` is only present when the adapter reports one. |
| `usage_snapshot` | `model?`, `costUsd?`, `tokensIn?`, `tokensOut?`, `contextSize?`, `contextUsed?`, `source` | On-demand usage pull (e.g. from the `session_usage` MCP tool). |
| `turn-end` | `reason` | Marks the end of a turn. |
| `error` | `error` (`{message, code?, data?}`) | A turn-level error. |

Any event kind the writer doesn't recognize is dropped silently, the
same way the ring-buffer projector ignores kinds it doesn't switch on
— a forward-compatible default rather than a hard failure.

### Pulling usage on demand: `session_usage`

`usage_update` above is passive — it only shows up in the transcript when
the adapter emits one. To pull a session's current cost/token usage on
demand instead, call the `session_usage` MCP tool with a `sessionId`; it
returns the same `{size, used, cost?}` shape live, without waiting for the
next `usage_update` event.

### Text fidelity

`text-delta` and `thought` records are byte-for-byte reconstructable:
each written line keeps its own trailing newline (a blank line is
persisted as `"\n"`, not `""`), and only the still-buffered tail
fragment — one that hasn't hit a newline yet — lacks one, because
that's exactly how it arrived from the adapter. Anything reading the
file back (the raw events endpoint, `agent_export` markdown) can
concatenate `text` fields directly without reintroducing or losing
line breaks.

## PTY sessions are bytes-only, by design

`terminal` (PTY) and `command` sessions never call into the
transcript writer — they have no structured `StreamEvent` source to
begin with (a PTY is raw bytes: ANSI escapes, alt-screen, arbitrary
program output), so there's nothing to capture beyond what the ring
buffer already holds. Only `agent-cli` sessions — driven through ACP,
which does emit structured `StreamEvent`s — produce an
`events.jsonl`. `agentproto sessions export` and the raw events
endpoint both 404 for a PTY session id.

## Native vs daemon stores

`events.jsonl` is agentproto's own capture, available for *any*
agent-cli session regardless of adapter. Two adapters additionally
persist their own conversation history independently:

- **claude-code** — `~/.claude/projects/<cwd-with-slashes-as-dashes>/<adapterSessionId>.jsonl`
- **hermes** — `~/.hermes/state.db` (SQLite, read via `node:sqlite`)

`agentproto sessions export` and `agent_export` can read from either:
`source: native` re-reads the adapter's own store (richer for the two
adapters that have one — e.g. hermes exposes token/cost breakdowns
straight from its DB), `source: daemon` always reads `events.jsonl`,
and the default `source: auto` prefers native and falls back to
daemon when there's no native strategy for the adapter or the native
store can't be read. See
[`verbs/sessions.md`](../verbs/sessions.md#export-id-or-name) for the
exact flag/query semantics.

## See also

- [`verbs/sessions.md`](../verbs/sessions.md) — `sessions export`, the
  raw events endpoint, and prompt-delivery error semantics
- [`verbs/chat.md`](../verbs/chat.md) — the REPL that drives the
  prompt endpoint turn by turn
