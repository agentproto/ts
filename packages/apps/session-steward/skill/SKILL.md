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

Prefer the CLI (it installs/updates the app and runs the workflow). Three
steps, each usable alone, all reading/writing one persisted snapshot:

```bash
agentproto steward                      # 1. classify: rules + Jev, ONE action per session
agentproto steward analyze              # 2. LLM reasons for the relevant rows only
agentproto steward act latest           # 3. dry run of the planned actions
agentproto steward act latest --apply   #    …perform them
agentproto steward --apply              # one-shot: classify + act
```

Variants:

```bash
agentproto steward classify --llm                       # classify, then analyze
agentproto steward act latest --rules my-rules.yaml     # custom rules (auto-loads ./.agentproto/steward-rules.yaml)
agentproto steward act latest --only mark-failed,needs-input --apply
agentproto steward act latest --session sess_a,sess_b
agentproto steward --legacy --apply --idle 60           # the original single-run steward
```

Actions: `keep | mark-complete | mark-failed | relaunch | needs-input |
close-abandoned | archive` (`relaunch` / `archive` only when named in
`--only`). `act` skips a session that changed since the snapshot and never
closes a user-origin session (it flags it). Each command blocks until the
report is printed; `--no-wait` returns the runId, `--json` prints the output.

## Read the report

The final step output is a markdown table: class (close/stuck/judge),
session label + id, idle time, RAM, verdict, confidence, reason, action.
Key reading rules:

- `close` rows are safe to auto-close; `judge` rows are what the judge saw.
- Classify rows carry the typed verdict and its probabilities
  (`p: active=0.84 blocked=0.08 …`); analyze adds the free-text reason.
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

- NEVER run with `--apply` without explicit user go-ahead. Classify, dry-run
  `act`, show the report, then apply.
- Never judge the calling session — the CLI already excludes it.
- If a session is mid-turn, busy, or has background tasks, the plan skips
  it; re-running later is fine and idempotent.
