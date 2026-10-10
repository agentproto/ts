---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

session-steward is now a three-step pipeline. `agentproto steward classify` writes a persisted snapshot (rules plus the Jev typed verdict, one recommended action per session from the closed set keep, mark-complete, mark-failed, relaunch, needs-input, close-abandoned, archive). `steward analyze` (or `classify --llm`) adds an LLM pass over the relevant sessions only (reason, question, errorKind, nextStep, relaunchHint). `steward act <snapshotId|latest>` applies the snapshot as a dry run by default, with a per-session staleness re-check, origin bounds, and custom rules from `.agentproto/steward-rules.yaml` or `--rules`. Bare `steward --apply` stays the one-shot.

`relaunch` is recommended only for work that is not superseded by a later session of the same task, not owned by a workflow/gate/review/cron run, and failed within `--relaunch-window` (default 6h, rules key `failedMinutesAgo`); the rest are `mark-failed` with the reason.

Fixes: a rule verdict for a stuck session now applies instead of being refused as `ambiguous_needs_judge`, and refusals say why; `model-bench` and other machine origins are no longer treated as user sessions. Session outcomes now carry `reason`, `question`, `errorKind`, `nextStep` and `by`, written by `act` and by `agentproto sessions stop --outcome --reason --error-kind --next-step`. The steward reads sessions through a `fields` projection with filters and pagination instead of `session_list {full:true}`, so hourly runs no longer persist the whole registry as a step output.
