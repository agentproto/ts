# message_parent

Report a message UP to the session that spawned you (your parent/supervisor) —
a result, a progress update, or a blocker. No session id needed: the daemon
resolves your recorded parent from your own session identity (also visible as
the `AGENTPROTO_PARENT_SESSION_ID` env var).

An idle parent gets it as its own turn right away. A busy parent gets it by
`urgency`: `next-turn` (default for report/done/notice) waits for its current
turn to end; `steer` (default for blocker/question) is injected INTO its running
turn when its agent supports that, else next-turn; `fyi` only lands in its
inbox. `interrupt: true` asks to cancel the parent's turn — honoured only when
the operator allows it, otherwise delivered as `steer`. The result reports the
tier actually applied. Errors if this session has no recorded parent or the
parent is gone.

Field detail cut from the schema lives here; each schema field description ends
with a pointer like `Details: tool_help {name:"message_parent", topic:"interrupt"}`.

## interrupt

Ask to cancel the parent's in-flight turn and deliver this now (urgency
`interrupt`). Honoured only when config.json
`defaults.messaging.agentInterrupt` is `"allow"`; otherwise it's delivered as
`steer` (injected into the running turn when possible) and the result says so.
UNSET falls back to `defaults.agentPromptInterrupt` (false by default).

## urgency

`fyi | next-turn | steer | interrupt`. Default: steer for blocker/question,
next-turn otherwise. `interrupt: true` wins over this.

## kind

What this message is: `report` (default — a result or progress), `question` (you
need an answer), `blocker` (you cannot proceed), `done` (your task is complete),
`notice` (informational). Shown to the parent in the daemon-attested message
header.
