# agent_prompt

Send a follow-up prompt to a live agent session — multi-turn continuity without
re-spawning. The session id comes from `agent_start` (or `agent_sessions_list`).
Returns immediately; tail output via `agent_output` or the SSE
`/sessions/:id/stream` endpoint.

Mid-turn, the prompt is steered into the running turn when the adapter supports
it (`steering: true` in `session_list`; `delivery: "steered"`), else queued FIFO
until the turn ends (`delivery: "queued-mid-turn"`; stale ones show as
`pendingPrompts` in `session_list`/`session_recap`). `pending: false` =
delivered, `true` = NOT yet; `deliverWithin` forces a stuck one through. An
interrupted turn leaves the queue parked until the next natural turn-end.
`dedupeKey` makes a retry safe: a second call with the same key inside the
window answers `delivery: "duplicate"` and delivers nothing (see below).
`interrupt: true` cancels the in-flight turn and redirects the SAME session onto
this prompt, keeping its context (unlike `agent_kill`); the prompt opens with a
one-line `[agentproto]` notice saying the cut was a delivery, not a stop. No-op
when idle.

Field detail cut from the schema lives here; each schema field description ends
with a pointer like `Details: tool_help {name:"agent_prompt", topic:"interrupt"}`.

## prompt

The next user turn — plain text, or a content block / block array for a
multimodal turn (e.g. a pasted image, `{type:"image", data, mimeType}`), the
same loose shape `POST /sessions/:id/prompt` accepts over HTTP. Forwarded to the
adapter verbatim; it negotiates its own multimodal support.

## interrupt

When true and the session is mid-turn, cancel the in-flight turn and deliver
this prompt on the same session immediately instead of queueing it behind the
current turn. No-op when the session is already idle. UNSET falls back to the
daemon default `defaults.agentPromptInterrupt` in config.json (false unless an
operator changed it) — so a mid-turn target queues by default; pass
`interrupt: true` explicitly to cut now.

## queue

When the session is mid-turn, queue this prompt (FIFO) and dispatch it
automatically once the current turn ends instead of rejecting. Default true.
Explicit false restores the old reject-when-busy behavior.

## dedupeKey

A retry-safe key, 1 to 200 characters after trimming. Once a prompt carrying
the key is accepted (dispatched, queued, or steered), a later call with the
same key inside a 24 hour window is not delivered again: it answers
`delivery: "duplicate"`, `pending: false`, and `duplicate: true`, plus the
original `queueId` while that item still waits (only when the key is the one the
waiting item was queued under: a key that was merged into an item by
`coalesceKey` answers `duplicate` without a `queueId`). `queued` is `false` for
a duplicate. A retry that arrives while the first call is still being admitted
(for example while a dead session resumes) answers `duplicate` too, but it may
already have attempted the same resume. Any other duplicate does not interrupt,
resume, compact, or touch the inbox or queue.

The key is available on this tool and on the registry call `enqueuePrompt`. The
HTTP prompt route and the CLI do not carry it yet, and it cannot be combined
with a typed `envelope` message (those have their own message id).

The accepted-key window holds at most 128 keys and is persisted with the
session, so the guarantee survives a daemon restart. Dropping a waiting item
with `session_queue_drop` (or `removeQueuedPrompt`) keeps its key: dropping is
an explicit cancel, and a retry must not resurrect it. Residual: a daemon
crash between accepting an idle session's key and its turn actually starting
loses that prompt, the same as today without a key; a queued item is
persisted with its key in one step, so it is not lost.
