---
name: Worktree GC + notify
id: worktree-gc-notify
description: |
  Garbage-collects merged/fresh+clean worktrees under agentproto/ts, then
  reports the outcome to Telegram via the hosted agentpush `send_message`
  tool. Dogfoods a real multi-tool-step WORKFLOW.md now that the daemon's
  `compileWorkflow` resolves `tool` steps through `dispatchTool` (see
  `packages/runtime/src/workflow-tool-registry.ts`) instead of failing every
  `tool` step with "no tool registered". The `format` step is entry-based —
  there is no string expression language for a `transform` step's `compute`
  in the declarative manifest.
version: 0.1.0
entry: ./entry.mjs
inputs:
  chatId:
    type: string
    description: Telegram chat id `notify` reports to. Operator-supplied — never hardcoded.
outputs: {}
steps:
  - id: gc
    kind: tool
    tool: worktree_gc
    inputs:
      apply: true
      salvageDirty: false
      repoRoot: /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts
  - id: format
    kind: transform
  - id: notify
    kind: tool
    tool: command_execute
    inputs:
      command: bash
      stdin: $steps.format
---

# Worktree GC + notify

Three tool steps, in order:

1. **`gc`** — `worktree_gc` with `apply: true`, `salvageDirty: false`. Same
   safety invariants as the sibling `worktree-gc` routine (merge-gated
   reclaim, open-PR-is-always-hold, dirty-is-salvage-only): this workflow
   inherits them from the engine, it doesn't re-implement them.
2. **`format`** — an entry-based `transform` step (see `entry.mjs`) that
   turns `$steps.gc`'s structured `{ mode, outcomes }` into the exact JSON
   body hosted agentpush's `POST /tools/send_message` expects (mirrors
   `.plans/agentproto-maintenance-crons/notify-worktree-gc.sh`'s formatting).
3. **`notify`** — `command_execute` running `bash -c '<curl to hosted
   agentpush>'`, fed `format`'s output as `stdin` (`curl --data-binary @-`).
   The LOCAL agentpush MCP is down; this goes straight to
   `https://api.agentpush.io/tools/send_message` with the Bearer key sourced
   from `envs/agentpush/.env.local`, same as the working cron script.

## Enabling

Ships wired to `routines/worktree-gc-notify/ROUTINE.md`, disabled
(`enabled: false`). To activate in a workspace:

1. Copy this directory to `<workspace>/.routines/worktree-gc-notify/`.
2. `command_execute` requires `bash` (and whatever `curl` needs) allowlisted
   in that workspace's `.agentproto/allowed-commands.json`.
3. Set `enabled: true` on the copied `ROUTINE.md`, update
   `target.workflow.file` if the workflow isn't installed at this same
   absolute path in that environment (`workflow_run_file`'s `path` is read
   as-is, with no anchoring to the routine's own directory), and set
   `target.inputs.chatId` to your own Telegram chat id.
4. Reload routines so the daemon registers the schedule (or fire it once
   ad-hoc via `routine_trigger`).
