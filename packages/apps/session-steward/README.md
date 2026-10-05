# Session Steward

A built-in agentproto app that wraps up idle agent sessions. It sits on top
of the runtime's `session_wrapup_plan` / `session_wrapup_apply` tools
(FIX-9A) and adds the missing loop: a cheap judge for the ambiguous
sessions. Hand-authored bundle (`.agentproto/APP.md` + `agents/` +
`workflows/`), like `repo-maintenance` — the workflow's decisions (candidate
split, strict verdict parse, confidence threshold, report) are real
functions in `workflows/session-steward/entry.mjs`, which only the `entry:`
loader path can carry.

## What one run does

1. `plan` — `session_wrapup_plan { idleMinutes }` (dry run).
2. `autoApply` (only with `apply`) — `close` ids →
   `session_wrapup_apply { verdict: "done", note: "steward-rules: …" }`,
   `stuck` ids → `{ verdict: "abandoned" }` — unless the session is
   user-origin, which is flagged instead (see Origin policy).
3. `evidence` — per `judge` candidate (at most `maxJudged`, most RAM first),
   the read-only `session_evidence` tool: label, cwd, idle, keepAlive, RAM,
   the plan's signals, the last ~10 turns (~3 KB), and worktree
   branch/dirty/ahead/behind/PR. Under ~5 KB per session.
4. `judge` — per candidate, backend picked by `judge` (default `auto`):
   - **Jev** (`auto` when `JEV_API_KEY` resolves — daemon env, else the host
     secret resolver — or `judge: "jev"`): one `session_judge_jev` call, a
     calibrated `choice` over the five verdicts with the evidence as state;
     confidence = the chosen verdict's probability, full probabilities in the
     report, `judgedBy: jev:<jevModel>`.
   - **Agent** (`judge: "agent"`, `auto` without a key, or any Jev failure
     for that session — reported as such): one turn of
     `@agentproto/session-steward-judge` on `judgeModel` (default: the `judge.session` model role — explicit input > repo `agentproto.json` `models` > daemon config `models` > built-in sonnet; see `model_roles`),
     strict JSON verdict. A malformed reply is `active`, confidence 0. The
     judge session is released (killed + archived) when its item settles.
   Verdicts: `done|abandoned|blocked|needs-input|active`. A judge error never
   closes anything.
5. `ask` (only with `askSessions`) — low-confidence, idle, non-keepAlive,
   not-awaiting-input sessions get ONE prompt asking them to reply
   `STEWARD: DONE …` / `STEWARD: NOT-DONE …`; a ~3 min bounded wait; the
   answer becomes a `declared` verdict.
6. `judgedApply` (only with `apply`) — confident `done`/`abandoned` close
   (resumable, with a recorded outcome); confident `blocked`/`needs-input`
   only flag. Everything else is left alone and reported.
7. `report` — markdown table (class, session, origin, idle, RAM, verdict,
   confidence, reason, action) plus RAM freed / still held.

## Origin policy (never close a human's session)

Every candidate's `origin`/`parentSessionId` runs through the pure
`decideAction` (`workflows/session-steward/origin-policy.mjs`), configured by
the `userOrigins` / `closableOrigins` inputs:

- **Flag only, never close:** `chat-starter`, `vscode`, and any root with no
  `origin` and no `parentSessionId` (a human launched it). A would-be close —
  even a rule-certain `close`/`stuck`, even a confident `done` — is recorded
  as a `needs-input` flag with reason `flag (origine utilisateur)`.
- **Close allowed:** `cron:*`, `gate`, and executors (a session with a
  `parentSessionId`).

A trailing `*` in either list is a prefix wildcard. The report carries the
origin column and the retained action in dry run as well as apply.

## Running it

```bash
agentproto steward --wait                     # dry run: plan + verdicts, report
agentproto steward --apply --wait             # close / flag confident verdicts
agentproto steward --apply --idle 60 --min-confidence 0.9 --judge agent
agentproto steward --ask-sessions --wait      # also ask low-confidence sessions
```

`agentproto steward` installs (upserts) this app and starts the workflow via
`workflow_run_file`; it passes `AGENTPROTO_SESSION_ID` as `callerSessionId`
so a run never judges the session that started it. Or call the daemon
directly:

```bash
agentproto app install packages/apps/session-steward
agentproto workflow run-file \
  packages/apps/session-steward/.agentproto/workflows/session-steward/WORKFLOW.md \
  --input-json '{"apply": false}'
```

## Routine

`routines/session-steward-hourly` is an AIP-41 `ROUTINE.md` template: hourly,
`apply: true`, `askSessions: false`, shipped `enabled: false` — nothing
starts closing sessions on install. Its own doc lists the enabling steps.
