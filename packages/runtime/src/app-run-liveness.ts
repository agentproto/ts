/**
 * AIP-58 §2 terminal-state reconciliation for an `app_run` (P3b, F8/F14).
 *
 * An app run's own sessions are the liveness signal (unlike a workflow run,
 * which needs a synthetic lease/heartbeat — see `workflow-runner.ts`'s
 * `sweep()` — an app run's session descriptors already carry a status the
 * `SessionsRegistry` maintains independently). Pure so both the read-time
 * projection (`app_status`) and the write-time sweep (`sweepAppRuns`) apply
 * the identical rule and can never disagree.
 */

export type SessionLivenessCategory = "live" | "clean" | "errored" | "gone"

/** `undefined` (the registry has no record of the session at all) is the
 *  F8/F14 symptom — "0 live sessions", the run never closed and the
 *  daemon has since forgotten the session existed. That's NOT the same as
 *  a session the registry still holds with a confirmed clean/errored
 *  terminal status. */
export function categorizeSession(status: string | undefined): SessionLivenessCategory {
  if (status === undefined) return "gone"
  if (status === "running" || status === "starting") return "live"
  if (status === "error") return "errored"
  return "clean"
}

/** The subset of `WorkflowRunStatus` that counts as terminal for the
 *  purposes of "this app run's owned workflow runs are done". */
const TERMINAL_WORKFLOW_STATUSES = new Set(["done", "failed", "cancelled"])

export interface ReconcileAppRunInput {
  readonly sessions: ReadonlyArray<{ status: string | undefined }>
  /** Statuses of ONLY the workflow runs this specific app run owns
   *  (`WorkflowRun.appRunId === run.appRunId`) — not every workflow run the
   *  app has ever started. */
  readonly workflowRunStatuses: readonly string[]
}

export type ReconcileAppRunResult =
  | { status: "running" }
  | { status: "succeeded" }
  | { status: "failed"; errorCode?: "orphaned" }

/**
 * AIP-58 §2, applied to an app run: `succeeded` when every session's turn
 * ended without error and every owned workflow run is itself terminal;
 * `failed` on a session/workflow-run error; `failed { errorCode: "orphaned"
 * }` when every session has vanished from the registry entirely with no
 * confirmed clean-or-errored signal — the "0 live sessions, run never
 * closed" zombie (F8/F14) — rather than an optimistic `succeeded` with no
 * actual evidence the run finished cleanly. `running` (no verdict yet)
 * covers both "still live" and "waiting on an owned workflow run".
 */
export function reconcileAppRunStatus(input: ReconcileAppRunInput): ReconcileAppRunResult {
  const { sessions, workflowRunStatuses } = input
  if (sessions.length === 0) return { status: "failed" }

  const categories = sessions.map(s => categorizeSession(s.status))
  if (categories.some(c => c === "live")) return { status: "running" }

  const workflowRunsTerminal = workflowRunStatuses.every(s => TERMINAL_WORKFLOW_STATUSES.has(s))
  if (!workflowRunsTerminal) return { status: "running" }

  if (categories.every(c => c === "gone")) return { status: "failed", errorCode: "orphaned" }

  const anyErrored = categories.some(c => c === "errored")
  const anyWorkflowRunFailed = workflowRunStatuses.some(s => s === "failed")
  return anyErrored || anyWorkflowRunFailed ? { status: "failed" } : { status: "succeeded" }
}

export interface SweepAppRunsInput {
  readonly appRegistry: {
    listRuns(): ReadonlyArray<{
      readonly appRunId: string
      readonly status: string
      readonly sessions: ReadonlyArray<{ readonly sessionId: string }>
    }>
    endRun(
      appRunId: string,
      opts?: { status?: "succeeded" | "failed" | "cancelled"; error?: string; errorCode?: string },
    ): unknown
  }
  readonly registry: { get(sessionId: string): { status?: string } | undefined }
  /** Statuses of every workflow run in the daemon — filtered per app run by
   *  its own `appRunId` below. Undefined (no workflow runner wired) is
   *  treated as "this app run owns no workflow runs". */
  readonly workflowRuns?: ReadonlyArray<{ readonly appRunId?: string; readonly status: string }>
}

/**
 * AIP-58 §2 write-time counterpart to {@link reconcileAppRunStatus} (P3b,
 * F8/F14): sweeps every `running` app run through the identical rule and
 * PERSISTS the verdict via `appRegistry.endRun` once it's terminal — the
 * fix for the "~25 app runs stuck running for weeks" evidence, which
 * `app_status`'s read-time reconciliation alone never corrects because
 * nothing ever polls a run nobody is looking at. Never deletes a record;
 * only flips `status`/`endedAt`/`error`/`errorCode` in place, same as
 * `app_stop`. Call on the same periodic cadence as
 * `WorkflowRunner.sweep()` (see `workflow-runner.ts`) — both are cheap,
 * synchronous, and idempotent.
 */
export function sweepAppRuns(input: SweepAppRunsInput): { swept: string[] } {
  const { appRegistry, registry, workflowRuns = [] } = input
  const swept: string[] = []
  for (const run of appRegistry.listRuns()) {
    if (run.status !== "running") continue
    const sessions = run.sessions.map(s => ({ status: registry.get(s.sessionId)?.status }))
    const workflowRunStatuses = workflowRuns.filter(r => r.appRunId === run.appRunId).map(r => r.status)
    const reconciled = reconcileAppRunStatus({ sessions, workflowRunStatuses })
    if (reconciled.status === "running") continue
    appRegistry.endRun(run.appRunId, {
      status: reconciled.status,
      ...(reconciled.status === "failed"
        ? {
            error:
              reconciled.errorCode === "orphaned"
                ? "app run orphaned — every session has vanished from the registry with no confirmed clean-or-errored signal"
                : "app run failed — a session or an owned workflow run ended in error",
          }
        : {}),
      ...(reconciled.status === "failed" && reconciled.errorCode !== undefined
        ? { errorCode: reconciled.errorCode }
        : {}),
    })
    swept.push(run.appRunId)
  }
  return { swept }
}
