---
name: Session Steward
id: session-steward
description: >-
  Plan idle-session wrap-up (session_wrapup_plan), close the rule-certain
  `close`/`stuck` sessions, judge the ambiguous `judge` ones with a cheap
  one-shot model over compact evidence, optionally ask a session directly,
  then close or flag the confident verdicts with a recorded outcome — and
  report. Dry run unless `apply` is true. Entry-based (see entry.mjs): every
  decision between the tool calls is a real function (candidate split,
  strict verdict parse, confidence threshold, report).
version: 0.1.0
entry: ./entry.mjs
inputs:
  idleMinutes:
    type: number
    description: Idle threshold in minutes.
    default: 30
  apply:
    type: boolean
    description: Close/flag sessions. False = dry run (plan + verdicts, no mutation).
    default: false
  relabelWindowHours:
    type: number
    description: >-
      Only terminal sessions that ended within this many hours are listed as
      relabel candidates (at most 20, newest first).
    default: 24
  minConfidence:
    type: number
    description: Judge confidence needed to act on a verdict.
    default: 0.8
  judge:
    type: string
    description: >-
      Judge backend — `auto` (Jev when JEV_API_KEY resolves, else the agent
      judge), `jev`, or `agent`. A Jev failure always falls back to the agent
      judge for that session.
    default: auto
  jevModel:
    type: string
    description: Jev model.
    default: jev-latest
  judgeModel:
    type: string
    description: >-
      Model for the agent judge. Default: the `judge.session` model role
      (repo agentproto.json `models` > daemon config `models` > built-in).
  maxJudged:
    type: number
    description: Most `judge` sessions judged per run, most RAM first.
    default: 15
  askSessions:
    type: boolean
    description: >-
      Ask low-confidence idle sessions directly whether they're done. Off by
      default — it spends a turn in someone else's conversation.
    default: false
  callerSessionId:
    type: string
    description: The calling session's id — never a candidate.
  callerOrigin:
    type: string
    description: >-
      The calling session's origin (`cron:<jobId>`) — an older run of the
      SAME cron job is never judged as user work.
  appId:
    type: string
    description: >-
      Installed app whose `app_state` ledger holds the verdict memory.
      Default `@agentproto/session-steward` (the id in APP.md). A bare name
      also matches a scoped install; a missing app means no memory, noted in
      the report.
  stableVerdictPasses:
    type: number
    description: >-
      Consecutive passes on an unchanged evidence fingerprint before the
      judge cache stops re-judging a session.
    default: 2
  userOrigins:
    type: array
    description: >-
      Origins that are ALWAYS flag-only, never closed (a human is in the
      loop). A trailing `*` is a prefix wildcard. Default
      `["chat-starter", "vscode"]`; a root with no origin and no parent is
      treated as a user origin too.
    items:
      type: string
    default: ["chat-starter", "vscode"]
  closableOrigins:
    type: array
    description: >-
      Origins that may be closed under the current rules. A trailing `*` is a
      prefix wildcard. Default `["cron:*", "gate"]`. Executors (a session with
      a `parentSessionId`) are closable regardless.
    items:
      type: string
    default: ["cron:*", "gate"]
outputs: {}
steps:
  - id: modelRoles
    kind: tool
    name: Resolve the judge model role
    tool: model_roles
    inputs:
      roles:
        - judge.session
      inputs:
        judge.session: $input.judgeModel
  - id: settings
    kind: transform
    name: Resolve inputs with their defaults
    description: Entry-based — see entry.mjs's resolveSettings.

  - id: plan
    kind: tool
    name: Classify idle sessions (dry run)
    tool: session_wrapup_plan
    inputs:
      idleMinutes: $steps.settings.idleMinutes
      wait: true

  - id: candidates
    kind: transform
    name: Split close / stuck / judge, drop keep and the caller
    description: >-
      Entry-based — splitCandidates. `judge` is ordered most RAM first and
      capped at `maxJudged`.

  - id: hostLoad
    kind: tool
    name: Host saturation report (report only)
    tool: host_load
    inputs: {}

  - id: liveSessions
    kind: tool
    name: List live sessions for the mechanical scan
    tool: session_list
    inputs:
      full: true

  - id: scan
    kind: transform
    name: Scan live sessions (busy / idle / terminal / never-ran / excluded)
    description: Entry-based — scanLive.

  - id: candidatesPlus
    kind: transform
    name: Merge never-ran 0/0 sessions into stuck
    description: Entry-based — mergeNeverRan (never-ran is stuck, never judged).

  - id: ruleApplyQueue
    kind: transform
    name: Rule verdicts to apply
    description: >-
      Entry-based. Empty unless `apply`: `close` → done, `stuck` → abandoned.
      Origin-bounded — a user-origin candidate is queued as a `needs-input`
      FLAG instead of a close.

  - id: autoApply
    kind: map
    name: Close rule-certain sessions
    over: $steps.ruleApplyQueue
    parallelism: 1
    onError: collect
    steps:
      - id: autoApplyOne
        kind: tool
        tool: session_wrapup_apply
        inputs:
          sessionIds: [$item.sessionId]
          verdict: $item.verdict
          note: $item.note

  - id: installedApps
    kind: tool
    name: List installed apps (to resolve the memory app)
    tool: app_list
    inputs: {}

  - id: memoryApp
    kind: transform
    name: Resolve the installed app holding the verdict memory
    description: Entry-based — resolveMemoryApp. No such app ⇒ no memory + a report note.

  - id: memoryQueue
    kind: transform
    name: Memory read queue
    description: Entry-based. Empty when no installed memory app resolves.

  - id: memoryRead
    kind: map
    name: Read the verdict memory ledger (best-effort)
    over: $steps.memoryQueue
    parallelism: 1
    onError: collect
    steps:
      - id: memoryReadOne
        kind: tool
        tool: app_state_list
        inputs:
          appId: $item.appId
          stage: session-steward
          kinds: [note]
          limit: 500

  - id: memory
    kind: transform
    name: Fold verdict memory
    description: Entry-based — foldMemory.

  - id: loopScan
    kind: map
    name: Loop sanity per busy session
    over: $steps.scan.loopQueue
    parallelism: 4
    onError: collect
    steps:
      - id: loopCallsOne
        kind: tool
        tool: tool_calls_list
        inputs:
          sessionId: $item.sessionId
          lastN: 60
      - id: loopFold
        kind: transform
        name: Loop verdict for one session

  - id: loopResults
    kind: transform
    name: Loop verdicts
    description: Entry-based.

  - id: proposals
    kind: transform
    name: Nudge proposals (report only — never executed here)
    description: >-
      Entry-based — buildProposalsStep: loop → interrupt, stall → continue, at
      most one per session per pass; a user-origin session is observed only.

  - id: relabelQueue
    kind: transform
    name: Terminal sessions missing an outcome (relabel candidates)
    description: Entry-based — buildRelabelQueue. PR numbers come from the session row.

  - id: relabelEvidenceQueue
    kind: transform
    name: Relabel candidates that get an evidence lookup (the newest 20)
    description: Entry-based — buildRelabelEvidenceQueue.

  - id: relabelEvidence
    kind: map
    name: Worktree/PR state per listed relabel candidate
    over: $steps.relabelEvidenceQueue
    parallelism: 4
    onError: collect
    steps:
      - id: relabelEvidenceOne
        kind: tool
        tool: session_evidence
        inputs:
          sessionId: $item.sessionId

  - id: relabelFinal
    kind: transform
    name: Relabel proposals with their evidence
    description: Entry-based — applyRelabelEvidence (merged PR/worktree or opened PR → done).

  - id: evidence
    kind: map
    name: Collect compact evidence per judge candidate
    over: $steps.candidatesPlus.judge
    parallelism: 4
    onError: collect
    steps:
      - id: evidenceOne
        kind: tool
        tool: session_evidence
        inputs:
          sessionId: $item.sessionId

  - id: judgeQueue
    kind: transform
    name: Candidates with evidence minus the stable-verdict cache
    description: Entry-based — buildJudgeQueueFiltered.

  - id: jevQueue
    kind: transform
    name: Candidates for the Jev backend
    description: Entry-based. Empty when `judge` is `agent`.

  - id: jevJudge
    kind: map
    name: Jev judge per candidate
    description: >-
      One `session_judge_jev` call per candidate — a calibrated `choice` over
      the five verdicts with probabilities, state = the evidence. A missing
      key or any failure is `ok:false`, never an error, and that candidate
      goes to the agent judge.
    over: $steps.jevQueue
    parallelism: 4
    onError: collect
    steps:
      - id: jevOne
        kind: tool
        tool: session_judge_jev
        inputs:
          sessionId: $item.entry.sessionId
          evidence: $item.evidence
          model: $steps.settings.jevModel

  - id: agentJudgeQueue
    kind: transform
    name: Candidates Jev didn't answer
    description: Entry-based — buildAgentJudgeQueue.

  - id: judge
    kind: map
    name: One-shot agent judge per remaining candidate
    description: >-
      One turn of `@agentproto/session-steward-judge` on `judgeModel`, evidence
      in the prompt, strict JSON verdict out. A malformed reply is `active`
      with confidence 0. The judge session is released (killed + archived)
      when its item settles.
    over: $steps.agentJudgeQueue
    parallelism: 3
    onError: collect
    steps:
      - id: judgeOne
        kind: agent
        agent:
          ref: "@agentproto/session-steward-judge"
        prompt: $item.judgePrompt

  - id: verdicts
    kind: transform
    name: One verdict row per judged candidate
    description: Entry-based — collectVerdicts.

  - id: askQueue
    kind: transform
    name: Low-confidence idle sessions to ask directly
    description: Entry-based. Empty unless `askSessions`.

  - id: ask
    kind: map
    name: Ask the session itself (opt-in)
    description: >-
      One `agent_prompt` (queue:false), a bounded ~3 min `session_monitor`
      wait, then its newest assistant turn is parsed for `STEWARD: DONE` /
      `STEWARD: NOT-DONE`. See entry.mjs.
    over: $steps.askQueue
    parallelism: 2
    onError: collect
    steps:
      - id: askPrompt
        kind: tool
        tool: agent_prompt
        inputs:
          sessionId: $item.sessionId

  - id: finalVerdicts
    kind: transform
    name: Merge declared answers over judge verdicts
    description: Entry-based — mergeDeclared.

  - id: judgedApplyQueue
    kind: transform
    name: Confident verdicts to apply
    description: >-
      Entry-based. Empty unless `apply`: done/abandoned/blocked/needs-input at
      or above `minConfidence`. Origin-bounded — a user-origin candidate is
      downgraded to a `needs-input` FLAG, never a close.

  - id: judgedApply
    kind: map
    name: Close or flag judged sessions
    over: $steps.judgedApplyQueue
    parallelism: 1
    onError: collect
    steps:
      - id: judgedApplyOne
        kind: tool
        tool: session_wrapup_apply
        inputs:
          sessionIds: [$item.sessionId]
          verdict: $item.verdict
          judgedBy: $item.judgedBy
          note: $item.note

  - id: memoryWriteQueue
    kind: transform
    name: Verdict memory events to append
    description: Entry-based — buildMemoryWriteQueue (a ledger write, never a session action).

  - id: memoryWrite
    kind: map
    name: Append verdict memory to app_state (best-effort)
    over: $steps.memoryWriteQueue
    parallelism: 1
    onError: collect
    steps:
      - id: memoryWriteOne
        kind: tool
        tool: app_state_append
        inputs:
          appId: $item.appId
          event: $item.event

  - id: report
    kind: transform
    name: Build the markdown report
    description: Entry-based — buildReport.

result:
  report: $steps.report
  apply: $steps.settings.apply
  candidates: $steps.candidatesPlus
  verdicts: $steps.finalVerdicts
  autoApply: $steps.autoApply
  judgedApply: $steps.judgedApply
  proposals: $steps.proposals
  relabel: $steps.relabelFinal
  scan: $steps.scan
---

# Session Steward — `session-steward` workflow

`session_wrapup_plan` → deterministic mechanical pass (host saturation, loop /
stall / never-ran / terminal-relabel scan, verdict memory) → rules pass over
`close`/`stuck` → compact evidence per `judge` session → one cheap judge turn
each (cached when the evidence is unchanged) → (opt-in) ask the session itself
→ close or flag confident verdicts through `session_wrapup_apply` → markdown
report with proposals, relabel candidates, and RAM freed / still held.

## Mechanical rules (ported from the `kill-idle-sessions` cron prototype)

Every rule below is a pure function in `cron-rules.mjs`, pinned by
`session-steward-cron-rules.test.ts`:

- **Loop (1).** `tool_calls_list` per busy session: the same argv verbatim ≥3
  in 10 min, distinct/total < 0.2, or the same file read ≥4 → `looping`, a
  sub-case of `active`. The proposed action is an **interrupt nudge**, never a
  close. Useful loops (watch, test/type-check re-runs, `git status`, `gh pr`
  polling) are excluded.
- **Stall (2).** Busy > 20 min with no new activity, or a recent
  `lastTurnErroredAt` on an idle process → a proposed **"continue" nudge**.
- **Never-ran (3).** `tokensIn === 0 && tokensOut === 0` → `stuck`
  without a judge, but only when the session is not busy, not
  starting/provisioning, has no queued first prompt, and is both older
  (`startedAt`) and idler (`lastActivityAt`) than `idleMinutes`. A young or
  just-started session is not flagged.
- **Fast-path done (4).** Last tool call is `message_parent(kind:done)` plus a
  commit/PR → `done` without a judge (used by the criteria, see below).
- **Terminal without outcome (5).** Terminal sessions missing an outcome that
  ended within `relabelWindowHours` (default 24) are surfaced as relabel
  candidates instead of staying invisible. The report lists at most 20,
  newest first, with a per-label count and an "… and N more" line.
- **Re-check at apply (6).** A candidate that became busy before the apply is
  skipped (the apply tool also re-classifies).
- **Self-exclusion (7).** An older run of the caller's own `cron:<job>` is
  never judged as user work.
- **Explicit 0-candidate report (8).** When nothing is idle, the report says
  why (`n live, m busy, k terminal, j excluded`).
- **Host saturation (9).** If `host_load` is critical, the report lists
  orphans and big non-session processes FIRST — report only, no action.
- **Verdict memory (10).** Each verdict is written to the app's `app_state`
  ledger; a session judged the same verdict on an unchanged evidence
  fingerprint for `stableVerdictPasses` passes is served from cache and not
  re-judged. Operator disagreements are recorded as examples.

The proposed nudges (interrupt / continue) are **reported only** — this
workflow never sends a prompt and never closes a `looping` session. At most
one nudge is proposed per session per pass; a user-origin session is reported
as observed, never nudged.

## Safety

- `apply: false` (the default) mutates no SESSION: every session-mutating map
  runs over an empty list. The one write a dry run performs is the append-only
  verdict-memory ledger (`app_state_append`) — it never touches a session and
  is what lets the cache accumulate across passes. Set `appId: ""` to disable
  it entirely.
- `session_wrapup_apply` re-classifies each id right before acting and always
  refuses `keep`-class ids; this workflow never feeds it one.
- Rules only ever close `close`/`stuck` ids; a `keepAlive` session is never
  in those classes, so only a confident judge verdict (with `judgedBy`) can
  close it — as FIX-9A allows.
- A malformed judge reply is `active` with confidence 0 — never acted on.
- The caller's own session (`callerSessionId`) is dropped from every list.
- `blocked` / `needs-input` only FLAG a session; it keeps running.
- **Origin bound (never close a human's session).** Every candidate's
  `origin`/`parentSessionId` runs through the pure `decideAction`
  (`origin-policy.mjs`): a `userOrigins` match (`chat-starter`, `vscode` by
  default) or a root with no origin and no parent is FLAG-ONLY, even with
  `apply: true` and a confident `done` verdict. `cron:*`, `gate`, and
  executors (a session with a `parentSessionId`) stay closeable. Both lists
  are workflow inputs; a trailing `*` is a prefix wildcard.
- The report carries an `origin` column and the retained action (e.g.
  `flag (origine utilisateur)`), in dry run as well as apply.

## The judge

Two backends. **Jev** (TypeSafe System One, `session_judge_jev`) is the
default whenever `JEV_API_KEY` resolves (daemon env, else the host secret
resolver): one calibrated `choice` over the five verdicts; confidence is the
chosen verdict's probability, the full probabilities go in the report, and
`judgedBy` is `jev:<model>`. Any Jev failure (no key under `judge: jev`, a
non-2xx after retries, a malformed answer) falls back to the agent judge for
that session and the report says so — a Jev error never closes anything.

The **agent judge**:

`@agentproto/session-steward-judge` answers from the evidence in its prompt
and is told not to call tools. Its gateway mount is scoped to the one
read-only `session_evidence` tool: declaring no `tools:` at all would mount
the FULL daemon gateway for a claude-code judge (the host's default).
