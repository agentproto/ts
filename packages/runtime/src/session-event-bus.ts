/**
 * In-process pub/sub bus for session lifecycle events. Separate from
 * RuntimeEvents (global daemon bus) — session events are scoped to
 * individual sessions and fire at turn-level granularity.
 *
 * Consumers: EventRing (session_events_poll cursor), WebhookNotifier
 * (fire-and-forget HTTP), WorkflowRunner (state machine fan-in),
 * and session_monitor MCP tool (long-poll multiplexed).
 */

import { EventEmitter } from "node:events"

import type { ActivityRecord } from "./activity-projection.js"
import type { SessionConfig } from "./session-config.js"
import type { TaskStatus } from "./task-ledger.js"

export type SessionEventType =
  | "session:turn-end"
  | "session:awaiting-input"
  | "session:permission-request"
  | "session:permission-resolved"
  | "session:exited"
  | "session:reaped"
  | "session:stalled"
  | "session:stall-cleared"
  | "session:resumed"
  | "session:spawned"
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
  | "activity:changed"
  | "task:changed"

/**
 * Fixed severity vocabulary for a judge-gate finding (WP-D). Deliberately
 * small and fixed so `policy_status` output is comparable across different
 * judge gates — but the engine never interprets it as a pass/fail threshold;
 * see `JudgeVerdict`'s doc for why.
 */
export type VerdictSeverity = "info" | "low" | "medium" | "high" | "critical"

/** One finding inside a structured judge verdict — mirrors the shape a real
 *  consumer (the agentik-studio push gate reviewer) already produces. */
export interface VerdictFinding {
  severity: VerdictSeverity
  file?: string
  note: string
}

/**
 * Structured judge-gate verdict (WP-D), an optional richer alternative to the
 * plain `VERDICT: PASS|FAIL` text line WP7 already parses. `decision` is the
 * SAME single bit the text line always carried: the engine's pass/fail comes
 * directly from `decision`, never computed from `findings`' severities.
 * Severity thresholds are deliberately the CALLER's business — encoded in the
 * judge's own prompt ("FAIL if any finding is high or above"), not baked into
 * this engine, because "what severity blocks" is domain vocabulary that
 * differs per gate (a security review and a style lint don't share a bar).
 * `summary`/`findings` are informational only, persisted so an operator
 * reading a FAILED gate learns WHY it failed, not just THAT it failed.
 */
export interface JudgeVerdict {
  decision: "PASS" | "FAIL"
  summary?: string
  findings?: VerdictFinding[]
}

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
   * (e.g. `"completed"`, `"cancelled"`, `"max_turns"`, `"error"` when the
   * adapter reported a failed turn — e.g. a 401 surfaced as a stopReason
   * `"refusal"` — or `"watchdog-timeout"` when the ACP client's turn-idle
   * watchdog fired
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
  /** Mirrors `SessionDescriptor.endedReason` — set when this exit was NOT an
   *  operator targeting the session: `"daemon-restart"` (the daemon dying
   *  underneath it — crash-discovered-at-boot or a forced shutdown kill) or
   *  `"idle-reaped"` (the idle-session reaper retiring a long-idle row to free
   *  the adapter process, PR-6), or `"crashed"` (the crash-detect sweep found
   *  the adapter's OS process gone between turns). Lets a watcher
   *  (completion-policy supervisor, `session_monitor`) tell an automatic
   *  teardown apart from a deliberate kill. Absent otherwise. */
  reason?: "daemon-restart" | "idle-reaped" | "crashed"
}

/**
 * Emitted when the idle-session reaper (PR-6) retires a long-idle agent-cli
 * session: it SIGTERMs the adapter child to free the process and flips the row
 * to `killed`/`endedReason:"idle-reaped"`, leaving it dead-but-lazy-resumable
 * (a later prompt revives it in place via `maybeResumeAgent`). Distinct from
 * `session:exited` (which also fires, carrying `reason:"idle-reaped"`) in that
 * this event names the reaper as the actor and never fires for an operator
 * kill, a natural exit, or a daemon-restart death — so a monitor can react to
 * "the daemon reclaimed my idle session" specifically. `idleMs` is how long the
 * session had been idle (last-activity → reap) when it was retired. Rides the
 * same bus fan-out as every other lifecycle event (`session_events_poll`, the
 * webhook notifier, the routine engine, `session_monitor`).
 */
export interface SessionReapedEvent {
  type: "session:reaped"
  sessionId: string
  idleMs: number
  label?: string
  ts: string
}

/**
 * Emitted by the turn-liveness watchdog (`runStallWatchdogPass`) when a
 * mid-turn agent-cli session's adapter stream has gone silent past the
 * configured threshold: `busy:true`, not legitimately `blockedOn` a
 * subagent/command, and no `lastActivityAt` traffic since. The target
 * failure mode is a DEAD adapter stream — zero frames mid-turn, e.g. a
 * network drop — that otherwise leaves the row `status:"running"`,
 * `lastError:null`, indistinguishable from healthy long work except by
 * manually comparing `lastActivityAt` to the clock. Detection + signal
 * ONLY: nothing here kills or restarts the session (unlike `session:reaped`
 * / crash-detect's `session:exited`). `stalledSinceMs` is the epoch ms of
 * the last real activity that was observed before the trip — a consumer
 * computes "silent for" as `Date.now() - stalledSinceMs`. Same bus
 * distribution as every other lifecycle event (`session_events_poll`, the
 * webhook notifier, the routine engine, `session_monitor`). Paired with
 * `session:stall-cleared` when the flag is later cleared.
 */
export interface SessionStalledEvent {
  type: "session:stalled"
  sessionId: string
  stalledSinceMs: number
  label?: string
  ts: string
}

/**
 * Emitted when a session's `stalledSinceMs` flag (see {@link
 * SessionStalledEvent}) is cleared — by new adapter activity
 * (`pulseActivity`), the next turn starting, or the turn's own `finally`
 * (busy flips false, so "mid-turn and silent" no longer holds either way).
 * Does NOT imply the earlier trip was a false alarm — recovery from a
 * genuinely dead stream normally happens via the turn eventually erroring
 * out or being killed, not via a resumed stream; a clear immediately
 * followed by fresh `lastActivityAt` traffic is the "it wasn't actually
 * dead" case. Same bus distribution as every other lifecycle event.
 */
export interface SessionStallClearedEvent {
  type: "session:stall-cleared"
  sessionId: string
  label?: string
  ts: string
}

/**
 * Emitted when a dead agent-cli row is brought back IN PLACE — same session
 * id, same descriptor — by the lazy resume-on-prompt path (`maybeResumeAgent`)
 * today, and by the future eager resume-on-boot pass (PR-4). Distinct from
 * `session:spawned` (a brand-new id) and from `session:exited` (the death this
 * recovers from): a watcher (completion-policy supervisor, `session_monitor`)
 * uses it to learn the session is promptable again without polling.
 *
 * `interrupted` mirrors the derived interrupted-turn marker (§4): `true` when
 * the session died with a turn in flight (`killedMidTurn`) under a daemon
 * restart, so the consumer can tell "back and idle" from "back with dropped
 * work that was NOT re-run — a re-prompt is required to continue." This path
 * NEVER auto-retries the interrupted prompt (a prompt is not idempotent). See
 * the interrupted-turn contract in the session-survivability plan.
 *
 * `resumedFrom` records what the row was recovering from: `"daemon-restart"`
 * for the lazy/eager prompt-path revival (the only reason an in-place resume
 * fired before PR-2), or `"restarted"` for a PROACTIVE revival the restart-
 * scheduler (PR-2, `restart-scheduler.ts`) drove off an opt-in `restartPolicy`
 * after a `"crashed"`/unexpected `"error"` death — distinct so a watcher can
 * tell "the daemon came back and revived me" from "I crashed and my own
 * policy brought me back". Same bus distribution as every other lifecycle
 * event (`session_events_poll`, the webhook notifier, the routine engine,
 * `session_monitor`).
 *
 * `contextRestored` (resume-honesty fix): `false` when the resumed adapter
 * declared `capabilities.resumable: false` (`SessionDescriptor.resumable`) —
 * the in-place revival got a live process back, but the adapter could NOT
 * rehydrate the prior conversation from `adapterSessionId`, so this is a
 * blank session wearing the old one's id, not a continued one. Omitted
 * (never `false`) when the adapter is resumable (`true`/unknown — the
 * default, unchanged for claude-code and every other happy path), so an
 * existing consumer that ignores this field sees no behaviour change.
 */
export interface SessionResumedEvent {
  type: "session:resumed"
  sessionId: string
  interrupted: boolean
  resumedFrom: "daemon-restart" | "restarted"
  contextRestored?: false
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
  /** Always `true` — this event only fires from the human-driven rename
   *  write-path. Lets a live client update `renamedByUser` on its cached
   *  descriptor so the label wins the display chain without a full re-poll. */
  renamedByUser?: boolean
  ts: string
}

/**
 * Emitted when a session is first registered in the registry (WP-R3) — both
 * the agent-cli spawn path (`spawnAgent`) and the terminal path (`spawnPty`).
 * The lineage-attribution signal a live UI (the VS Code sessions tree) uses to
 * nest a fresh child under its `parentSessionId` node the moment it appears,
 * without waiting for its next full snapshot poll. `depth` is always present
 * (0 for a root/parentless session); `parentSessionId` is absent for a root.
 * Rides the same bus fan-out as every other lifecycle event
 * (`session_events_poll`, the webhook notifier, the routine engine).
 */
export interface SessionSpawnedEvent {
  type: "session:spawned"
  sessionId: string
  parentSessionId?: string
  label?: string
  depth: number
  ts: string
}

/** Emitted by the supervisor when a completion policy's gate passes. */
export interface PolicyPassedEvent {
  type: "policy:passed"
  policyId: string
  sessionId: string
  /** The judge's structured verdict (WP-D), when the gate was a judge gate
   *  and the judge emitted a parseable one. Absent for shell/cost gates. */
  verdict?: JudgeVerdict
  ts: string
}

/** Emitted by the supervisor when a completion policy's gate fails. */
export interface PolicyFailedEvent {
  type: "policy:failed"
  policyId: string
  sessionId: string
  exitCode?: number
  /** The judge's structured verdict (WP-D), when the gate was a judge gate
   *  and the judge emitted a parseable one. Absent for shell/cost gates, and
   *  for a judge gate whose reply was unparseable (fail-safe FAIL). */
  verdict?: JudgeVerdict
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

/**
 * Emitted by the activity projector (`activities.ts`) whenever an
 * {@link ActivityRecord}'s state or waitingOn actually changed — the ONE
 * new event the Activity ledger adds. Because EventRing wires via `onAny`,
 * `session_events_poll`, SSE `/events`, and the webhook notifier all carry
 * this for free. The `activity` payload is the freshly-projected record
 * (deterministic id), never a diff.
 */
export interface ActivityChangedEvent {
  type: "activity:changed"
  activity: ActivityRecord
  ts: string
}

/**
 * Emitted by the Task ledger (`task-ledger.ts`) whenever a task record
 * actually changed — created, claimed (the CAS win), a status transition
 * (including a Tier-1 verify gate settling, green or red), an owner release
 * (voluntary or owner-death), or a field edit. One event per accepted
 * write. Because EventRing wires via `onAny`, `session_events_poll`, SSE
 * `/events`, the webhook notifier, and `session_monitor` all carry it for
 * free. `sessionId` is the acting/affected session when one is involved
 * (the claimer, the released owner) — absent for pure operator gestures.
 */
export interface TaskChangedEvent {
  type: "task:changed"
  taskId: string
  boardId: string
  change: "created" | "claimed" | "status" | "released" | "edited"
  status: TaskStatus
  rev: number
  sessionId?: string
  ts: string
}

export type SessionEvent =
  | SessionTurnEndEvent
  | SessionAwaitingInputEvent
  | SessionPermissionRequestEvent
  | SessionPermissionResolvedEvent
  | SessionExitedEvent
  | SessionReapedEvent
  | SessionStalledEvent
  | SessionStallClearedEvent
  | SessionResumedEvent
  | SessionSpawnedEvent
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
  | ActivityChangedEvent
  | TaskChangedEvent

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
