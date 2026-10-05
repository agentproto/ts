---
schema: routine/v1
id: session-steward-hourly
description: |
  Hourly APPLY pass of the `session-steward` workflow — `apply: true`,
  `askSessions: false`: closes rule-certain idle sessions (`close`/`stuck`),
  judges the ambiguous ones (Jev when JEV_API_KEY resolves, else the one-shot
  agent judge), and closes or flags confident verdicts with a recorded,
  resumable outcome. Never asks a session anything. Ships DISABLED
  (`enabled: false`) — nothing starts closing sessions on install; install it
  into a workspace's `.routines/` and flip `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 * * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: <absolute-path-to-agentproto-ts>/packages/apps/session-steward/.agentproto/workflows/session-steward/WORKFLOW.md
  inputs:
    apply: true
    askSessions: false
    # Origin policy (the committed default): never close a human's session.
    # `chat-starter`/`vscode` (and any root with no origin and no parent) are
    # FLAG-ONLY; `cron:*` jobs, `gate` sessions, and executors (a session with
    # a parentSessionId) stay closeable. A trailing `*` is a prefix wildcard.
    userOrigins: ["chat-starter", "vscode"]
    closableOrigins: ["cron:*", "gate"]
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: session-steward.hourly.failed
fires_events:
  - session-steward.hourly.completed
  - session-steward.hourly.failed
enabled: false
tags: [session-steward, sessions, maintenance]
---

# Session steward — hourly apply

Runs every hour on the hour (UTC), firing the `session-steward` workflow
(`../../.agentproto/workflows/session-steward/WORKFLOW.md`) with
`apply: true` and `askSessions: false`. Every run:

1. Plans with `session_wrapup_plan` (idle ≥ 30 min by default).
2. Closes `close`-class sessions as `done` and `stuck`-class ones as
   `abandoned` — resumable, with a recorded outcome — **unless the session is
   user-origin** (`chat-starter`, `vscode`, or a root with no origin and no
   parent), which is flagged instead.
3. Judges up to 15 `judge`-class sessions, most RAM first, and closes
   (`done`/`abandoned`) or flags (`blocked`/`needs-input`) only verdicts at
   confidence ≥ 0.8. Everything else is left alone and reported.

`keep`-class sessions, the caller's own session, and anything busy or
awaiting input are never touched (`session_wrapup_apply` re-checks every id
right before acting).

## Origin policy

The steward bounds every action by the candidate's `origin` (pure
`decideAction`, `workflows/session-steward/origin-policy.mjs`):

- **Flag only, never close:** `chat-starter`, `vscode`, and any root with no
  `origin` and no `parentSessionId` (a human launched it). A would-be close —
  even a rule-certain `close`/`stuck`, even a confident `done` — becomes a
  `needs-input` flag with reason `flag (origine utilisateur)`.
- **Close allowed:** `cron:*` (any cron job), `gate`, and executors (a
  session with a `parentSessionId`).

Both lists are workflow inputs (`userOrigins`, `closableOrigins`); the values
above are the committed default. A trailing `*` is a prefix wildcard.

## Enabling

1. Run it by hand first and read the reports:
   `agentproto steward --wait` (dry run), then `agentproto steward --apply --wait`.
2. Copy this directory to `<workspace>/.routines/session-steward-hourly/`.
3. Set `enabled: true` and point `target.workflow.file` at wherever
   `session-steward/WORKFLOW.md` lives in that environment.
4. Optional: set `JEV_API_KEY` in the daemon's environment to judge with Jev.
5. Reload routines, or fire it once via `routine_trigger`.

## Failure routing

One attempt, then `on_failure` opens a work item and fires
`session-steward.hourly.failed`. A clean run fires
`session-steward.hourly.completed`.
