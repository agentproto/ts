---
schema: routine/v1
id: model-catalog-watch-daily
description: |
  Daily sync + structured diff of the LLM pricing catalog via the `watch`
  workflow — sync (command_execute run-all.mjs) -> diff (catalog_diff tool)
  -> gate (placeholder, always passes) -> digest (free model). `fires_events`
  below are declarative only today — see WORKFLOW.md's "Scope and known
  limitations" for why: the runtime registrar only dispatches
  `schedule.kind: cron`, not `event`, and there is no generic internal event
  bus to emit a custom name on. Ships DISABLED (`enabled: false`) — install
  it into a workspace's `.routines/` and flip `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 6 * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: <absolute-path-to-agentproto-ts>/packages/apps/model-catalog-watch/.agentproto/workflows/watch/WORKFLOW.md
  inputs: {}
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: catalog.sync.failed
fires_events:
  - catalog.synced
  - catalog.sync.failed
enabled: false
tags: [catalog, model-intel, maintenance]
---

# Model catalog watch — daily sync + diff

Runs daily at **06:00 UTC**, firing the `watch` workflow
(`../../.agentproto/workflows/watch/WORKFLOW.md`) via `workflow_run_file`.
Each run re-syncs the LLM pricing catalog, diffs it against the last run's
stored baseline, and (gate permitting — today always) has a free model write
a digest of what changed. See the workflow's own doc for the full step
breakdown and its documented scope limits (no event dispatch yet, no live
go/zen probing, no promo detection, no bench trigger).

## Enabling

1. Copy this directory to `<workspace>/.routines/model-catalog-watch-daily/`.
2. Allowlist `node` in that workspace's `.agentproto/allowed-commands.json`
   (the workflow's `sync` step needs it).
3. Set `enabled: true` and update `target.workflow.file` to wherever this
   repo's `watch/WORKFLOW.md` actually lives in that environment.
4. Reload routines so the daemon registers the schedule, or fire it once
   ad-hoc via `routine_trigger` without waiting for the schedule.

## Failure routing

One retry attempt (no backoff), then `on_failure` opens a work item.
`fires_events` / `fire_event` are declared for documentation and future
wiring only — not dispatched by the runtime today (see WORKFLOW.md).
