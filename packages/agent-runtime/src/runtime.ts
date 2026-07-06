/**
 * Runtime orchestrator. One cycle =
 *   read substrate → dispatch → execute selected participants → append → fire lifecycle.
 *
 * The kernel knows nothing about specific substrates, dispatchers, or
 * executors — it only routes through the port interfaces. Telemetry,
 * if wired, receives a structured event at every phase boundary; the
 * cycleId on each event lets a sink rebuild OTEL-style spans by
 * grouping.
 */

import { randomBytes } from "node:crypto"
import type {
  ParticipantDescriptor,
  RuntimePorts,
  Telemetry,
  TelemetryEvent,
  Turn,
  TurnId,
} from "./ports.js"

export type RunTurnOptions = {
  /** How far back to read from the substrate when building dispatcher input. Default 30. */
  readonly historyLimit?: number
  /** Read turns strictly newer than this id. Default undefined (full snapshot, truncated by historyLimit). */
  readonly since?: TurnId
  /** Abort signal forwarded to participant executors. */
  readonly signal?: AbortSignal
}

export type RunTurnResult = {
  readonly cycle: "executed" | "idle"
  readonly selected: readonly string[]
  readonly turnsAppended: readonly Turn[]
}

/**
 * Run a single dispatcher cycle. Returns synchronously after one round of
 * dispatch + execute + append. Callers loop for continuous operation.
 */
export async function runTurn(
  ports: RuntimePorts,
  options: RunTurnOptions = {}
): Promise<RunTurnResult> {
  const historyLimit = options.historyLimit ?? 30
  const cycleId = newCycleId()
  const cycleStart = Date.now()

  emit(ports.telemetry, {
    kind: "cycle.started",
    cycleId,
    at: nowIso(),
    ...(options.since !== undefined ? { since: options.since } : {}),
  })

  const readStart = Date.now()
  const all = await ports.substrate.read(options.since)
  const recentTurns = all.slice(-historyLimit)
  emit(ports.telemetry, {
    kind: "substrate.read",
    cycleId,
    at: nowIso(),
    substrateKind: ports.substrate.kind,
    turnCount: recentTurns.length,
    durationMs: Date.now() - readStart,
  })

  const dispatchStart = Date.now()
  const selected = await ports.dispatcher.selectNext({
    recentTurns,
    participants: ports.participants,
  })
  emit(ports.telemetry, {
    kind: "dispatch.decided",
    cycleId,
    at: nowIso(),
    dispatcherKind: ports.dispatcher.kind,
    selected,
    durationMs: Date.now() - dispatchStart,
  })

  if (selected.length === 0) {
    await ports.lifecycle?.onIdle?.()
    emit(ports.telemetry, { kind: "cycle.idle", cycleId, at: nowIso() })
    emit(ports.telemetry, {
      kind: "cycle.finished",
      cycleId,
      at: nowIso(),
      outcome: "idle",
      turnsAppended: 0,
      durationMs: Date.now() - cycleStart,
    })
    return { cycle: "idle", selected: [], turnsAppended: [] }
  }

  const triggerTurn = recentTurns[recentTurns.length - 1]
  if (!triggerTurn) {
    // Dispatcher selected someone but there's no recent turn to trigger off.
    // Treat as idle — dispatchers should not pick speakers from an empty substrate.
    await ports.lifecycle?.onIdle?.()
    emit(ports.telemetry, { kind: "cycle.idle", cycleId, at: nowIso() })
    emit(ports.telemetry, {
      kind: "cycle.finished",
      cycleId,
      at: nowIso(),
      outcome: "idle",
      turnsAppended: 0,
      durationMs: Date.now() - cycleStart,
    })
    return { cycle: "idle", selected: [], turnsAppended: [] }
  }

  const appended: Turn[] = []

  for (const participantId of selected) {
    const participant = findParticipant(ports.participants, participantId)
    if (!participant) {
      // Dispatcher hallucinated an unknown participant. Skip rather than crash —
      // a malformed dispatcher shouldn't take down the loop.
      continue
    }
    const executor = ports.executors.get(participantId)
    if (!executor) {
      // Manifest declared a participant whose executor isn't registered.
      // Skip; misconfiguration shows up in logs but the loop survives.
      continue
    }

    await ports.lifecycle?.onMention?.(participantId, triggerTurn)

    const state = await ports.state.read(participantId)

    emit(ports.telemetry, {
      kind: "participant.started",
      cycleId,
      at: nowIso(),
      participantId,
      executorKind: participant.executor,
    })

    const execStart = Date.now()
    let output
    try {
      output = await executor.executeTurn({
        participant,
        recentTurns,
        triggerTurn,
        state,
        signal: options.signal,
      })
    } catch (err) {
      emit(ports.telemetry, {
        kind: "participant.failed",
        cycleId,
        at: nowIso(),
        participantId,
        executorKind: participant.executor,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    emit(ports.telemetry, {
      kind: "participant.finished",
      cycleId,
      at: nowIso(),
      participantId,
      executorKind: participant.executor,
      durationMs: Date.now() - execStart,
      contentLength: output.content.length,
    })

    const turn = await ports.substrate.append({
      participantId,
      content: output.content,
      meta: output.meta,
    })
    appended.push(turn)
    emit(ports.telemetry, {
      kind: "substrate.appended",
      cycleId,
      at: nowIso(),
      turnId: turn.id,
      participantId,
    })

    if (output.stateUpdate) {
      await ports.state.write(participantId, output.stateUpdate)
      emit(ports.telemetry, {
        kind: "state.written",
        cycleId,
        at: nowIso(),
        participantId,
      })
    }

    await ports.lifecycle?.onTurnEnd?.(turn)
  }

  emit(ports.telemetry, {
    kind: "cycle.finished",
    cycleId,
    at: nowIso(),
    outcome: "executed",
    turnsAppended: appended.length,
    durationMs: Date.now() - cycleStart,
  })

  return { cycle: "executed", selected, turnsAppended: appended }
}

function findParticipant(
  participants: readonly ParticipantDescriptor[],
  id: string
): ParticipantDescriptor | undefined {
  for (const p of participants) {
    if (p.id === id) return p
  }
  return undefined
}

function emit(telemetry: Telemetry | undefined, event: TelemetryEvent): void {
  // Sinks throwing must not take down the cycle — observability is
  // non-load-bearing for the conversation.
  if (!telemetry) return
  try {
    telemetry.emit(event)
  } catch {
    // Swallow. Better to lose a metric than to corrupt a turn.
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function newCycleId(): string {
  // 96-bit random id, base32-ish — short enough to read, wide enough
  // to be unique within a swarm process's lifetime.
  return `c_${randomBytes(6).toString("hex")}`
}
