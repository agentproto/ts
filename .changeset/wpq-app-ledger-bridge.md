---
"@agentproto/runtime": minor
---

Bridge workflow runs to the app state ledger: a run started on behalf of an installed app (workflow id owned by exactly one installed app, or explicit `appId`/`appRunId`) now appends `stage-started` / `gate-report` / `stage-done` / `blocked` events with `by: "runner"` to that app's `<dataDir>/state/events.jsonl`, so an app's stage board (`app_state_get`) is written by the runner instead of staying empty. Appends are serialized, best-effort, and never fail the run.
