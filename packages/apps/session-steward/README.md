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
5. `ask` (only with `askSessions`) — low-confidence, idle, not-awaiting-input
   sessions get ONE prompt asking them to reply
   `STEWARD: DONE …` / `STEWARD: NOT-DONE …`; a ~3 min bounded wait; the
   answer becomes a `declared` verdict. `keepAlive` only re-lights a session
   after a daemon restart, so it does not exempt one from the ask: a keepAlive
   session whose worktree is merged or clean (nothing uncommitted, nothing
   ahead of base; no worktree info counts as not clean) is asked too. Closing
   is an active act: an on-demand run (`agentproto steward --ask-sessions`)
   adds no idle delay beyond `--idle`. Only a scheduled run (`recurring: true`,
   as the hourly routine sets) waits `keepAliveAskAfterMinutes` (default 1440,
   24 h; 0 turns it off), so a session you meant to resume is not closed
   overnight.
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
- **Close allowed:** every origin a harness or scheduler stamps — `cron` /
  `cron:*`, `routine:*`, `gate`, `workflow` (step sessions), `review`
  (reviewer lanes), `webhook`, `model-bench*` (the bench harness and its
  smoketest) — and executors (a session with a `parentSessionId`).

A trailing `*` in either list is a prefix wildcard. The report carries the
origin column and the retained action in dry run as well as apply.

## Remaining work (never close a session that still owes something)

A merged worktree, an open or merged PR, or an ended parent says the work
moved on — not that *this* session finished. Before any rule or judged
`close`, `decideFor` (`entry.mjs`) runs `remainingWork`
(`cron-rules.mjs`) over the plan entry's `lastAssistantTail` and
`worktreePrOpen` signals. A last message that asks a question, proposes a
next step, announces its next action ("Now drive it…"), recommends something, or waits on someone — or a still-open
worktree PR — turns the close into a `needs-input` flag whose note quotes the
session's own last words (`flag (remaining work: …)`). Only a clean final
report closes. Exceptions: a `stuck` session (it never ran) and a session that
itself declared `STEWARD: DONE`. Not covered yet: red CI and unanswered review
comments (the daemon exposes neither).

The terminal-session relabel (report only) follows the same principle: `done`
only when the session's *own* recorded PR is merged and nothing is pending; an
open PR or pending work is `needs-follow-up`; a worktree PR the session never
recorded (shared worktree) credits nobody. PRs are reported as `owner/repo#N`.

## Two steps, one snapshot (classify → analyze → act)

Besides the single-run workflow above (`--legacy`), the app ships the steward
as three workflows that share one persisted snapshot
(`snapshots/latest.json` in the app's data dir; `snapshots/<id>.json` too
unless `history: false`):

| Step | Workflow | Cost | Writes |
|------|----------|------|--------|
| `classify` | `session-steward-classify` | rules + Jev only, no agent LLM | per session: state, evidence summary, typed verdict + probabilities, confidence, ONE recommended action |
| `analyze` | `session-steward-analyze` | one analyst turn per *relevant* session (capped) | `reason`, `question`, `errorKind`, `nextStep`, `relaunchHint`, evidence refs; may revise the action |
| `act` | `session-steward-act` | daemon verbs only | the outcome (`outcome`, `reason`, `question`, `errorKind`, `nextStep`, `by`) on each session record |

The closed action vocabulary: `keep | mark-complete | mark-failed | relaunch |
needs-input | close-abandoned | archive`. `mark-complete` still runs the
remaining-work check; `relaunch` is for transient causes (continue vs
restart, and a suggested non-exhausted sub-account of the same provider —
never a paid fallback for a free-only model); `relaunch` and `archive` run
only when named in `--only` (`--allow-relaunch` also unlocks relaunch).

`act` re-reads each session right before acting and skips the ones that
*changed since the snapshot*; it bounds every action by origin (a user-origin
session is never closed, only flagged). Rules are data — the default policy
plus an optional custom file (`.agentproto/steward-rules.yaml`, or
`--rules <file>`), first match wins:

```yaml
version: 1
rules:
  - id: bench-leftovers
    when: { origin: "model-bench*", idleMinutes: ">=60" }
    action: close-abandoned
    reason: bench harness leftover
  - id: leave-my-research-alone
    when: { cwd: "**/research/**" }
    action: skip
  - id: quota-relaunch
    when: { errorKind: quota }
    action: relaunch
```

Keys under `when` (all must match): globs `origin`, `label`, `cwd`, `model`,
`profile`; enums `class` (held|close|stuck|judge|terminal|archive), `state`
(live|ended), `verdict`, `errorKind`, `action`, `originClass`; numbers
`idleMinutes`, `confidence` (`120`, `">=120"`, `"10..60"`); booleans
`transient`, `errored`, `neverRan`, `remainingWork`, `confident`. Rule keys:
`id`, `when`, `action` (an action or `skip`), `reason`. Unknown keys are
validation errors, reported in the run output.

None of these steps puts the session list in a workflow step output: every
`session_list` read is a projected (`fields`), filtered, paged query, and the
snapshot lives in the app data dir, not in the run record.

## Running it

```bash
agentproto steward                            # classify: table by action + snapshot id
agentproto steward analyze                    # LLM reasons for the relevant rows
agentproto steward act latest                 # dry run of the default rules
agentproto steward act latest --rules my.yaml # …with a custom rules file
agentproto steward act latest --apply --only mark-failed,needs-input
agentproto steward --apply                    # one-shot: classify + act
agentproto steward --legacy --apply --idle 60 --min-confidence 0.9 --judge agent
agentproto steward --legacy --ask-sessions --wait   # also ask low-confidence sessions
```

`agentproto steward` installs (upserts) this app and starts the workflow via
`workflow_run_file`; it passes `AGENTPROTO_SESSION_ID` as `callerSessionId`
so a run never judges the session that started it. Or call the daemon
directly:

```bash
agentproto app install packages/apps/session-steward
agentproto workflow run-file \
  packages/apps/session-steward/.agentproto/workflows/session-steward-classify/WORKFLOW.md \
  --input-json '{}'
```

## Routine

`routines/session-steward-hourly` is an AIP-41 `ROUTINE.md` template: hourly
`session-steward-classify` with `apply: true` (classify + act on the fresh
snapshot, latest only), shipped `enabled: false` — nothing starts closing
sessions on install. Its own doc lists the enabling steps.
