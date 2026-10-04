---
name: Session Attention
id: session-attention
description: >-
  Read-only triage of every live session for its human owner: which ones need
  a reply, are blocked, stuck (looping/errored), done, superseded or merely
  parked — most urgent first, each with a one-line reason and an excerpt.
  Rules decide the certain cases; a cheap judge decides the ambiguous ones.
  Never closes or messages anything. Entry-based (see entry.mjs).
version: 0.1.0
entry: ./entry.mjs
inputs:
  idleMinutes:
    type: number
    description: Minutes since its last activity before a finished turn counts as waiting.
    default: 10
  judge:
    type: string
    description: Judge backend for ambiguous sessions — `agent` (default) or `rules` (no model).
    default: agent
  judgeModel:
    type: string
    description: >-
      Model for the judge. Default: the `judge.session` model role (repo
      agentproto.json `models` > daemon config `models` > built-in).
  maxJudged:
    type: number
    description: Most ambiguous sessions judged per run.
    default: 20
  maxSessions:
    type: number
    description: Most live sessions examined per run.
    default: 80
  maxChars:
    type: number
    description: Cap on the plain-text digest (chat delivery).
    default: 3500
  includeChildren:
    type: boolean
    description: Also triage executors whose supervisor is still live.
    default: false
  callerSessionId:
    type: string
    description: The calling session's id — never triaged.
  callerOrigin:
    type: string
    description: The calling session's origin (`cron:<jobId>`) — an older run of the SAME cron job is never triaged.
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
    description: Entry-based — resolveSettings.

  - id: liveSessions
    kind: tool
    name: List live sessions
    tool: session_list
    inputs:
      full: true
      onlyAlive: true
      limit: 200

  - id: scan
    kind: transform
    name: Pick the sessions worth a look
    description: Entry-based — scanSessions (drops the caller, archived, PTY, children of a live parent).

  - id: evidence
    kind: map
    name: Collect compact evidence per session
    over: $steps.scan.candidates
    parallelism: 6
    onError: collect
    steps:
      - id: evidenceOne
        kind: tool
        tool: session_evidence
        inputs:
          sessionId: $item.sessionId
      - id: evidenceFold
        kind: transform
        name: Classify one session by rules

  - id: entries
    kind: transform
    name: Sessions with evidence and a rule verdict
    description: Entry-based.

  - id: judgeQueue
    kind: transform
    name: Ambiguous sessions for the judge
    description: Entry-based — buildJudgeQueue.

  - id: judge
    kind: map
    name: One-shot judge per ambiguous session
    description: >-
      One turn of `@agentproto/session-attention-judge`, evidence in the
      prompt, strict JSON out. A malformed reply leaves the rules' verdict.
    over: $steps.judgeQueue
    parallelism: 3
    onError: collect
    steps:
      - id: judgeOne
        kind: agent
        agent:
          ref: "@agentproto/session-attention-judge"
        prompt: $item.prompt
      - id: judgeParse
        kind: transform
        name: Parse the judge's verdict

  - id: items
    kind: transform
    name: One digest item per session
    description: Entry-based — buildItems (rules, judge merged, idle-never-active guard).

  - id: digest
    kind: transform
    name: Build the prioritized digest (markdown + plain text)
    description: Entry-based — buildAttentionDigest.

result:
  report: $steps.digest.markdown
  text: $steps.digest.text
  counts: $steps.digest.counts
  items: $steps.digest.ordered
  scan: $steps.scan.counts
---

# Session Attention — `session-attention` workflow

`session_list` → `session_evidence` per live session → deterministic rules →
a one-shot judge for what stays ambiguous → a digest ordered by urgency.

## Verdicts

| verdict | meaning | urgency |
|---|---|---|
| `needs-reply` | it asked you something, or cannot continue without you | 90 |
| `stuck` | looping (same sentence / command), last turn errored, your message went unanswered, never ran | 85 / 75 |
| `blocked` | waiting on something external (token, CI, review, another session) | 70 |
| `done` + waiting on you | final report delivered, waiting on you to act (merge, deploy) | 60 |
| `parked` | idle, no question, no error, no conclusion — it just stopped | 45 |
| `done` | finished, nothing pending — can close | 30 |
| `superseded` | a newer session / continuation / PR covers the same work | 25 |
| `active` | busy now, or its turn ended a few minutes ago — no action | 0 |

An idle session whose last turn finished is **never** `active`: the rules never
answer it, the judge is not allowed to, and a final guard rewrites it to
`parked`.

## Rules (before any model)

Pure functions in `attention.mjs`, pinned by `session-attention.test.ts`:
repetition detection on the last assistant text (also works on idle sessions —
the old loop check only saw busy ones), errored last turn, `awaitingInput`,
`continuedTo`, merged PR, unanswered user message, question/ask phrases (EN/FR),
a recorded `done` outcome, blocker phrases, same-title newer sibling. Anything
under 0.9 confidence goes to the judge.

## Safety

Read-only: the only tools are `model_roles`, `session_list` and
`session_evidence`; the judge is told to call none. It never closes, flags,
nudges or messages a session and writes nothing — safe to run on a schedule.
