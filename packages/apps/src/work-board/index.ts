/**
 * McpApp definition for the agentproto work-board panel — a kanban over the
 * daemon's Task ledger (`packages/runtime/src/task-ledger.ts`), the ONLY
 * writable multi-party entity the daemon exposes (Activity is a read-only
 * projection recomputed on every `list()`; a session has a lifecycle, not an
 * intention).
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps or Mastra), same as sessions-panel /
 * session-chat — the host (@agentproto/runtime) wires this factory's output
 * via `registerMcpApps` from its mcp-apps-adapter.ts at boot time, with the
 * mounted list assembled in runtime's builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_work_board` is called by the host with an optional
 *      `boardId`.
 *   2. execute() answers an initial `{boardId, tasks}` snapshot off the
 *      ledger — resolved to the caller's default board when `boardId` is
 *      omitted (a session's `tree:<root>`, the operator's `ws:<slug>`).
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `task_list` (`full: true` — the compact projection drops
 *      `verification`) every ~4 s; writes go through `task_claim` /
 *      `task_update` / `task_create`, the same verbs any other caller uses —
 *      no second write path.
 *
 * This module also exports `workBoardApp`, a real `defineApp()` `AppHandle`
 * (`agents: []`, UI-only) — the catalog/emit/`app_install` path. It's
 * separate from `makeWorkBoardApp` above, which the daemon mounts directly
 * at boot: that factory closes over the LIVE ledger read, something a
 * static emitted `ui.html` snapshot can't carry.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import {
  WORK_BOARD_APP_ID,
  WORK_BOARD_HTML,
  WORK_BOARD_TOOL_ID,
  WORK_BOARD_UI_TOOLS,
} from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const workBoardInputSchema = z.object({
  boardId: z
    .string()
    .optional()
    .describe(
      "Board to open — `tree:<rootSessionId>` (a supervisor and its " +
        "executors) or `ws:<slug>` (an operator workspace). Omit → the " +
        "caller's default board.",
    ),
})

export type WorkBoardInput = z.infer<typeof workBoardInputSchema>

export interface WorkBoardOutput<TTask = unknown> {
  /** Always echoed back — the ledger's board ids are the swimlane
   *  selector, and must be visible rather than hidden behind a friendly
   *  name (it's how the operator knows which mission they're looking at). */
  boardId: string
  tasks: TTask[]
}

/**
 * Generic over the host's own task-record shape — this package doesn't own
 * that type (it lives in @agentproto/runtime's task ledger), so the factory
 * stays agnostic to it and the host supplies the concrete type as a type
 * argument when it wires the app up (mirrors SessionsPanelOps<TSession>).
 */
export interface WorkBoardOps<TTask = unknown> {
  /** Full (unprojected) records for a board — NOT `task_list`'s default
   *  compact projection, since the verification tell needs `verification`
   *  (self-report vs gate vs human), which compact mode omits. Omit
   *  `boardId` to resolve the caller's default board. */
  listTasks(boardId?: string): WorkBoardOutput<TTask>
}

export type { AgnoMcpApp }

/**
 * Factory: close over the ledger read so execute() doesn't need an
 * AppContext (agentproto has no userId/guildId concept) — mirrors
 * makeSessionsPanelApp.
 */
export function makeWorkBoardApp<TTask = unknown>(
  ops: WorkBoardOps<TTask>,
): AgnoMcpApp<WorkBoardInput, WorkBoardOutput<TTask>> {
  return {
    id: WORK_BOARD_TOOL_ID,
    title: "Work Board",
    description:
      "Open the agentproto work board — a kanban over the daemon's Task " +
      "ledger (columns: pending/in_progress/done/failed, cancelled folded " +
      "into failed). Swimlane is the ledger's own board id (`tree:<root>` " +
      "or `ws:<slug>`). Each card shows its owner (or \"Unclaimed\") and the " +
      "verification tell — a gate-passed done reads visually distinct from " +
      "a self-reported one. Pass `boardId` to open a specific board.",
    inputSchema: workBoardInputSchema,
    execute: async input => ops.listTasks(input.boardId),
    html: WORK_BOARD_HTML,
  }
}

export const workBoardApp: AppHandle = defineApp({
  id: WORK_BOARD_APP_ID,
  name: "Work Board",
  description:
    "Open the agentproto work board — a kanban over the daemon's Task ledger, scoped by board id " +
    "(`tree:<rootSessionId>` or `ws:<slug>`), with an explicit status action per card.",
  agents: [],
  ui: {
    html: WORK_BOARD_HTML,
    title: "Work Board",
    tools: [...WORK_BOARD_UI_TOOLS],
  },
})
