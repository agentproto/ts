# `agentproto steward`

```text
agentproto steward [--idle <min>] [--judge <agent|rules>] [--include-children]
                   [--format <markdown|text>] [--wait] [--json]
agentproto steward --wrapup [--apply] [--idle <min>] [--min-confidence <x>]
                   [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]
```

Convenience shortcut over `agentproto workflow run-file` for the built-in
[`session-steward` app](../../../packages/apps/session-steward/README.md)'s
workflows. **Needs a running daemon** (`agentproto serve`) — the workflows read
live sessions and their agent judges spawn real (one-shot) sessions.

## Default: attention (read-only)

Triage every live session and print a prioritized "what needs you" digest —
most urgent first. Each entry carries a title (the real one, not the auto
`chat HH:MM:SS` label), a one-line reason, its idle time and a last-message
excerpt. Verdicts: `needs-reply`, `stuck` (looping / errored / unanswered /
never ran), `blocked`, `done` (optionally "waiting on you"), `superseded`,
`parked` (idle, no question, no error, no conclusion), `active` (busy, or
finished <10 min ago — counted, not listed). Rules decide the certain cases
(repeated-sentence loops also on idle sessions, errored last turn,
`awaitingInput`, `continuedTo`, merged PR, unanswered user message,
question/ask phrases EN/FR, recorded done outcome, blocker phrases, same-title
newer sibling); a one-shot judge agent (`@agentproto/session-attention-judge`)
decides what stays under 0.9 confidence and is never allowed to answer
`active` for an idle session. **It never closes, flags, nudges or messages
anything.**

| Flag | Default | Description |
|------|---------|-------------|
| `--idle <min>` | `10` | Minutes since last activity before a finished turn counts as waiting. |
| `--judge <backend>` | `agent` | `agent` (one-shot judge) or `rules` (no model). |
| `--include-children` | `false` | Also triage executors whose supervisor is still live. |
| `--format <fmt>` | `markdown` | With `--wait`: the markdown report, or the plain-text digest (chat/Telegram-ready, capped at 3500 chars). |
| `--wait` | `false` | Block until the run ends, then print the report. Exit `0` when done, `1` when it failed or was cancelled. |
| `--json` | `false` | Print the raw `workflow_run_file` reply (with `--wait`: the finished run record). |

`--apply`, `--min-confidence` and `--ask-sessions` without `--wrapup` are an
error — the default mode is read-only.

## Wrap-up mode (`--wrapup`, legacy)

The old behaviour — close or flag idle sessions. **A dry run unless
`--apply`.**

One run:

1. Plans with `session_wrapup_plan`: every idle agent session is `close`,
   `stuck`, `judge` or `keep`.
2. With `--apply`: closes `close`-class sessions as `done` and `stuck`-class
   ones as `abandoned` — resumable, with a recorded outcome.
3. Collects compact, read-only evidence (`session_evidence`) for up to 15
   `judge`-class sessions, most RAM first.
4. Judges each one: with **Jev** (TypeSafe System One — a calibrated choice
   with probabilities) when `jev.apiKey` from `~/.agentproto/config.json` or
   the `JEV_API_KEY` env var resolves, else a one-shot **agent judge**
   (sonnet). A Jev failure falls back to the agent judge for that session; a
   malformed or failed judgement is `active` and never acted on.
5. With `--ask-sessions`: asks low-confidence idle sessions directly whether
   they're done (one prompt each, ~3 min bounded wait).
6. With `--apply`: confident (≥ `--min-confidence`) `done`/`abandoned`
   verdicts close the session; `blocked`/`needs-input` only flag it.
7. Reports a markdown table plus RAM freed / still held.

`keep`-class sessions and the calling session (`AGENTPROTO_SESSION_ID`) are
never touched, and `session_wrapup_apply` re-checks every id right before
acting.

| Flag | Default | Description |
|------|---------|-------------|
| `--apply` | `false` | Close / flag sessions. Without it: plan + verdicts only, nothing is touched. |
| `--idle <min>` | `30` | Idle threshold in minutes. |
| `--min-confidence <x>` | `0.8` | Judge confidence (0..1) needed to act on a verdict. |
| `--judge <backend>` | `auto` | `auto` (Jev when `jev.apiKey` config or `JEV_API_KEY` env resolves, else the agent judge), `jev`, or `agent`. |
| `--ask-sessions` | `false` | Ask low-confidence sessions directly — spends a turn in their conversation. |
| `--wait` | `false` | Block until the run ends, then print its markdown report. Exit `0` when done, `1` when it failed or was cancelled. |
| `--json` | `false` | Print the raw `workflow_run_file` reply (with `--wait`: the finished run record). |

This starts the run and returns immediately — poll it with:

```bash
agentproto workflow status <runId>
```

Or pass `--wait` to block until it finishes and print the report inline.

## Examples

```bash
# What needs me — markdown report
agentproto steward --wait

# The plain-text digest (chat/Telegram-ready)
agentproto steward --wait --format text

# Legacy dry run: plan + verdicts, print the report
agentproto steward --wrapup --wait

# Close / flag confident verdicts
agentproto steward --wrapup --apply --wait

# Stricter: only sessions idle an hour, agent judge, 0.9 confidence
agentproto steward --wrapup --apply --idle 60 --judge agent --min-confidence 0.9
```

## Scheduling it

`packages/apps/session-steward/routines/session-steward-hourly` is an AIP-41
`ROUTINE.md` template — hourly, `apply: true`, `askSessions: false` — the
legacy wrap-up, shipped `enabled: false`, so nothing starts closing sessions
on install. Its own doc lists the enabling steps.
