/**
 * Session completion derivation and wiring for the host event
 * `agentproto:session-completed`.
 *
 * A session completes when it is terminal AND either its recorded outcome
 * says completed or a completion policy passed for it. The event fires at
 * most once per terminal transition, after `session:exited`; the occurrence
 * id `exit:<endedAt>` names that transition. The same pure derivation is what
 * boot reconciliation will call later to check that a pending receipt's
 * trigger is still valid.
 *
 * The exit funnel flips the row terminal and emits `session:exited` BEFORE a
 * terminal path layers its Level-2 (judged/declared/operator) outcome, so the
 * exit-time read sees no completion verdict for the primary completion paths
 * (a steward close, an operator "mark as completed"). The wiring therefore
 * also subscribes to `session:outcome-recorded` and re-derives from the now
 * updated descriptor; the occurrence id deduplicates the two triggers.
 */

import type {
  SessionCompletedEvent,
  SessionEventBus,
  PolicyPassedEvent,
  SessionExitedEvent,
  SessionOutcomeRecordedEvent,
} from "../session-event-bus.js"
import { isOutcomeCompleted } from "../session-outcome.js"

const TERMINAL_STATUSES = new Set(["exited", "killed", "error"])
const MAX_EMITTED = 5_000
const MAX_REMEMBERED_POLICY = 1_000

/** `exit:<endedAt>` when `endedAt` is usable, else undefined. */
export function sessionCompletionOccurrenceId(endedAt: string | undefined): string | undefined {
  if (typeof endedAt !== "string" || endedAt.length === 0) return undefined
  if (/\s/.test(endedAt) || endedAt.includes("/")) return undefined
  return `exit:${endedAt}`
}

export interface SessionCompletionFacts {
  status: string
  endedAt?: string
  outcome?: { verdict?: string; termination?: { reason?: string } }
}

export interface SessionCompletionResult {
  occurrenceId: string
  basis: "outcome" | "policy"
  endedAt: string
}

/** Decide whether a session's terminal transition is a completion. Pure. */
export function deriveSessionCompletion(
  facts: SessionCompletionFacts,
  opts?: { policyPassed?: boolean },
): SessionCompletionResult | undefined {
  if (!TERMINAL_STATUSES.has(facts.status)) return undefined
  const endedAt = facts.endedAt
  const occurrenceId = sessionCompletionOccurrenceId(endedAt)
  if (occurrenceId === undefined || endedAt === undefined) return undefined
  if (isOutcomeCompleted(facts.outcome)) return { occurrenceId, basis: "outcome", endedAt }
  if (opts?.policyPassed) return { occurrenceId, basis: "policy", endedAt }
  return undefined
}

export interface SessionCompletionWiring {
  bus: SessionEventBus
  getSession: (sessionId: string) => (SessionCompletionFacts & { label?: string }) | undefined
  /** Used only for the event `ts`. */
  now?: () => Date
  log?: (line: string) => void
}

/**
 * Subscribe to the bus and return the unsubscribe function.
 *
 * Emission is synchronous inside the triggering dispatch. A `session:exited`
 * listener that was registered BEFORE this wiring runs before
 * `agentproto:session-completed`; one registered AFTER it runs after the
 * completion event, even though completion is logically "after the exit".
 * Register any strict after-exit work before wiring this, or subscribe to
 * `agentproto:session-completed` instead.
 */
export function wireSessionCompletion(w: SessionCompletionWiring): () => void {
  const now = w.now ?? (() => new Date())
  const log = w.log ?? ((line: string) => console.warn(line))

  // Best-effort in-process latch: it only prevents a double emit inside this
  // process. Durable deduplication is the receipt store's job later.
  const emitted = new Set<string>()
  const rememberPolicy = new Set<string>()

  const remember = (set: Set<string>, key: string, max: number): void => {
    set.add(key)
    if (set.size > max) {
      const oldest = set.values().next()
      if (!oldest.done) set.delete(oldest.value)
    }
  }

  const emitIfNew = (
    sessionId: string,
    facts: SessionCompletionFacts & { label?: string },
    policyPassed: boolean,
  ): void => {
    const derived = deriveSessionCompletion(facts, policyPassed ? { policyPassed: true } : undefined)
    if (!derived) return
    const key = `${sessionId}/${derived.occurrenceId}`
    if (emitted.has(key)) return
    remember(emitted, key, MAX_EMITTED)
    const event: SessionCompletedEvent = {
      type: "agentproto:session-completed",
      sessionId,
      occurrenceId: derived.occurrenceId,
      basis: derived.basis,
      endedAt: derived.endedAt,
      ...(facts.label ? { label: facts.label } : {}),
      ts: now().toISOString(),
    }
    try {
      w.bus.emit(event)
    } catch (err) {
      log(
        `[session-completion] emitting ${sessionId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // A terminal transition consumes any policy latch for this session — keyed
  // by session id, it must never survive into a later revival. Delete BEFORE
  // the lookup so an unknown session cannot leave a stale latch behind.
  const consumePolicy = (sessionId: string): boolean => {
    const passed = rememberPolicy.has(sessionId)
    rememberPolicy.delete(sessionId)
    return passed
  }

  const onExited = (ev: SessionExitedEvent): void => {
    const policyPassed = consumePolicy(ev.sessionId)
    try {
      const facts = w.getSession(ev.sessionId)
      if (!facts) return
      emitIfNew(ev.sessionId, facts, policyPassed)
    } catch (err) {
      log(
        `[session-completion] handling exit of ${ev.sessionId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // The exit funnel fires before a terminal path layers its Level-2 outcome,
  // so this is where a steward close / operator "mark as completed" is seen.
  const onOutcomeRecorded = (ev: SessionOutcomeRecordedEvent): void => {
    const policyPassed = consumePolicy(ev.sessionId)
    try {
      const facts = w.getSession(ev.sessionId)
      if (!facts) return
      emitIfNew(ev.sessionId, facts, policyPassed)
    } catch (err) {
      log(
        `[session-completion] handling outcome write of ${ev.sessionId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const onPolicyPassed = (ev: PolicyPassedEvent): void => {
    try {
      const facts = w.getSession(ev.sessionId)
      if (!facts) {
        rememberPolicy.delete(ev.sessionId)
        return
      }
      if (TERMINAL_STATUSES.has(facts.status)) {
        emitIfNew(ev.sessionId, facts, true)
      } else {
        remember(rememberPolicy, ev.sessionId, MAX_REMEMBERED_POLICY)
      }
    } catch (err) {
      log(
        `[session-completion] handling policy pass of ${ev.sessionId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const unsubExit = w.bus.on("session:exited", onExited)
  const unsubOutcome = w.bus.on("session:outcome-recorded", onOutcomeRecorded)
  const unsubPolicy = w.bus.on("policy:passed", onPolicyPassed)
  return () => {
    unsubExit()
    unsubOutcome()
    unsubPolicy()
  }
}
