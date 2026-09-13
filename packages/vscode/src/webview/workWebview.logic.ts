/**
 * Pure Work-WEBVIEW row/group model — NO vscode import, so it's unit-testable
 * under plain vitest (workWebviewPanel.ts wraps this into the webview's
 * HTML/postMessage payload, same split as activityWebview.logic.ts vs.
 * activityWebviewPanel.ts).
 *
 * The Work view is the sidebar COMPANION to the work-board app — a narrow
 * vertical list (the sidebar is 340px), NOT a board. It reads the daemon's
 * Task ledger (`client.listTasks`, the write-model entity per
 * docs/PANEL-ENTITIES.md) read-only: claiming and status moves stay in the
 * board app, which does them with a CAS `rev`.
 *
 * Vocabulary (docs/PANEL-ENTITIES.md — non-negotiable):
 *   - `pending` means UNCLAIMED — rendered as "Unclaimed", never "Pending".
 *   - Groups run in the fixed order Unclaimed · In progress · Done · Failed,
 *     with `cancelled` folded into Failed — exactly the app's own columnOf
 *     fold (packages/apps/src/work-board/panel.ts), not a different one.
 *   - The verification tell is the app's four-way one, kept honest: a
 *     declared `verify` with nothing verified is a grey "gated" tag, never a
 *     green check.
 */

import type { TaskRecord } from "../client/types.js"

/** One rendered task row — flat, read-only, no action. */
export interface WorkRow {
  taskId: string
  boardId: string
  title: string
  /** `sessionId | "human" | "operator"`; undefined = unclaimed. */
  owner: string | undefined
  status: string
  /** True when the task was cancelled — the Failed group tags it distinctly. */
  cancelled: boolean
  /** The four-way verification tell text; empty when there is nothing honest to show. */
  tell: string
  /** Relative age from `now`, e.g. "4m ago". */
  age: string
}

/** One status group — always present in the fixed order, even when empty. */
export interface WorkGroup {
  key: "unclaimed" | "in_progress" | "done" | "failed"
  label: string
  rows: WorkRow[]
}

export interface WorkWebviewModel {
  groups: WorkGroup[]
  shownCount: number
}

/**
 * The verification tell — mirrors the board app's verificationTag verbatim:
 *   - `verification.kind === "gate"`       → "✓ gate"
 *   - `verification.kind === "self-report"` → "self-report"
 *   - `verification.kind === "human"`      → "human"
 *   - a declared `verify` with no verification yet → "gated" (grey, NOT green)
 * An unparseable payload yields "" — never a throw, never a false green.
 */
export function verificationTell(t: Pick<TaskRecord, "verification" | "verify" | "status"> | null | undefined): string {
  if (!t || typeof t !== "object") return ""
  const v = t.verification as { kind?: unknown } | undefined
  if (v && typeof v === "object") {
    if (v.kind === "gate") return "✓ gate"
    if (v.kind === "self-report") return "self-report"
    if (v.kind === "human") return "human"
  }
  if (t.status === "in_progress" && t.verify) return "gated"
  return ""
}

/** Relative age of an ISO timestamp from `now` — "just now" / "4m ago" / "3h ago" / "6d ago". Undefined when the timestamp is unparseable (a malformed payload must not throw). */
export function relativeAgeFrom(iso: unknown, now: number): string {
  if (typeof iso !== "string" && typeof iso !== "number") return ""
  const ms = typeof iso === "number" ? iso : Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const age = Math.max(0, now - ms)
  if (age < 60_000) return "just now"
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

function rowFor(t: TaskRecord, now: number): WorkRow {
  return {
    taskId: typeof t.taskId === "string" ? t.taskId : "",
    boardId: typeof t.boardId === "string" ? t.boardId : "",
    title: typeof t.title === "string" ? t.title : "",
    owner: typeof t.owner === "string" && t.owner.length > 0 ? t.owner : undefined,
    status: t.status,
    cancelled: t.status === "cancelled",
    tell: verificationTell(t),
    age: relativeAgeFrom(t.updatedAt, now),
  }
}

/** The board app's columnOf fold: cancelled → failed, everything else verbatim. */
function groupKeyOf(t: TaskRecord): WorkGroup["key"] {
  if (t.status === "pending") return "unclaimed"
  if (t.status === "cancelled") return "failed"
  return (t.status === "in_progress" ? "in_progress" : t.status === "done" ? "done" : "failed") as WorkGroup["key"]
}

/**
 * The webview's single entry point. One group per status in the fixed order
 * Unclaimed · In progress · Done · Failed (cancelled folded into Failed and
 * tagged), rows newest-updated first within a group. Malformed input
 * (non-arrays, null records) yields an empty row, never a throw; empty input
 * yields the four empty groups.
 */
export function buildWorkWebviewModel(input: {
  tasks: readonly TaskRecord[] | undefined
  now: number
}): WorkWebviewModel {
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter(
    (t): t is TaskRecord => t !== null && typeof t === "object",
  )
  const now = input.now

  const buckets = new Map<WorkGroup["key"], WorkRow[]>([
    ["unclaimed", []],
    ["in_progress", []],
    ["done", []],
    ["failed", []],
  ])
  for (const t of tasks) buckets.get(groupKeyOf(t))!.push(rowFor(t, now))

  // Newest-updated first within a group; ties broken by taskId for stability.
  const sourceByTaskId = new Map(tasks.map(t => [String(t.taskId ?? ""), Date.parse(String(t.updatedAt ?? ""))]))
  const groups: WorkGroup[] = [
    { key: "unclaimed", label: "Unclaimed", rows: [] },
    { key: "in_progress", label: "In progress", rows: [] },
    { key: "done", label: "Done", rows: [] },
    { key: "failed", label: "Failed", rows: [] },
  ]
  for (const g of groups) {
    g.rows = buckets.get(g.key)!.slice().sort((a, b) => {
      const aMs = sourceByTaskId.get(a.taskId)
      const bMs = sourceByTaskId.get(b.taskId)
      const aT = aMs !== undefined && Number.isFinite(aMs) ? aMs : 0
      const bT = bMs !== undefined && Number.isFinite(bMs) ? bMs : 0
      if (bT !== aT) return bT - aT
      return a.taskId.localeCompare(b.taskId)
    })
  }
  const shownCount = groups.reduce((n, g) => n + g.rows.length, 0)
  return { groups, shownCount }
}
