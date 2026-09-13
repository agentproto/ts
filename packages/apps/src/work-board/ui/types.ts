/**
 * Local mirror of the daemon's Task ledger shapes actually read by this
 * panel (packages/runtime/src/task-ledger.ts `TaskRecord`/`TaskWriteResult`).
 * Deliberately NOT imported from @agentproto/runtime — this package stays
 * dependency-isolated from the daemon (see work-board/index.ts's
 * `WorkBoardOps<TTask>` generic) and the wire payload is plain JSON anyway.
 * Only the fields this UI renders or reads are modelled; everything else
 * `task_list --full` returns passes through unread.
 */

export type ColumnStatus = "pending" | "in_progress" | "done" | "failed"
export const COLUMN_STATUSES: readonly ColumnStatus[] = ["pending", "in_progress", "done", "failed"]

export type TaskStatus = ColumnStatus | "cancelled"

/** How a `done` was reached — never absent on a done task. Mirrors
 *  task-ledger.ts's `TaskVerification` exactly; the verification tell reads
 *  `kind` only. */
export type TaskVerification =
  | { kind: "self-report"; by: string; ts: string }
  | { kind: "gate"; policyId?: string; exitCode?: number; ts: string }
  | { kind: "human"; ts: string }

export interface Task {
  taskId: string
  rev: number
  title: string
  status: TaskStatus
  owner?: string
  /** Presence-only in this UI (the "gated" tag) — the gate spec's own shape
   *  is never rendered, so it stays an opaque non-`any`/`unknown` object. */
  verify?: object
  verification?: TaskVerification
  lastVerifyError?: string
}

export interface TaskListResult {
  boardId: string
  tasks: Task[]
}

/** `task_claim` / `task_update`'s three-way reply (task-ledger.ts's
 *  `TaskWriteResult`, re-wrapped by task-tools.ts's `writeResultContent`). */
export type TaskWriteReply =
  | { task: Task; verifying?: boolean }
  | { conflict: true; current: Task }
  | { error: string }

export interface TaskCreateResult {
  error?: string
}
