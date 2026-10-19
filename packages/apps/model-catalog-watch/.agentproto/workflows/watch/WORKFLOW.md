---
name: Model catalog watch
id: watch
description: |
  Syncs the LLM pricing catalog (`scripts/catalog-sync/run-all.mjs`), diffs
  it against the last run's stored baseline (`catalog_diff`, backed by
  `@agentproto/model-intel`'s `diffCatalog`), gates on whether anything
  changed, and has a free model write a short digest. Pure declarative
  manifest — no `entry.mjs` needed: `digest`'s prompt reads `diff`'s
  output via `{{steps.diff.diff}}` mustache interpolation instead of a
  `transform` step.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: sync
    kind: tool
    tool: command_execute
    inputs:
      command: node
      args: ["scripts/catalog-sync/run-all.mjs"]
  - id: diff
    kind: tool
    tool: catalog_diff
    inputs: {}
  - id: gate
    kind: gate
    command: "true"
  - id: digest
    kind: agent
    adapter: opencode
    model: opencode/mimo-v2.6-flash-free
    prompt: |
      You maintain a short daily digest of LLM catalog changes for a model
      intelligence watcher. Below is a structured diff of the catalog since
      the last run (`appeared`, `removed`, `priceChanged`, `freeToPaid`,
      `paidToFree` — each a list of model ids, `priceChanged` carrying
      prev/next `inputPer1M`/`outputPer1M`).

      Write a 3-6 sentence digest in English covering: new models, removed
      models, price changes, and free<->paid transitions. If every list is
      empty, say plainly that nothing changed since the last run — never
      invent a change that is not in the data below.

      {{steps.diff.diff}}
---

# Model catalog watch

Four steps, in order:

1. **`sync`** — `command_execute` running
   `node scripts/catalog-sync/run-all.mjs`, the existing manual sync script
   (7 vendor pricing generators + the OpenRouter/Requesty/opencode route
   generators it discovers by glob). Writes
   `packages/model-catalog/src/llm/*.generated.ts` and appends its own
   loose key-diff to `packages/model-catalog/CATALOG-CHANGELOG.md` — this
   workflow does not change that script or its output location.
2. **`diff`** — the `catalog_diff` MCP tool: builds a snapshot from the
   now-just-synced `LLM_PRICING_CATALOG`, diffs it against the snapshot
   stored from the PREVIOUS run (`~/.agentproto/catalog-snapshot.json`),
   and persists "now" as the new baseline. First run ever reports the whole
   catalog as `appeared`.
3. **`gate`** — `command: "true"` (always passes). A placeholder: nothing
   downstream exists yet to decide "should a bench run?" (PLAN.md step 6,
   not built). Wiring a real decision into this gate is a documented
   follow-up, not silently automated here.
4. **`digest`** — a plain `opencode`/`mimo-v2.6-flash-free` (free-tier)
   session summarizes `diff`'s output into a short, human-readable digest.
   Never asked to invent a change outside the structured diff.

## Scope and known limitations

- **Does NOT cover**: live opencode go/zen catalog probing, OpenRouter/
  Requesty promo detection, or an actual bench trigger. These were in the
  original PLAN.md sketch for this step but are deferred — see that file's
  revision history (R9) and the supervisor's own scoping notes.
- **No event emission.** PLAN.md's amendment list names `catalog.synced` /
  `model.appeared` / `model.price-changed` (AIP-37) as events this watcher
  should fire. The routine's `fires_events` below DECLARES these names for
  documentation/future-wiring purposes only — **the runtime does not
  dispatch them today**. `packages/routine/src/types.ts`'s `ScheduleEvent`
  (`schedule.kind: "event"`) exists in the AIP-41 schema but
  `packages/runtime/src/routine-registrar.ts`'s `reconcile()` only fires
  `schedule.kind: "cron"` — any other kind is skipped
  (`"schedule.kind '<kind>' not yet supported by the runtime registrar —
  only 'cron' fires today"`). There is also no generic internal event bus:
  `packages/runtime/src/events.ts`'s `RuntimeEvent` and
  `session-event-bus.ts`'s `SessionEventType` are both closed unions, not an
  open `emit(name, payload)`. Making `catalog.synced` real would mean
  extending `routine-registrar.ts` to dispatch `kind: "event"` AND adding a
  variant to one of those unions (or building the open bus PLAN.md implies)
  — a bigger, separate, more carefully-reviewed change, not bundled into
  this first watcher pass.
- Scheduling today is **cron only** (daily), per the sibling ROUTINE.md.

## Enabling

Ships wired to `routines/model-catalog-watch-daily/ROUTINE.md`, disabled
(`enabled: false`). To activate in a workspace:

1. Copy this directory to `<workspace>/.routines/model-catalog-watch-daily/`.
2. Allowlist `node` in that workspace's `.agentproto/allowed-commands.json`
   (the `sync` step's `command_execute` call needs it) — see
   `command-allowlist.ts`'s file format comment for the exact shape.
3. Update `target.workflow.file` on the copied `ROUTINE.md` to wherever this
   `WORKFLOW.md` lives in that environment, and set `enabled: true`.
4. Reload routines so the daemon registers the schedule, or fire it once
   ad-hoc via `routine_trigger` without waiting for the schedule.
