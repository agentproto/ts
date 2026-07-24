---
schema: routine/v1
id: worktree-gc-notify
description: |
  Scheduled worktree gc + Telegram notification, as ONE `target.workflow`
  routine instead of a bare `target.tool` fire — the sibling `worktree-gc`
  routine (`../worktree-gc/ROUTINE.md`) gc's but never reports out; this
  fires `worktree-gc-notify/WORKFLOW.md`, whose three tool steps gc, format,
  and notify hosted agentpush in one run. Ships DISABLED (`enabled: false`)
  — install it into a workspace's `.routines/` and flip `enabled: true` to
  activate. See the WORKFLOW.md alongside this file for what each step does.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 4 * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts/packages/worktree/routines/worktree-gc-notify/WORKFLOW.md
  inputs:
    chatId: "<REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID>"
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: worktree.gc-notify.failed
fires_events:
  - worktree.gc-notify.completed
  - worktree.gc-notify.failed
enabled: false
tags: [worktree, gc, maintenance, notify]
---

# Worktree GC + notify routine

Runs daily at **04:00 UTC**, firing `worktree-gc-notify/WORKFLOW.md` via
`workflow_run_file` (the same lowering every `target.workflow.file` routine
goes through — see `routine-registrar.ts`'s `routineTargetToToolCall`). That
workflow's three tool steps (`gc` → `format` → `notify`) are documented in
the WORKFLOW.md itself.

## Why a workflow target instead of `target.tool`

`../worktree-gc/ROUTINE.md` already fires `worktree_gc` directly as a bare
`target.tool` — simplest form, no reporting. This routine dogfoods the OTHER
target shape (`target.workflow`), which needed the daemon-side
`compileWorkflow` tool-registry fix to run at all: before that fix, ANY
`tool` step in a WORKFLOW.md (this one has three) failed to resolve
("no tool registered"), so a `target.workflow` routine whose workflow used
tool steps could never actually complete.

## Enabling

1. Copy this directory to `<workspace>/.routines/worktree-gc-notify/`
   (ROUTINE.md + WORKFLOW.md + entry.mjs together).
2. Allowlist `bash` in that workspace's `.agentproto/allowed-commands.json`
   (`command_execute`'s `notify` step needs it) — see the WORKFLOW.md.
3. Set `enabled: true`, update `target.workflow.file` to wherever the
   WORKFLOW.md actually lives in that environment, and replace
   `target.inputs.chatId` with your own Telegram chat id.
4. Reload routines, or fire it once ad-hoc via `routine_trigger` without
   waiting for the schedule or flipping `enabled`.

## Failure routing

Same convention as `worktree-gc`: one retry attempt (no backoff), then
`on_failure` opens a work item and fires `worktree.gc-notify.failed`. A
clean run fires `worktree.gc-notify.completed`.
