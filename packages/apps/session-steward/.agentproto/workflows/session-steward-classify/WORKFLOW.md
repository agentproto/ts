---
name: "Session Steward — classify"
id: session-steward-classify
description: "Classify the live and recently ended sessions at one instant: rules plus Jev's typed verdict and probabilities, then ONE recommended action each (keep | mark-complete | mark-failed | relaunch | needs-input | close-abandoned | archive). Persists a snapshot for `session-steward-act`. Never mutates unless `apply` is true (classify + act in one go)."
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
  apply: {"type":"boolean","description":"Perform the planned actions. Default false = dry run.","default":false}
  only: {"type":"array","description":"Restrict to these actions (keep | mark-complete | mark-failed | relaunch | needs-input | close-abandoned | archive). `relaunch` and `archive` only run when named here.","items":{"type":"string"}}
  sessions: {"type":"array","description":"Restrict to these session ids.","items":{"type":"string"}}
  allowRelaunch: {"type":"boolean","description":"Let `relaunch` run without naming it in `only`. Default false.","default":false}
  maxJudged: {"type":"number","description":"Most judge-class sessions Jev classifies per run, most RAM first. Default 40.","default":40}
  jevModel: {"type":"string","description":"Jev model. Default jev-latest.","default":"jev-latest"}
  maxArchive: {"type":"number","description":"Most archivable ended sessions listed in the snapshot. Default 100.","default":100}
  archiveAfterHours: {"type":"number","description":"An ended session with a recorded outcome is recommended `archive` once this old. Default 24.","default":24}
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

  - id: plan
    kind: tool
    name: "Classify idle sessions (dry run)"
    tool: session_wrapup_plan
    inputs: {"idleMinutes":"$steps.settings.idleMinutes","wait":true}

  - id: candidates
    kind: transform
    name: "Split close / stuck / judge, drop keep and the caller"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: hostLoad
    kind: tool
    name: "Host saturation (report only)"
    tool: host_load
    inputs: {}

  - id: listWindow
    kind: transform
    name: "Listing window as a relative age"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: liveSessions
    kind: tool
    name: "Live sessions (projected, paged)"
    tool: session_list
    inputs: {"onlyAlive":true,"fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200}

  - id: liveSessionsCursor2
    kind: transform
    name: "live sessions cursor2"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: liveSessionsPage2
    kind: map
    name: "Live sessions (projected, paged)"
    over: "$steps.liveSessionsCursor2"
    parallelism: 1
    onError: collect
    steps:
      - id: liveSessionsPage2Fetch
        kind: tool
        name: "live sessions page2 fetch"
        tool: session_list
        inputs: {"onlyAlive":true,"fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200,"cursor":"$item.cursor"}

  - id: liveSessionsCursor3
    kind: transform
    name: "live sessions cursor3"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: liveSessionsPage3
    kind: map
    name: "Live sessions (projected, paged)"
    over: "$steps.liveSessionsCursor3"
    parallelism: 1
    onError: collect
    steps:
      - id: liveSessionsPage3Fetch
        kind: tool
        name: "live sessions page3 fetch"
        tool: session_list
        inputs: {"onlyAlive":true,"fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200,"cursor":"$item.cursor"}

  - id: endedSessions
    kind: tool
    name: "Recently active sessions (projected, paged)"
    tool: session_list
    inputs: {"updatedSince":"$steps.listWindow.updatedSince","fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200}

  - id: endedSessionsCursor2
    kind: transform
    name: "ended sessions cursor2"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: endedSessionsPage2
    kind: map
    name: "Recently active sessions (projected, paged)"
    over: "$steps.endedSessionsCursor2"
    parallelism: 1
    onError: collect
    steps:
      - id: endedSessionsPage2Fetch
        kind: tool
        name: "ended sessions page2 fetch"
        tool: session_list
        inputs: {"updatedSince":"$steps.listWindow.updatedSince","fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200,"cursor":"$item.cursor"}

  - id: endedSessionsCursor3
    kind: transform
    name: "ended sessions cursor3"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: endedSessionsPage3
    kind: map
    name: "Recently active sessions (projected, paged)"
    over: "$steps.endedSessionsCursor3"
    parallelism: 1
    onError: collect
    steps:
      - id: endedSessionsPage3Fetch
        kind: tool
        name: "ended sessions page3 fetch"
        tool: session_list
        inputs: {"updatedSince":"$steps.listWindow.updatedSince","fields":["id","name","label","status","origin","parentSessionId","cwd","model","accessProfile","startedAt","lastActivityAt","endedAt","lastTurnErroredAt","lastTurnErrorMessage","lastError","lastTurnReason","turnsCompleted","tokensIn","tokensOut","costUsd","contextUsed","busy","pty","pinned","keepAlive","archived","provisioning","pendingPrompts","outcome","wrapupFlag","openedPrs","worktree"],"limit":200,"cursor":"$item.cursor"}

  - id: scan
    kind: transform
    name: "Fold the listing into the scan"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: candidatesPlus
    kind: transform
    name: "Never-ran sessions are stuck, not judged"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: relabelQueue
    kind: transform
    name: "Ended sessions without an outcome"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: relabelEvidenceQueue
    kind: transform
    name: "Evidence reads for the relabel candidates"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: relabelEvidence
    kind: map
    name: "Read their evidence"
    over: "$steps.relabelEvidenceQueue"
    parallelism: 4
    onError: collect
    steps:
      - id: relabelEvidenceOne
        kind: tool
        name: "relabel evidence one"
        tool: session_evidence
        inputs: {"sessionId":"$item.sessionId"}
      - id: relabelEvidenceFold
        kind: transform
        name: "relabel evidence fold"
        description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: relabelFinal
    kind: transform
    name: "Proposed outcome per ended session"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: evidence
    kind: map
    name: "Compact evidence per judge candidate (no judge prompt)"
    over: "$steps.candidatesPlus.judge"
    parallelism: 4
    onError: collect
    steps:
      - id: evidenceOne
        kind: tool
        name: "evidence one"
        tool: session_evidence
        inputs: {"sessionId":"$item.sessionId"}
      - id: evidenceFold
        kind: transform
        name: "evidence fold"
        description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: jevQueue
    kind: transform
    name: "Candidates whose evidence read succeeded"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: jevJudge
    kind: map
    name: "Jev typed verdict + probabilities per candidate"
    over: "$steps.jevQueue"
    parallelism: 4
    onError: collect
    steps:
      - id: jevOne
        kind: tool
        name: "jev one"
        tool: session_judge_jev
        inputs: {"sessionId":"$item.entry.sessionId","evidence":"$item.evidence","model":"$steps.settings.jevModel"}

  - id: archiveRows
    kind: transform
    name: "Ended sessions with an outcome, old enough to archive"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: heldRows
    kind: transform
    name: "Live sessions left alone on purpose (pinned / pty / keepAlive / busy)"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: profilesQueue
    kind: transform
    name: "One profile-registry read"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: profilesRead
    kind: map
    name: "Auth profiles (compact, for relaunch hints)"
    over: "$steps.profilesQueue"
    parallelism: 1
    onError: collect
    steps:
      - id: profilesReadOne
        kind: tool
        name: "profiles read one"
        tool: auth_profile_list
        inputs: {"fields":["id","endpoint","method","credentialRef","subaccount","label","disabled","models","keyStatus"],"limit":200}

  - id: installedApps
    kind: tool
    name: "Installed apps"
    tool: app_list
    inputs: {}

  - id: memoryApp
    kind: transform
    name: "App holding the snapshots"
    description: "Entry-based — see entry.mjs / two-step.mjs."

  - id: snapshot
    kind: transform
    name: "Build the snapshot (verdict, probabilities, one action each)"
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
        inputs: {"appId":"$item.appId","path":"$item.path","content":"$steps.snapshot"}

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
---

# Session Steward — classify — `session-steward-classify` workflow

Classify the live and recently ended sessions at one instant: rules plus Jev's typed verdict and probabilities, then ONE recommended action each (keep | mark-complete | mark-failed | relaunch | needs-input | close-abandoned | archive). Persists a snapshot for `session-steward-act`. Never mutates unless `apply` is true (classify + act in one go).

See `../session-steward/two-step.mjs` for the step functions and `../session-steward/actions.mjs` for the pure rules/snapshot library. CLI: `agentproto steward classify | analyze | act` (see `docs/cli/verbs/steward.md`).
