---
"@agentproto/adapter-claude-sdk": patch
---

fix(claude-sdk): stop a stalled gateway turn from hanging forever

A `moonshot`-mode turn could hang indefinitely with zero output: the ACP host's
`#drive` awaited the SDK `query()` async iterator in an unbounded `for await`,
and Moonshot's Anthropic-compatible stream (whose `thinking` blocks ship an
empty `signature` and a non-`msg_` id) can leave that iterator never yielding
the SDK's terminal `result` and never closing. The session stayed `busy` with
`turnsCompleted` stuck at 0 and no error surfaced — the worst failure mode.

Add an idle watchdog to `#drive`: if `query()` produces no message for
`idleTimeoutMs` (default 5 min, override via `CLAUDE_SDK_IDLE_TIMEOUT_MS`, `0`
disables), the turn is aborted and the stall is surfaced as an error instead of
hanging. Idle-based, so a legitimately long generation or tool run is
unaffected. Native Anthropic turns are unchanged.
