# Design note: a quiescence signal for terminal (PTY) sessions

Status: proposal only — nothing here is implemented. Filed alongside the
terminal-session DX fixes (parent attribution on `terminal_start`,
`terminal_output { clean: true }`) because it is the third rough edge hit
in the same supervision scenario.

## Problem

`session_monitor` and `agentproto sessions wait --until turn-end` work on
agent-cli sessions because the ACP adapter reports turn boundaries. A PTY
session (`terminal_start`, `kind: "terminal"`) has no turn concept: bytes
flow through the ring buffer and the only lifecycle events are spawn and
exit. Supervising an interactive agent running *inside* a PTY (e.g.
claude-code as a TUI) therefore means blind-polling `terminal_output` and
diffing the buffer — there is no way to block on "the TUI has gone quiet,
go look at it".

## Proposal: a `terminal:idle` heuristic event

Emit a session event when a PTY produces no output for a configurable
window (default e.g. 2000 ms) after having produced some:

- The registry already funnels every chunk through one place
  (`pty.onData` → `appendBytes` in `sessions.ts`), so an idle timer is a
  per-session `setTimeout` reset on each chunk — no polling loop.
- On firing, emit `terminal:idle` on the session's emitter and the daemon
  event bus (same channel `session_monitor` subscribes to), carrying
  `{ sessionId, idleMs, lastOutputAt }`.
- A new chunk after idling emits a paired `terminal:active`, so a
  supervisor can also detect "it woke up again".

Consumers then get, with no new verbs:

- `session_monitor` can surface idle/active transitions for terminal
  sessions instead of nothing.
- `sessions wait --until idle --idle-ms 5000` becomes a natural CLI
  extension of the existing `--until turn-end` flag.
- Completion policies (`policy_attach`) could gate on idle as a cheap
  stand-in for turn-end when the watched session is a PTY.

## Caveats (why this is a heuristic, not a turn signal)

- Spinners and clocks: many TUIs (claude-code included) animate while
  "idle-waiting for input", so raw byte-silence never happens. The window
  likely needs to ignore output that strips to nothing after ANSI
  removal, or apply a small change-threshold (screen-diff, not byte
  count) — this is the main design question to settle before building.
- Idle ≠ done: a TUI can be quiet because it is waiting for permission
  approval, not because the turn ended. The event should be documented as
  "output quiescence", never as "turn-end".
- Tunables (window length, min-bytes-to-arm) should be per-call options
  with conservative defaults, not global config.

## Non-goals

- No attempt to parse TUI semantics (prompt detection, screen scraping).
- No change to agent-cli turn tracking — this is additive for
  `kind: "terminal"` only.
