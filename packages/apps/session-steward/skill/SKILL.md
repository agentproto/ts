---
name: session-steward
description: Wrap up idle agentproto agent sessions — classify them, close the safe ones, judge the ambiguous ones. Use when the user says "clean up idle sessions", "run the steward", "close finished sessions", or asks which sessions are still needed. Dry run by default; closing (--apply) mutates daemon state.
---

# Session Steward

The steward wraps up idle agent sessions. It classifies them with
`session_wrapup_plan`, closes the rule-certain ones, and sends the ambiguous
ones through a cheap judge (Jev classifier, fallback: a one-shot LLM agent).
Dry run by default — nothing is closed unless `--apply`.

## Run it

Prefer the CLI (it installs/updates the app and runs the workflow):

```bash
agentproto steward --wait
```

Variants:

```bash
agentproto steward --wait                          # dry run: plan + verdicts + report
agentproto steward --apply --wait                  # close/flag confident verdicts
agentproto steward --apply --wait --idle 60        # stricter idle threshold (minutes)
agentproto steward --apply --wait --min-confidence 0.9
agentproto steward --apply --wait --judge agent    # force the LLM judge lane
agentproto steward --ask-sessions --wait           # ask low-confidence sessions directly
```

`--wait` blocks until the report is ready (a run takes ~1-3 min depending on
candidate count). Without it, poll with `workflow_status` on the returned
runId.

## Read the report

The final step output is a markdown table: class (close/stuck/judge),
session label + id, idle time, RAM, verdict, confidence, reason, action.
Key reading rules:

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

- NEVER run with `--apply` without explicit user go-ahead. Dry run first,
  show the report, then apply.
- Never judge the calling session — the CLI already excludes it.
- If a session is mid-turn, busy, or has background tasks, the plan skips
  it; re-running later is fine and idempotent.
