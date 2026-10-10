---
schema: routine/v1
id: session-steward-hourly
description: |
  Hourly pass of the snapshot path: `session-steward-classify` with
  `apply: true` (classify, then act on the fresh snapshot). Rules + Jev's typed
  verdict pick ONE action per session; the act half closes rule-certain and
  confident-verdict sessions as done / failed / abandoned with a recorded
  outcome, flags the ones that need a human, and labels recently ended
  sessions. `relaunch` and `archive` stay opt-in (not run by this routine).
  Only the latest snapshot is kept. Ships DISABLED (`enabled: false`) —
  nothing starts closing sessions on install; install it into a workspace's
  `.routines/` and flip `enabled: true` to activate.
version: "2.0.0"
schedule:
  kind: cron
  cron: "0 * * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: <absolute-path-to-agentproto-ts>/packages/apps/session-steward/.agentproto/workflows/session-steward-classify/WORKFLOW.md
  inputs:
    apply: true
    # Scheduled run: keep only snapshots/latest.json, not one file per run.
    history: false
    # Custom rules (optional): pass an already-parsed object, e.g.
    #   rules: { version: 1, rules: [{ id: bench, when: { origin: model-bench }, action: close-abandoned }] }
    # Origin policy (the committed default): never close a human's session.
    # `chat-starter`/`vscode` (and any root with no origin and no parent) are
    # FLAG-ONLY; every machine stamp (`cron*`, `routine:*`, `gate`, `workflow`,
    # `review`, `webhook`, `model-bench*`) and executors (a session with a
    # parentSessionId) stay closeable. A trailing `*` is a prefix wildcard.
    userOrigins: ["chat-starter", "vscode"]
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

# Session steward — hourly (snapshot path)

Runs every hour on the hour (UTC), firing `session-steward-classify`
(`../../.agentproto/workflows/session-steward-classify/WORKFLOW.md`) with
`apply: true`. Every run:

1. **Classifies** the live and recently ended sessions at one instant: the
   daemon's rule plan (`session_wrapup_plan`) plus Jev's typed verdict and
   probabilities (when `JEV_API_KEY` resolves; without it the judge-class
   sessions simply get no verdict and stay `keep`). Each session gets ONE
   recommended action (`keep | mark-complete | mark-failed | relaunch |
   needs-input | close-abandoned | archive`) and the snapshot is written to the
   app's data dir (`snapshots/latest.json`).
2. **Acts** on that snapshot: re-checks every session against the live
   registry (a session that changed since is skipped), applies the rules
   (a `.agentproto/steward-rules.yaml` is NOT read by a routine — pass `rules`
   inline), bounds by origin, and runs the daemon verbs with the outcome fields
   recorded (`outcome`, `reason`, `errorKind`, `by: steward-rules|jev`).

The LLM `analyze` step is not part of the hourly run; run
`agentproto steward analyze` by hand when you want the reasons written.

`keep`-class sessions, the caller's own session, and anything busy or
awaiting input are never touched (`session_wrapup_apply` re-checks every id
right before acting).

## Origin policy

Every action is bounded by the candidate's `origin` (pure `boundByOrigin`,
`workflows/session-steward/actions.mjs`):

- **Flag only, never close:** `chat-starter`, `vscode`, and any root with no
  `origin` and no `parentSessionId` (a human launched it). A would-be close
  becomes a `needs-input` flag.
- **Close allowed:** every machine stamp — `cron` / `cron:*`, `routine:*`,
  `gate`, `workflow`, `review`, `webhook`, `model-bench*` (incl. its smoketest)
  — and executors (a session with a `parentSessionId`). `closableOrigins`
  overrides this list.

`userOrigins` is a workflow input (the committed default is above).

## Enabling

1. Run it by hand first and read the reports:
   `agentproto steward` (classify, prints the table), `agentproto steward act
   latest` (dry run), then `agentproto steward act latest --apply`.
2. Copy this directory to `<workspace>/.routines/session-steward-hourly/`.
3. Set `enabled: true` and point `target.workflow.file` at wherever
   `session-steward-classify/WORKFLOW.md` lives in that environment.
4. Optional: set `JEV_API_KEY` in the daemon's environment to judge with Jev.
5. Reload routines, or fire it once via `routine_trigger`.

## Failure routing

One attempt, then `on_failure` opens a work item and fires
`session-steward.hourly.failed`. A clean run fires
`session-steward.hourly.completed`.
