/**
 * McpApp definition for the agentproto review verdict panel — a list +
 * detail view over the daemon's review ledger
 * (`packages/runtime/src/review-ledger.ts`) and its in-flight runs
 * (`review-runner.ts`'s `ReviewRunner.list()`).
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape, no
 * @agstudio/mcp-apps / Mastra dependency), same as sessions-panel /
 * work-board — the host (@agentproto/runtime) wires this factory's output
 * via `registerMcpApps` from its mcp-apps-adapter.ts at boot time, with the
 * mounted list assembled in runtime's builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_reviews` is called by the host with the optional
 *      `{cwd, repoRemote, runId, requesterSessionId}` scoping input.
 *   2. execute() answers an initial `review_ledger`-shaped snapshot
 *      (`includeRunning: true`) via `ops.listReviews` — the SAME body
 *      `review_ledger` itself runs (`reviewLedgerView`, review-tools.ts),
 *      so a non-interactive caller sees exactly what the tool would return.
 *   3. The HTML panel — a static work-board-style Vite build, so it does
 *      NOT thread this execute() input through — opens its own bridge and
 *      polls `review_ledger({includeRunning: true})` unscoped (mirrors
 *      work-board's own boardId-from-execute() omission), then
 *      `review_status(runId)` for whichever row is selected. Actions go
 *      through `review_cancel`/`review_run`/`review_pr`/`review_export` —
 *      real tool names only, no second write path.
 *
 * This module also exports `reviewPanelApp`, a real `defineApp()`
 * `AppHandle` (`agents: []`, UI-only) — the catalog/emit/`app_install` path.
 * It's separate from `makeReviewPanelApp` above, which the daemon mounts
 * directly at boot: that factory closes over the LIVE ledger/runner read,
 * something a static emitted `ui.html` snapshot can't carry.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { REVIEW_PANEL_APP_ID, REVIEW_PANEL_HTML, REVIEW_PANEL_TOOL_ID, REVIEW_PANEL_UI_TOOLS } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const reviewPanelInputSchema = z.object({
  cwd: z.string().optional().describe("A directory inside a git repo — scopes the initial snapshot to its remote."),
  repoRemote: z.string().optional().describe("Normalized repo remote (e.g. github.com/agentproto/ts)."),
  runId: z.string().optional().describe("A specific run id known at open time (informational on the initial snapshot)."),
  requesterSessionId: z
    .string()
    .optional()
    .describe("Scope the initial snapshot to reviews requested by this session."),
})

export type ReviewPanelInput = z.infer<typeof reviewPanelInputSchema>

export interface ReviewPanelOutput {
  total: number
  attestations: Record<string, unknown>[]
  /** Echoed back from the input — the row this snapshot's caller already
   *  had in mind, when known. Not consumed by the panel's own client JS
   *  (see this file's docblock on why the static build doesn't thread it). */
  focusRunId?: string
}

/**
 * Generic host wiring for `makeReviewPanelApp` — the daemon supplies
 * `listReviews` bound to `reviewLedgerView(reviewRunner, ...)`
 * (review-tools.ts), the exact function `review_ledger` itself calls, so
 * the panel's initial snapshot and the tool's own output can never drift
 * apart into two implementations.
 */
export interface ReviewPanelOps {
  listReviews(input: ReviewPanelInput): Promise<ReviewPanelOutput> | ReviewPanelOutput
}

export type { AgnoMcpApp }

/**
 * Factory: close over the ledger/runner read so execute() doesn't need an
 * AppContext (agentproto has no userId/guildId concept) — mirrors
 * makeWorkBoardApp.
 */
export function makeReviewPanelApp(ops: ReviewPanelOps): AgnoMcpApp<ReviewPanelInput, ReviewPanelOutput> {
  return {
    id: REVIEW_PANEL_TOOL_ID,
    title: "Reviews",
    description:
      "Open the agentproto review panel — a verdict list (running reviews first, then " +
      "newest) over the daemon's review ledger, with a per-run detail view (lanes, " +
      "findings, agent-lane provenance) and actions (cancel, re-run fresh, fetch PR " +
      "status, export). Pass `cwd`/`repoRemote`/`requesterSessionId` to scope the initial " +
      "snapshot; the panel's own live view re-polls unscoped.",
    inputSchema: reviewPanelInputSchema,
    execute: async input => {
      const snapshot = await ops.listReviews(input)
      return { ...snapshot, ...(input.runId ? { focusRunId: input.runId } : {}) }
    },
    html: REVIEW_PANEL_HTML,
  }
}

export const reviewPanelApp: AppHandle = defineApp({
  id: REVIEW_PANEL_APP_ID,
  name: "Reviews",
  description:
    "Open the agentproto review panel — a verdict list + detail view over the daemon's " +
    "review ledger, with cancel / re-run / PR-status / export actions.",
  agents: [],
  ui: {
    html: REVIEW_PANEL_HTML,
    title: "Reviews",
    tools: [...REVIEW_PANEL_UI_TOOLS],
  },
})
