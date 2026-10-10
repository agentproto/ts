---
name: "Session Steward — act"
id: session-steward-act
description: "Act on a classify/analyze snapshot: re-check each session against the live registry (a session that changed since the snapshot is skipped, not touched), apply the rules (custom file first, then the defaults), bound by origin (a user-origin session is never closed), and run the resulting daemon verbs with the outcome fields recorded. Dry run unless `apply` is true."
version: 0.1.0
entry: ./entry.mjs
inputs:
  idleMinutes: {"type":"number","description":"Idle threshold in minutes. Default 30.","default":30}
  minConfidence: {"type":"number","description":"Confidence needed to act on a verdict. Default: the snapshot's own (0.8)."}
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
  apply: {"type":"boolean","description":"Perform the planned actions. Default false = dry run.","default":false}
  only: {"type":"array","description":"Restrict to these actions (keep | mark-complete | mark-failed | relaunch | needs-input | close-abandoned | archive). `relaunch` and `archive` only run when named here.","items":{"type":"string"}}
  sessions: {"type":"array","description":"Restrict to these session ids.","items":{"type":"string"}}
  allowRelaunch: {"type":"boolean","description":"Let `relaunch` run without naming it in `only`. Default false.","default":false}
outputs: {}
steps:
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

  - id: actTargets
    kind: transform
    name: "Sessions that need a live re-check"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: actLive
    kind: map
    name: "Re-read each planned session from the registry"
    over: "$steps.actTargets"
    parallelism: 8
    onError: collect
    steps:
      - id: actLiveOne
        kind: tool
        name: "act live one"
        tool: session_list
        inputs: {"q":"$item.sessionId","fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":10,"includeArchived":true}
      - id: actLivePick
        kind: transform
        name: "act live pick"
        description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: actPlan
    kind: transform
    name: "Plan: staleness, rules, origin bounds, opt-in gates"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: actWrapup
    kind: map
    name: "Mark complete / failed / abandoned / needs-input (with outcome fields)"
    over: "$steps.actPlan.queues.wrapup"
    parallelism: 1
    onError: collect
    steps:
      - id: actWrapupOne
        kind: tool
        name: "act wrapup one"
        tool: session_wrapup_apply
        inputs: {"sessionIds":["$item.sessionId"],"verdict":"$item.verdict","judgedBy":"$item.judgedBy","note":"$item.note","reason":"$item.reason","question":"$item.question","errorKind":"$item.errorKind","nextStep":"$item.nextStep","by":"$item.by","wait":true}

  - id: actLabel
    kind: map
    name: "Label an ended session's outcome"
    over: "$steps.actPlan.queues.label"
    parallelism: 1
    onError: collect
    steps:
      - id: actLabelOne
        kind: tool
        name: "act label one"
        tool: agent_kill
        inputs: {"sessionId":"$item.sessionId","outcome":"$item.outcome"}

  - id: actArchive
    kind: map
    name: "Archive"
    over: "$steps.actPlan.queues.archive"
    parallelism: 1
    onError: collect
    steps:
      - id: actArchiveOne
        kind: tool
        name: "act archive one"
        tool: session_archive
        inputs: {"idOrName":"$item.idOrName"}

  - id: actRestart
    kind: map
    name: "Restart (continue)"
    over: "$steps.actPlan.queues.restart"
    parallelism: 1
    onError: collect
    steps:
      - id: actRestartOne
        kind: tool
        name: "act restart one"
        tool: session_restart
        inputs: {"idOrName":"$item.idOrName"}

  - id: actFresh
    kind: map
    name: "Continue fresh on another profile"
    over: "$steps.actPlan.queues.fresh"
    parallelism: 1
    onError: collect
    steps:
      - id: actFreshOne
        kind: tool
        name: "act fresh one"
        tool: session_continue_fresh
        inputs: {"idOrName":"$item.idOrName","access":"$item.access","askSource":"$item.askSource"}

  - id: actPrompt
    kind: map
    name: "Prompt (continue after a transient error)"
    over: "$steps.actPlan.queues.prompt"
    parallelism: 1
    onError: collect
    steps:
      - id: actPromptOne
        kind: tool
        name: "act prompt one"
        tool: agent_prompt
        inputs: {"sessionId":"$item.sessionId","prompt":"$item.prompt"}

  - id: actResult
    kind: transform
    name: "Fold the dispatch results into the plan"
    description: "Entry-based — see entry.mjs / two-step.mjs."

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
  plan: "$steps.actResult"
---

# Session Steward — act — `session-steward-act` workflow

Act on a classify/analyze snapshot: re-check each session against the live registry (a session that changed since the snapshot is skipped, not touched), apply the rules (custom file first, then the defaults), bound by origin (a user-origin session is never closed), and run the resulting daemon verbs with the outcome fields recorded. Dry run unless `apply` is true.

See `../session-steward/two-step.mjs` for the step functions and `../session-steward/actions.mjs` for the pure rules/snapshot library. CLI: `agentproto steward classify | analyze | act` (see `docs/cli/verbs/steward.md`).
