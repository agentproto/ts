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
  | "session:exited"
  | "session:command-done"
  | "policy:passed"
  | "policy:failed"
  | "policy:commit-ready"
  | "policy:committed"

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
}

export interface SessionAwaitingInputEvent {
  type: "session:awaiting-input"
  sessionId: string
  label?: string
  ts: string
  question?: SessionAwaitingQuestion
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

export type SessionEvent =
  | SessionTurnEndEvent
  | SessionAwaitingInputEvent
  | SessionExitedEvent
  | SessionCommandDoneEvent
  | PolicyPassedEvent
  | PolicyFailedEvent
  | PolicyCommitReadyEvent
  | PolicyCommittedEvent

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
