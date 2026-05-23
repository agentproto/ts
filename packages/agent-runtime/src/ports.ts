/**
 * Port contracts for the MultiAgentRuntime kernel.
 *
 * A runtime composes a Substrate + Dispatcher + StateStore + Participant
 * Executors (one per `executor` kind). Each adapter declares its `kind`;
 * the kernel dispatches polymorphically by looking up factories in the
 * registry, never by matching kind strings inside the kernel itself.
 */

export type ParticipantId = string
export type TurnId = string

export type Turn = {
  readonly id: TurnId
  readonly participantId: ParticipantId
  readonly content: string
  readonly timestamp: string
  readonly meta?: Readonly<Record<string, unknown>>
}

export type TurnInput = Omit<Turn, "id" | "timestamp"> & {
  readonly timestamp?: string
}

// ── Substrate ──

export interface Substrate {
  readonly kind: string
  /** Append a turn. Returns the materialised Turn with id + timestamp. */
  append(turn: TurnInput): Promise<Turn>
  /** Snapshot. If `since` is provided, returns turns strictly newer than that TurnId, oldest first. */
  read(since?: TurnId): Promise<readonly Turn[]>
}

// ── Participant ──

export type ParticipantDescriptor = {
  readonly id: ParticipantId
  readonly displayName: string
  /** Executor kind — keys into RuntimePorts.executors. e.g. "agent-cli". */
  readonly executor: string
  readonly role?: string
  readonly meta?: Readonly<Record<string, unknown>>
}

export type ParticipantExecuteInput = {
  readonly participant: ParticipantDescriptor
  readonly recentTurns: readonly Turn[]
  readonly triggerTurn: Turn
  readonly state: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

export type ParticipantExecuteOutput = {
  readonly content: string
  readonly meta?: Readonly<Record<string, unknown>>
  readonly stateUpdate?: Readonly<Record<string, unknown>>
}

export interface ParticipantExecutor {
  readonly kind: string
  executeTurn(input: ParticipantExecuteInput): Promise<ParticipantExecuteOutput>
}

// ── Dispatcher ──

export type DispatcherInput = {
  readonly recentTurns: readonly Turn[]
  readonly participants: readonly ParticipantDescriptor[]
}

export interface Dispatcher {
  readonly kind: string
  /**
   * Inspect recent turns and return the participants who should speak next.
   * Empty array = no one speaks, the runtime stays idle.
   */
  selectNext(input: DispatcherInput): Promise<readonly ParticipantId[]>
}

// ── State ──

export interface StateStore {
  readonly kind: string
  read(participantId: ParticipantId): Promise<Readonly<Record<string, unknown>>>
  write(
    participantId: ParticipantId,
    state: Readonly<Record<string, unknown>>
  ): Promise<void>
}

// ── Lifecycle ──

export interface Lifecycle {
  onTurnEnd?(turn: Turn): Promise<void> | void
  onMention?(target: ParticipantId, byTurn: Turn): Promise<void> | void
  onIdle?(): Promise<void> | void
}

// ── Telemetry ──

/**
 * Discriminated union of every event the kernel emits during a cycle.
 *
 * Every event carries `cycleId` (a per-cycle ULID-ish identifier) and
 * `at` (ISO timestamp), so a sink can rebuild OTEL-style spans by
 * grouping on cycleId.
 *
 * Sinks MUST tolerate unknown kinds — future kernel versions may add
 * event types under the same `agentproto/telemetry/v1` schema.
 */
export type TelemetryEvent =
  | {
      readonly kind: "cycle.started"
      readonly cycleId: string
      readonly at: string
      readonly since?: TurnId
    }
  | {
      readonly kind: "substrate.read"
      readonly cycleId: string
      readonly at: string
      readonly substrateKind: string
      readonly turnCount: number
      readonly durationMs: number
    }
  | {
      readonly kind: "dispatch.decided"
      readonly cycleId: string
      readonly at: string
      readonly dispatcherKind: string
      readonly selected: readonly ParticipantId[]
      readonly durationMs: number
    }
  | {
      readonly kind: "participant.started"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
    }
  | {
      readonly kind: "participant.finished"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
      readonly durationMs: number
      readonly contentLength: number
    }
  | {
      readonly kind: "participant.failed"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
      readonly executorKind: string
      readonly error: string
    }
  | {
      readonly kind: "substrate.appended"
      readonly cycleId: string
      readonly at: string
      readonly turnId: TurnId
      readonly participantId: ParticipantId
    }
  | {
      readonly kind: "state.written"
      readonly cycleId: string
      readonly at: string
      readonly participantId: ParticipantId
    }
  | {
      readonly kind: "cycle.idle"
      readonly cycleId: string
      readonly at: string
    }
  | {
      readonly kind: "cycle.finished"
      readonly cycleId: string
      readonly at: string
      readonly outcome: "executed" | "idle"
      readonly turnsAppended: number
      readonly durationMs: number
    }

export interface Telemetry {
  emit(event: TelemetryEvent): void
}

// ── Composed runtime ──

export type RuntimePorts = {
  readonly substrate: Substrate
  readonly dispatcher: Dispatcher
  readonly state: StateStore
  readonly lifecycle?: Lifecycle
  /**
   * Optional structured-event sink. Wire to log lines, an OTEL exporter,
   * an in-memory array (tests), or anything else. When omitted, the
   * kernel skips emission entirely — zero overhead.
   */
  readonly telemetry?: Telemetry
  readonly participants: readonly ParticipantDescriptor[]
  readonly executors: ReadonlyMap<string, ParticipantExecutor>
}
