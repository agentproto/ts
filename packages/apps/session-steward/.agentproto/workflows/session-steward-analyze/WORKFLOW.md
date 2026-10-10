---
name: "Session Steward — analyze"
id: session-steward-analyze
description: "Read the relevant sessions of a classify snapshot (action not `keep`, low confidence, or selected) and record why: the failure/completion reason, the open question, the error kind, the next step and a relaunch hint. May revise the recommended action (the classify verdict is kept alongside). Writes the result back into the same snapshot. Never closes, kills or archives anything."
version: 0.1.0
entry: ./entry.mjs
inputs:
  idleMinutes: {"type":"number","description":"Idle threshold in minutes. Default 30.","default":30}
  minConfidence: {"type":"number","description":"Confidence needed to act on a verdict. Default: the snapshot's own (0.8)."}
  relaunchWindowMinutes: {"type":"number","description":"A failed session is only recommended for `relaunch` when it failed within this many minutes (older: `mark-failed`). Default 360. Rules key: `failedMinutesAgo`.","default":360}
  relabelWindowHours: {"type":"number","description":"Ended sessions that finished within this many hours are classified (outcome labels). Default 24.","default":24}
  rules: {"type":"object","description":"Custom rules, already parsed (`{version:1, rules:[…]}` or a bare list). First match wins, then the defaults. Validated; unknown keys are errors."}
  rulesSource: {"type":"string","description":"Where `rules` came from (a file path), for the report."}
  userOrigins: {"type":"array","description":"Origins that are always flag-only, never closed. Default chat-starter, vscode.","items":{"type":"string"}}
  closableOrigins: {"type":"array","description":"Origins the steward may close (harness / scheduler stamps). Trailing `*` is a prefix wildcard.","items":{"type":"string"}}
  callerSessionId: {"type":"string","description":"The calling session's id — never a candidate."}
  callerOrigin: {"type":"string","description":"The calling session's origin (`cron:<jobId>`)."}
  appId: {"type":"string","description":"Installed app whose data dir persists the snapshots. Default @agentproto/session-steward."}
  persist: {"type":"boolean","description":"Write the snapshot to the app data dir (`snapshots/latest.json`). Default true.","default":true}
  history: {"type":"boolean","description":"Also keep `snapshots/<id>.json`. Default true; the hourly routine sets false (latest only).","default":true}
  returnSnapshot: {"type":"boolean","description":"Include the whole snapshot in the run output (the CLI's --json). Default false: only counts + the report.","default":false}
  showKeep: {"type":"boolean","description":"List `keep` rows in the report too. Default false (count only).","default":false}
  snapshot: {"type":"string","description":"Snapshot id, or `latest` (default).","default":"latest"}
  snapshotData: {"type":"object","description":"A whole snapshot passed inline (skips the app data read)."}
  only: {"type":"array","description":"Analyse only rows whose recommended action is one of these.","items":{"type":"string"}}
  sessions: {"type":"array","description":"Analyse exactly these session ids (even a `keep` row).","items":{"type":"string"}}
  judge: {"type":"string","description":"`agent` (default: one-shot analyst agent) or `jev` (no LLM spend: structured heuristic reasons from the evidence).","default":"agent"}
  maxSessions: {"type":"number","description":"Most sessions analysed per run. Default 20.","default":20}
  judgeModel: {"type":"string","description":"Model for the analyst agent. Default: the `judge.session` model role."}
outputs: {}
steps:
  - id: modelRoles
    kind: tool
    name: "Resolve the analyst model role"
    tool: model_roles
    inputs: {"roles":["judge.session"],"inputs":{"judge.session":"$input.judgeModel"}}

  - id: settings
    kind: transform
    name: "Resolve inputs with their defaults"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: rules
    kind: transform
    name: "Validate the custom rules (defaults when none)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: installedApps
    kind: tool
    name: "Installed apps"
    tool: app_list
    inputs: {}

  - id: memoryApp
    kind: transform
    name: "App holding the snapshots"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: snapshotQueue
    kind: transform
    name: "Which snapshot file to read"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: snapshotRead
    kind: map
    name: "Read the snapshot from the app data dir"
    over: "$steps.snapshotQueue"
    parallelism: 1
    onError: collect
    steps:
      - id: snapshotReadOne
        kind: tool
        name: "snapshot read one"
        tool: app_data_read
        inputs: {"appId":"$item.appId","path":"$item.path"}

  - id: loaded
    kind: transform
    name: "The snapshot to work on (inline or read)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: analysisSelection
    kind: transform
    name: "Relevant sessions (action not keep, low confidence, or selected)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: analysisEvidence
    kind: map
    name: "Evidence per selected session"
    over: "$steps.analysisSelection.queue"
    parallelism: 4
    onError: collect
    steps:
      - id: analysisEvidenceOne
        kind: tool
        name: "analysis evidence one"
        tool: session_evidence
        inputs: {"sessionId":"$item.sessionId"}
      - id: analysisEvidenceFold
        kind: transform
        name: "analysis evidence fold"
        description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: analysisPrompts
    kind: transform
    name: "Analyst prompt per session (agent mode)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: analyst
    kind: map
    name: "One-shot analyst agent per session"
    over: "$steps.analysisPrompts"
    parallelism: 3
    onError: collect
    steps:
      - id: analystOne
        kind: agent
        name: "analyst one"
        agent:
          ref: "@agentproto/session-steward-analyst"
        prompt: "$item.prompt"
      - id: analystParse
        kind: transform
        name: "analyst parse"
        description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: analyzed
    kind: transform
    name: "Write reasons into the snapshot (may revise the action)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: persistQueue
    kind: transform
    name: "Snapshot files to write"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: persist
    kind: map
    name: "Write snapshots/latest.json (+ snapshots/<id>.json)"
    over: "$steps.persistQueue"
    parallelism: 1
    onError: collect
    steps:
      - id: persistOne
        kind: tool
        name: "persist one"
        tool: app_data_write
        inputs: {"appId":"$item.appId","path":"$item.path","content":"$steps.analyzed"}

  - id: report
    kind: transform
    name: "Build the markdown report"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: summary
    kind: transform
    name: "Small run output"
    description: "Entry-based — see entry.mjs / two-step.mjs."

result:
  report: "$steps.report"
  summary: "$steps.summary"
---

# Session Steward — analyze — `session-steward-analyze` workflow

Read the relevant sessions of a classify snapshot (action not `keep`, low confidence, or selected) and record why: the failure/completion reason, the open question, the error kind, the next step and a relaunch hint. May revise the recommended action (the classify verdict is kept alongside). Writes the result back into the same snapshot. Never closes, kills or archives anything.

See `../session-steward/two-step.mjs` for the step functions and `../session-steward/actions.mjs` for the pure rules/snapshot library. CLI: `agentproto steward classify | analyze | act` (see `docs/cli/verbs/steward.md`).
