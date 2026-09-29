# `agentproto steward`

```text
agentproto steward [--apply] [--idle <min>] [--min-confidence <x>]
                   [--judge <auto|jev|agent>] [--ask-sessions] [--wait] [--json]
```

Convenience shortcut over `agentproto workflow run-file` for the built-in
[`session-steward` app](../../../packages/apps/session-steward/README.md)'s
workflow: wrap up idle agent sessions. **Needs a running daemon**
(`agentproto serve`) — the workflow reads live sessions and its agent judge
spawns real (one-shot) sessions. **A dry run unless `--apply`.**

One run:

1. Plans with `session_wrapup_plan`: every idle agent session is `close`,
   `stuck`, `judge` or `keep`.
2. With `--apply`: closes `close`-class sessions as `done` and `stuck`-class
   ones as `abandoned` — resumable, with a recorded outcome.
3. Collects compact, read-only evidence (`session_evidence`) for up to 15
   `judge`-class sessions, most RAM first.
4. Judges each one: with **Jev** (TypeSafe System One — a calibrated choice
   with probabilities) when `JEV_API_KEY` resolves, else a one-shot **agent
   judge** (haiku). A Jev failure falls back to the agent judge for that
   session; a malformed or failed judgement is `active` and never acted on.
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
| `--judge <backend>` | `auto` | `auto` (Jev when `JEV_API_KEY` resolves, else the agent judge), `jev`, or `agent`. |
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
# Dry run: plan + verdicts, print the report
agentproto steward --wait

# Close / flag confident verdicts
agentproto steward --apply --wait

# Stricter: only sessions idle an hour, agent judge, 0.9 confidence
agentproto steward --apply --idle 60 --judge agent --min-confidence 0.9
```

## Scheduling it

`packages/apps/session-steward/routines/session-steward-hourly` is an AIP-41
`ROUTINE.md` template — hourly, `apply: true`, `askSessions: false` — shipped
`enabled: false`, so nothing starts closing sessions on install. Its own doc
lists the enabling steps.
