---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": patch
---

Bridge workflow runs to the app state ledger: a run started on behalf of an installed app (workflow id owned by exactly one installed app, or explicit `appId`/`appRunId`) now appends `stage-started` / `gate-report` / `stage-done` / `blocked` events with `by: "runner"` to that app's `<dataDir>/state/events.jsonl`, so an app's stage board (`app_state_get`) is written by the runner instead of staying empty. Appends are serialized, best-effort, and never fail the run. An optional `item` on the run stamps every ledger event to one sub-key inside each stage.

Also: `kind: "gate"` step args now resolve per-run — `$…` reference strings expand against the run bindings (`$$…` stays a literal `$`; a ref that resolves to nothing throws naming the step and the arg), so a manifest gate no longer receives literal `"$input.x"` strings as arguments.
