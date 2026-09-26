/**
 * Supervisor crash-notification (PR-4 of the crash-detect chantier).
 *
 * A crashed agent-cli session already gets discovered and marked by the
 * crash-detect sweep (`crash-reaper.ts`, PR-1) — `markCrashed` flips the row
 * to `status:"error"`/`endedReason:"crashed"` and emits `session:exited`.
 * But nothing tells the SUPERVISOR (the session that spawned it, if any):
 * the parent's own transcript never mentions the death, and it has no
 * reason to poll for it.
 *
 * This module hangs a small subscriber off the once-guarded `session:exited`
 * emission (`emitExited`'s `exitedEmitted` guard — the bus itself does NOT
 * dedup, see sessions.ts) and, for the unexpected-death set only
 * (`status:"error"` or `reason:"crashed"`), delivers a `[child-crashed] …`
 * notice to the crashed child's parent — but ONLY when the child opted in
 * (`notifyParentOnCrash`, default false) and a parent is actually resolvable.
 *
 * The delivery itself never interrupts a busy parent: `enqueuePrompt`/
 * `sendPrompt` reject a busy session unless `interrupt:true`, and
 * `interrupt` cancels the parent's in-flight turn — an automatic crash
 * notice earns neither. So:
 *   The notice travels as a daemon-attested typed message
 *   (`relation:"system"`, `kind:"blocker"`, `urgency:"next-turn"`) through
 *   `registry.sendMessage`:
 *   - parent alive (`running`/`starting`) AND idle (`!busy`) → delivered as
 *     its own turn now (no `interrupt`).
 *   - parent alive AND busy → the notice is parked as its own item in the
 *     parent's prompt queue (`enqueuePrompt({queue:true})`) and drained as a
 *     SEPARATE turn when the current one ends — never concatenated onto the
 *     parent's next prompt, and never stranded until one arrives.
 *   Either way the parent's transcript records a `session-message` from
 *   `system`, never a user prompt.
 *   - parent missing/dead, no `parentSessionId`, or the child didn't opt in
 *     → no-op. The free external webhook path (`webhookNotifier`, gated on
 *     `notifyUrl` alone) already covers external notification regardless of
 *     any of this — this module is the OPTIONAL direct in-band signal on
 *     top of it.
 */

import type { SessionDescriptor } from "./sessions.js"
import { createSessionMessage, type SessionMessage } from "./session-message.js"
import type { SessionEventBus, SessionExitedEvent } from "./session-event-bus.js"

/** The slice of the sessions registry this subscriber needs. Structural so
 *  the wiring is a pure, unit-testable function decoupled from the full
 *  registry surface — same shape as `crash-reaper.ts`'s `CrashReaperRegistry`. */
export interface SupervisorNotifyRegistry {
  get(id: string): SessionDescriptor | undefined
  // Return is ignored here (delivery is fire-and-forget) — kept as
  // `Promise<unknown>` so the full `SessionsRegistry` (whose `sendMessage`
  // resolves a `SendMessageResult`) satisfies this structural slice.
  sendMessage(
    msg: SessionMessage,
    opts?: { source?: string; origin?: string },
  ): Promise<unknown>
}

/** True iff this exit is the unexpected-death set this module reacts to —
 *  a genuine crash, not an operator kill / natural exit / idle-reap. */
function isUnexpectedDeath(ev: SessionExitedEvent): boolean {
  return ev.status === "error" || ev.reason === "crashed"
}

/** Compose the `[child-crashed] <label/id>: <reason> — <lastError>` notice
 *  text delivered to the parent. `lastError` (stamped by `markCrashed`) is
 *  appended when present; the reason alone is still informative without it. */
function formatCrashNotice(child: SessionDescriptor, ev: SessionExitedEvent): string {
  const who = child.label ?? child.id
  const reason = ev.reason ?? "crashed"
  const detail = child.lastError ? ` — ${child.lastError}` : ""
  return `[child-crashed] ${who}: ${reason}${detail}`
}

/** Wire the subscriber onto `sessionEvents`. Returns the unsubscribe fn
 *  (same contract as `SessionEventBus.on`), for symmetry with the gateway's
 *  other bus subscriptions even though nothing tears it down today. */
export function wireSupervisorNotify(opts: {
  registry: SupervisorNotifyRegistry
  sessionEvents: SessionEventBus
}): () => void {
  const { registry, sessionEvents } = opts
  return sessionEvents.on("session:exited", ev => {
    if (!isUnexpectedDeath(ev)) return
    const child = registry.get(ev.sessionId)
    if (!child) return
    if (!child.notifyParentOnCrash) return
    const parentId = child.parentSessionId
    // Guard against self/loops: a session can't be its own parent, but stay
    // defensive rather than trust that invariant blindly here.
    if (!parentId || parentId === child.id) return
    const parent = registry.get(parentId)
    if (!parent) return
    const parentAlive = parent.status === "running" || parent.status === "starting"
    if (!parentAlive) return
    const notice = formatCrashNotice(child, ev)
    // Idempotent across a duplicate event for the same crash: the exact
    // notice already waiting (queued, or parked in the inbox) is never sent
    // twice.
    if (parent.promptQueue?.some(p => p.message === notice)) return
    if (parent.inbox?.some(m => m.text === notice)) return
    const provenance = `child:${child.id}`
    // A daemon-attested `system` message (the child is dead — it isn't the
    // sender): kind `blocker`, urgency `next-turn` — delivered as its own
    // turn now on an idle parent, or after the busy parent's current turn.
    // Never `interrupt`/`steer`: a crash notice never cuts into a turn.
    // Fire-and-forget, same as every other automatic bus-driven delivery —
    // an error here would only mean the parent died in the race since the
    // alive check above; nothing left to report it to.
    void registry
      .sendMessage(
        createSessionMessage({
          to: parentId,
          from: { relation: "system" },
          text: notice,
          kind: "blocker",
          urgency: "next-turn",
        }),
        { source: provenance, origin: provenance },
      )
      .catch(() => {})
  })
}
