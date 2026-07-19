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

import type { SessionConfig } from "./session-config.js"

export type SessionEventType =
  | "session:turn-end"
  | "session:awaiting-input"
  | "session:permission-request"
  | "session:permission-resolved"
  | "session:exited"
  | "session:command-done"
  | "session:model-changed"
  | "session:config-changed"
  | "session:renamed"
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
  /** Mirrors `SessionDescriptor.endedReason` — set when this exit was the
   *  daemon dying underneath the session (crash-discovered-at-boot or a
   *  forced shutdown kill), not an operator targeting it. Lets a watcher
   *  (completion-policy supervisor, `session_monitor`) tell "my agent died
   *  because the daemon did" apart from a deliberate kill. Absent otherwise. */
  reason?: "daemon-restart"
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

/**
 * Emitted when `SessionsRegistry.setModel` successfully switches a LIVE
 * agent-cli session's model (`POST /sessions/:id/model`, `session_set_model`
 * MCP tool). Only fires on `applied: true` — a rejected switch changes
 * nothing about the session, so there's nothing to announce. `model` is the
 * new value now reflected on `SessionDescriptor.model` (and therefore on the
 * next `session_list` / SSE `sessionUpdate` a client sees). Consumers:
 * `session_events_poll`, the webhook notifier, and the routine engine —
 * same distribution as every other lifecycle event on this bus.
 */
export interface SessionModelChangedEvent {
  type: "session:model-changed"
  sessionId: string
  model: string
  label?: string
  ts: string
}

/**
 * The `SessionConfig` axis a `session:config-changed` event reports. Reuses
 * the axis vocabulary of `SessionConfig` itself (`session-config.ts`, SPEC
 * §3.1) so there's a single source of truth for the axis names — model /
 * effort / access / route / posture / contextProfile.
 */
export type SessionConfigAxis = keyof SessionConfig

/**
 * Emitted when a SINGLE `SessionConfig` axis is changed on a session and the
 * change actually took effect (SPEC §7.2 build step 4). This is the shared,
 * axis-generic successor to `session:model-changed`: the live config verbs
 * (`agent_set_effort` / `agent_set_posture`, step 5) and restart-with-override
 * (step 6) all announce their single-axis change through THIS event, carrying
 * which axis moved and the new value now reflected on the descriptor.
 *
 * A model change still ALSO emits `session:model-changed` as a back-compat
 * alias (`sessions.ts` `setModel`) so existing subscribers keep working; new
 * consumers should prefer this event and switch on `axis`.
 *
 * Discriminated by `axis`, with `value` typed to that axis's `SessionConfig`
 * field — a `model` change carries a `string`, an `effort` change an
 * `EffortLevel`, a `route` change a `RouteSpec`, and so on. Same bus
 * distribution as every other lifecycle event (`session_events_poll`, the
 * webhook notifier, the routine engine).
 */
export type SessionConfigChangedEvent = {
  [A in SessionConfigAxis]: {
    type: "session:config-changed"
    sessionId: string
    /** Which `SessionConfig` axis changed. */
    axis: A
    /** The axis's new value, as now reflected on `SessionDescriptor`. */
    value: NonNullable<SessionConfig[A]>
    label?: string
    ts: string
  }
}[SessionConfigAxis]

/**
 * Emitted when an operator sets or clears a session's user-facing name
 * (`PATCH /sessions/:id`, the `session_rename` MCP verb). Unlike
 * `session:config-changed`, a name is NOT a `SessionConfig` axis — it never
 * touches the live agent, only the descriptor's display fields — so it rides
 * its own event. `title`/`label` carry the values now on the descriptor
 * (absent when that field was cleared). Same bus distribution as every other
 * lifecycle event: `session_events_poll`, the webhook notifier, the routine
 * engine — which is how a live UI (the VS Code tree / transcript header/tab)
 * learns to repaint the name without waiting for its next snapshot poll.
 */
export interface SessionRenamedEvent {
  type: "session:renamed"
  sessionId: string
  title?: string
  label?: string
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
  | SessionModelChangedEvent
  | SessionConfigChangedEvent
  | SessionRenamedEvent
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
