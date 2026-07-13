/**
 * In-process pub/sub bus for session lifecycle events. Separate from
 * RuntimeEvents (global daemon bus) — session events are scoped to
 * individual sessions and fire at turn-level granularity.
 *
 * Consumers: EventRing (session_events_poll cursor), WebhookNotifier
 * (fire-and-forget HTTP), RoutineRunner (state machine fan-in),
 * and session_monitor MCP tool (long-poll multiplexed).
 */

import { EventEmitter } from "node:events"

export type SessionEventType =
  | "session:turn-end"
  | "session:awaiting-input"
  | "session:permission-request"
  | "session:permission-resolved"
  | "session:exited"
  | "session:command-done"
  | "policy:passed"
  | "policy:failed"
  | "policy:commit-ready"
  | "policy:committed"
  | "cron:fired"
  | "cron:succeeded"
  | "cron:failed"

/**
 * Structured detail on why a session is awaiting input, when derivable.
 * `source: "structured"` — a driver-reported ACP-style prompt (e.g. a tool
 * permission request with real options). `source: "heuristic"` — a
 * best-effort guess from the tail of the transcript (trailing "?" plus
 * an optional enumerated option list) for drivers that don't report
 * structured prompts. Absent entirely when neither could be determined —
 * callers still have the plain `awaitingInput` boolean in that case.
 */
export interface SessionAwaitingQuestion {
  text: string
  options?: string[]
  source: "structured" | "heuristic"
}

export interface SessionTurnEndEvent {
  type: "session:turn-end"
  sessionId: string
  awaitingInput: boolean
  label?: string
  ts: string
  question?: SessionAwaitingQuestion
  /**
   * The adapter's stream `turn-end` reason, when the driver reports one
   * (e.g. `"completed"`, `"cancelled"`, `"max_turns"`, or
   * `"watchdog-timeout"` when the ACP client's turn-idle watchdog fired
   * because the adapter went silent — see
   * `@agentproto/acp/client`'s `AcpClientOptions.turnIdleTimeoutMs`).
   * Absent for drivers that don't report a reason.
   */
  reason?: string
  /**
   * True when the turn completed normally but produced ZERO assistant
   * output AND zero tool calls (and wasn't awaiting input) — a silent
   * no-op. Grok via hermes/OpenRouter, and any invalid/rejected model id,
   * complete a turn this way: `turnsCompleted` bumps, `$0` cost, empty
   * transcript. Surfaced so an orchestrator can flag it instead of
   * treating a green turn-end as real progress. Absent (not `false`) on
   * a normal, productive turn.
   */
  empty?: boolean
}

export interface SessionAwaitingInputEvent {
  type: "session:awaiting-input"
  sessionId: string
  label?: string
  ts: string
  question?: SessionAwaitingQuestion
}

/**
 * Emitted when a permission-hold session parks a `session/request_permission`
 * (see the pending-permissions inbox in sessions.ts). `permissionId` is the
 * stable id `permissions_respond` / `POST /permissions/:id` resolve it with.
 */
export interface SessionPermissionRequestEvent {
  type: "session:permission-request"
  sessionId: string
  permissionId: string
  toolName?: string
  text: string
  label?: string
  ts: string
}

/**
 * Emitted when a parked permission is resolved — by an inbox
 * approve/deny, or auto-`cancelled` when the session is torn down while the
 * request is still pending.
 */
export interface SessionPermissionResolvedEvent {
  type: "session:permission-resolved"
  sessionId: string
  permissionId: string
  decision: "approve" | "deny" | "cancelled"
  optionId?: string
  label?: string
  ts: string
}

export interface SessionExitedEvent {
  type: "session:exited"
  sessionId: string
  exitCode?: number
  status: "exited" | "killed" | "error"
  label?: string
  ts: string
}

/** Emitted when command_execute finishes. commandId matches the id
 *  returned by the command_execute MCP tool. */
export interface SessionCommandDoneEvent {
  type: "session:command-done"
  sessionId: string
  commandId: string
  exitCode: number
  ts: string
}

/** Emitted by the supervisor when a completion policy's gate passes. */
export interface PolicyPassedEvent {
  type: "policy:passed"
  policyId: string
  sessionId: string
  ts: string
}

/** Emitted by the supervisor when a completion policy's gate fails. */
export interface PolicyFailedEvent {
  type: "policy:failed"
  policyId: string
  sessionId: string
  exitCode?: number
  ts: string
}

/**
 * Emitted by the supervisor (WP5) when a `then:"commit"` policy's gate passes
 * but `requireHumanAck` is set: the commit is staged-and-ready but NOT yet
 * executed. Carries the exact paths + message that `policy_ack(approve:true)`
 * will commit. The policy sits in `awaiting-ack` until acked.
 */
export interface PolicyCommitReadyEvent {
  type: "policy:commit-ready"
  policyId: string
  sessionId: string
  paths: string[]
  message: string
  ts: string
}

/** Emitted by the supervisor (WP5) when a `then:"commit"` policy has actually
 *  committed — either directly (requireHumanAck:false) or after an approving
 *  `policy_ack`. Carries the resulting commit sha. */
export interface PolicyCommittedEvent {
  type: "policy:committed"
  policyId: string
  sessionId: string
  sha: string
  paths: string[]
  message: string
  ts: string
}

/** Emitted by CronScheduler when a job fires (before the action runs). */
export interface CronFiredEvent {
  type: "cron:fired"
  jobId: string
  label?: string
  ts: string
}

/** Emitted by CronScheduler when a job action completes successfully. */
export interface CronSucceededEvent {
  type: "cron:succeeded"
  jobId: string
  label?: string
  summary: string
  ts: string
}

/** Emitted by CronScheduler when a job action fails. */
export interface CronFailedEvent {
  type: "cron:failed"
  jobId: string
  label?: string
  error: string
  ts: string
}

export type SessionEvent =
  | SessionTurnEndEvent
  | SessionAwaitingInputEvent
  | SessionPermissionRequestEvent
  | SessionPermissionResolvedEvent
  | SessionExitedEvent
  | SessionCommandDoneEvent
  | PolicyPassedEvent
  | PolicyFailedEvent
  | PolicyCommitReadyEvent
  | PolicyCommittedEvent
  | CronFiredEvent
  | CronSucceededEvent
  | CronFailedEvent

export interface SessionEventBus {
  emit(ev: SessionEvent): void
  /** Subscribe to a specific event type. Returns an unsubscribe fn. */
  on<E extends SessionEventType>(
    type: E,
    handler: (ev: Extract<SessionEvent, { type: E }>) => void,
  ): () => void
  /** Subscribe to all event types. Returns an unsubscribe fn. */
  onAny(handler: (ev: SessionEvent) => void): () => void
}

export function createSessionEventBus(): SessionEventBus {
  const ee = new EventEmitter()
  ee.setMaxListeners(100)

  return {
    emit(ev) {
      ee.emit("event", ev)
    },
    on(type, handler) {
      const wrapped = (ev: SessionEvent) => {
        if (ev.type === type) handler(ev as Extract<SessionEvent, { type: typeof type }>)
      }
      ee.on("event", wrapped)
      return () => ee.off("event", wrapped)
    },
    onAny(handler) {
      ee.on("event", handler)
      return () => ee.off("event", handler)
    },
  }
}
