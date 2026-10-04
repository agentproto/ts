---
name: session-steward
description: Tell which live agentproto sessions need you (read-only attention digest — the default) or wrap up idle ones (legacy --wrapup). Use when the user says "what needs me", "run the steward", "clean up idle sessions", "close finished sessions", or asks which sessions are still needed. The default mode never mutates daemon state; --wrapup --apply closes/flags sessions.
---

# Session Steward

`agentproto steward` has two modes:

- **Attention (default, read-only)** — triage every live session and print a
  prioritized "what needs you" digest: `needs-reply`, `stuck` (looping /
  errored / unanswered / never ran), `blocked`, `done` (optionally "waiting
  on you"), `superseded`, `parked`, `active` (counted, not listed). Each
  entry has a title, a one-line reason, idle time and a last-message excerpt.
  Rules decide the certain cases; a one-shot judge
  (`@agentproto/session-attention-judge`) decides what stays under 0.9
  confidence and is never allowed to answer `active` for an idle session.
  It never closes, flags, nudges or messages anything.
- **Wrap-up (`--wrapup`, legacy)** — classify idle sessions with
  `session_wrapup_plan`, close the rule-certain ones, and send the ambiguous
  ones through a cheap judge (Jev classifier, fallback: a one-shot LLM
  agent). Dry run by default — nothing is closed unless `--apply`.

## Run it

Prefer the CLI (it installs/updates the app and runs the workflow):

```bash
agentproto steward --wait
```

Variants:

```bash
agentproto steward --wait                          # attention digest (markdown)
agentproto steward --wait --format text            # plain-text digest (chat/Telegram-ready)
agentproto steward --wait --judge rules            # rules only, no model
agentproto steward --wait --include-children       # also triage executors with a live supervisor
agentproto steward --wrapup --wait                 # legacy dry run: plan + verdicts + report
agentproto steward --wrapup --apply --wait         # close/flag confident verdicts
agentproto steward --wrapup --apply --wait --idle 60
agentproto steward --wrapup --apply --wait --min-confidence 0.9
agentproto steward --wrapup --apply --wait --judge agent
agentproto steward --wrapup --ask-sessions --wait  # ask low-confidence sessions directly
```

`--wait` blocks until the report is ready (a run takes ~1-3 min depending on
candidate count). Without it, poll with `workflow_status` on the returned
runId.

## Read the digest (attention)

The workflow outputs are `report` (markdown), `text` (plain digest, capped
at 3500 chars), `counts`, `items` and `scan`. Verdicts by urgency:
`needs-reply` (90), `stuck` (85/75), `blocked` (70), `done` + waiting on you
(60), `parked` (45), `done` (30), `superseded` (25), `active` (0 — counted,
never listed). An idle session whose last turn finished is never `active` —
a final guard rewrites it to `parked`.

## Read the wrap-up report

The wrap-up report is a markdown table: class (close/stuck/judge), session
label + id, idle time, RAM, verdict, confidence, reason, action. Key reading
rules:

- `close` rows are safe to auto-close; `judge` rows are what the judge saw.
- Verdicts: `done|abandoned|blocked|needs-input|active`. Only confident
  `done`/`abandoned` close (sessions stay resumable; transcripts preserved).
  `blocked`/`needs-input` only get flagged, never closed.
- A judge error never closes anything. If many verdicts come back
  `active` confidence 0, the judge lane failed (check Jev key config
  `jev.apiKey` in ~/.agentproto/config.json, env `JEV_API_KEY` fallback).
- RAM freed / still held is summarized at the end.

## Session snapshot (browsing aid)

`scripts/sessions-snapshot.sh` dumps the 50 most recently active daemon agent
sessions to a markdown table — id, label, adapter, model, status, idle time,
parent, steward flag, outcome, last summary, plus the last steward run. It
reads the daemon's HTTP API (`GET /sessions`, `GET /workflows`) and writes a
generated file; it never mutates daemon state, so it is safe to run any time.

```bash
./scripts/sessions-snapshot.sh [out.md] [count]
# defaults: data/sessions-latest.md, 50
```

The output lands under `data/` (git-ignored — it is a regenerated snapshot,
never committed). Use it to eyeball what the steward is about to classify
before running with `--apply`.

## Rules

- The attention mode is read-only — safe to run any time; it never closes,
  flags, nudges or messages a session.
- NEVER run `--wrapup --apply` without explicit user go-ahead. Dry run first,
  show the report, then apply.
- Never judge the calling session — the CLI already excludes it.
- If a session is mid-turn, busy, or has background tasks, the wrap-up plan
  skips it; re-running later is fine and idempotent.
