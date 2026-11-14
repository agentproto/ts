/**
 * Approval wake: when a human decides an approval that named a wake target
 * (`ApprovalRecord.wake`), re-prompt that session, or the newest live session
 * carrying that agent label, instead of leaving the requester to poll.
 *
 * The target is resolved at decision time, like a cron's `agent` target: a
 * session that was relaunched since the request is reached through its
 * successor chain or its label. A busy target gets the notice queued as its own
 * turn (never an interrupt). No live target means no-op: the approval record
 * stays the source of truth.
 */

import type { SessionDescriptor } from "../sessions.js"
import { createSessionMessage, type SessionMessage } from "../session-message.js"
import type { SessionEventBus } from "../session-event-bus.js"
import { isRetired, resolveSuccessor } from "../session-retirement.js"
import type { ApprovalRecord } from "./types.js"

export interface ApprovalWakeRegistry {
  get(id: string): SessionDescriptor | undefined
  list(opts?: { includeArchived?: boolean }): SessionDescriptor[]
  sendMessage(msg: SessionMessage, opts?: { source?: string; origin?: string }): Promise<unknown>
}

const isLive = (d: SessionDescriptor | undefined): boolean =>
  !!d && !isRetired(d) && (d.status === "running" || d.status === "starting")

function newestLiveWithLabel(registry: ApprovalWakeRegistry, label: string): SessionDescriptor | undefined {
  const want = label.trim().toLowerCase()
  if (!want) return undefined
  return registry
    .list({ includeArchived: true })
    .filter(d => isLive(d) && (d.label?.trim().toLowerCase() === want || d.operatorLabel?.trim().toLowerCase() === want))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.id.localeCompare(a.id))[0]
}

export function resolveWakeTarget(
  registry: ApprovalWakeRegistry,
  wake: NonNullable<ApprovalRecord["wake"]>,
): SessionDescriptor | undefined {
  if (wake.agent) {
    const byLabel = newestLiveWithLabel(registry, wake.agent)
    if (byLabel) return byLabel
  }
  if (!wake.sessionId) return undefined
  const own = registry.get(wake.sessionId)
  if (own && isLive(own)) return own
  const successorId = resolveSuccessor(id => registry.get(id), wake.sessionId)
  const successor = successorId ? registry.get(successorId) : undefined
  if (successor && isLive(successor)) return successor
  const label = own?.operatorLabel ?? own?.label
  return label ? newestLiveWithLabel(registry, label) : undefined
}

export function wireApprovalWake(opts: {
  registry: ApprovalWakeRegistry
  sessionEvents: SessionEventBus
  getApproval: (id: string) => ApprovalRecord | undefined
}): () => void {
  const { registry, sessionEvents, getApproval } = opts
  return sessionEvents.on("approval:decided", ev => {
    const record = getApproval(ev.approvalId)
    if (!record?.wake) return
    const target = resolveWakeTarget(registry, record.wake)
    if (!target) return
    const verdict = ev.decision === "approved" ? "approved" : "refused"
    const text = `[Approbation ${record.id} décidée : ${verdict}] ${record.title}. Relis son état (kind ${record.kind}) et poursuis.`
    if (target.promptQueue?.some(p => p.message === text)) return
    const provenance = `approval:${record.id}`
    void registry
      .sendMessage(
        createSessionMessage({
          to: target.id,
          from: { relation: "system" },
          text,
          kind: "notice",
          urgency: "next-turn",
        }),
        { source: provenance, origin: provenance },
      )
      .catch(() => {})
  })
}
