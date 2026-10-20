/**
 * Lineage handover - the generic mechanism that lets a SUCCESSOR session
 * take over a replaced session's children.
 *
 * The problem it solves: a persistent orchestrator (the "brain") is
 * sometimes replaced by a NEW session (daemon restart, wallet change,
 * continue-fresh). Its children (supervisors, executors) stay attached to the
 * OLD `parentSessionId`, so:
 *   - the new brain cannot drive them (`agent_prompt` refuses: "may only be
 *     driven by its owner"), and
 *   - they cannot report to it (`message_parent` fails: "no recorded
 *     parent" / "cannot identify the calling session").
 *
 * The mechanism is deliberately GENERIC: the successor takes over the
 * replaced session's POSITION in the spawn tree. Because every access
 * decision in the daemon already keys on the `parentSessionId` pointer
 * (the session-owner gate, `message_parent`'s parent resolution, the
 * subtree scoping), moving that ONE pointer moves the whole contract:
 *   - the successor becomes the children's OWNER (drive rights),
 *   - the children report to the successor (`message_parent`),
 *   - the replaced session loses those rights (it is gone anyway).
 *
 * Two ways a handover happens:
 *   1. AUTOMATIC - a session is created as the successor of another
 *      (continue-fresh, or an explicit `agent_start.succeeds` declaration).
 *   2. EXPLICIT - the `session_adopt` MCP verb
 *      (`{ childIds, from }`), reserved to the human operator and to the
 *      DECLARED successor of `from`.
 *
 * The declaration (`from.succeededBy = to` / `to.succeeds = from`) is
 * persisted on the descriptors, so "who is the successor of this row"
 * survives a daemon restart - which is what authorizes `session_adopt`.
 */

import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

/** Why a handover ran - recorded on the `session:lineage-handover` event. */
export type LineageHandoverReason = "continue-fresh" | "succeeds" | "session_adopt"

/** The outcome of one handover. */
export interface LineageHandoverOutcome {
  /** The replaced session. */
  from: string
  /** The successor session. */
  to: string
  /** Ids of the children re-parented to the successor. */
  adopted: string[]
  /** Ids of the children left where they were: not children of `from`, or
   *  not re-parentable (e.g. the move would create a cycle). The automatic
   *  handover only considers LIVE children, so a dead child shows up here
   *  only when it was named explicitly (`session_adopt`). */
  skipped: string[]
}

/** A session is LIVE when it can still be driven / report. */
export function isLiveSession(desc: Pick<SessionDescriptor, "status">): boolean {
  return desc.status === "running" || desc.status === "starting"
}

/**
 * The live children of `parentId` - the sessions whose `parentSessionId` is
 * `parentId` and that are still alive. Archived rows are included in the
 * scan (a dead-but-resumable child is still a child), but only live ones
 * are ever re-parented.
 */
export function liveChildrenOf(
  registry: Pick<SessionsRegistry, "list">,
  parentId: string,
): SessionDescriptor[] {
  return registry
    .list({ includeArchived: true })
    .filter(d => d.parentSessionId === parentId && isLiveSession(d))
}

/** Every child of `parentId`, live or not (id order for determinism). */
export function allChildrenOf(
  registry: Pick<SessionsRegistry, "list">,
  parentId: string,
): SessionDescriptor[] {
  return registry
    .list({ includeArchived: true })
    .filter(d => d.parentSessionId === parentId)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Re-parent the named children of `from` onto `to`.
 *
 * Only sessions that ARE currently children of `from` are moved (a caller
 * cannot adopt an unrelated session into someone else's tree); the rest are
 * reported as `skipped`. The handover also records the succession
 * declaration (`from.succeededBy = to`, `to.succeeds = from`) and emits the
 * `session:lineage-handover` event.
 *
 * `childIds` omitted ⇒ every LIVE child of `from` is moved (the automatic
 * handover); given ⇒ exactly those ids are considered (the explicit
 * `session_adopt`).
 */
export function handoverLineage(input: {
  registry: SessionsRegistry
  /** The replaced session. */
  from: string
  /** The successor session. */
  to: string
  /** Optional explicit child set - defaults to every live child of `from`. */
  childIds?: string[]
  reason: LineageHandoverReason
  /** Who asked for it - `"operator"` or a session id. */
  actor: string
}): LineageHandoverOutcome {
  const { registry, from, to, reason, actor } = input
  const outcome: LineageHandoverOutcome = { from, to, adopted: [], skipped: [] }
  if (from === to) return outcome
  const successor = registry.get(to)
  const replaced = registry.get(from)
  if (!successor || !replaced) return outcome

  const candidates = input.childIds
    ? input.childIds.map(id => registry.get(id)).filter((d): d is SessionDescriptor => d !== undefined)
    : liveChildrenOf(registry, from)
  const wanted = input.childIds
  for (const child of candidates) {
    if (child.id === to || child.parentSessionId !== from) {
      outcome.skipped.push(child.id)
      continue
    }
    try {
      registry.reassignParent(child.id, to)
      outcome.adopted.push(child.id)
    } catch {
      outcome.skipped.push(child.id)
    }
  }
  // An explicitly named child that does not exist (or is not a child of
  // `from`) is reported as skipped too - the caller asked for it by id.
  if (wanted) {
    for (const id of wanted) {
      if (outcome.adopted.includes(id) || outcome.skipped.includes(id)) continue
      outcome.skipped.push(id)
    }
  }
  // The declared succession - persisted, and the authorization key for
  // `session_adopt`.
  try {
    registry.setLineageSuccessor(from, to)
  } catch {
    // A failed declaration must not sink the re-parenting that already
    // happened (the children's rights are what matters most).
  }
  // The successor inherits the replaced session's own place in the tree when
  // it was spawned as its child (the `agent_start.succeeds` shape) or as a
  // root (an operator-spawned successor of a row that had a parent): the
  // replaced row is gone, so the successor takes its slot under the same
  // grandparent - the tree does not grow a dangling edge to a dead row.
  // An explicit parent the successor already carries (neither the replaced
  // row nor absent) is left alone: that is a deliberate placement.
  try {
    const inherits =
      successor.parentSessionId === from ||
      (successor.parentSessionId === undefined && replaced.parentSessionId !== undefined)
    if (inherits) {
      registry.reassignParent(to, replaced.parentSessionId)
    }
  } catch {
    // No grandparent (a root replacement) - nothing to inherit.
  }
  emitHandoverEvent(registry, outcome, reason, actor)
  return outcome
}

/** Emit the `session:lineage-handover` journal entry. */
function emitHandoverEvent(
  registry: SessionsRegistry,
  outcome: LineageHandoverOutcome,
  reason: LineageHandoverReason,
  actor: string,
): void {
  const emit = registry.emitLineageHandover
    ? registry.emitLineageHandover.bind(registry)
    : undefined
  if (!emit) return
  emit({
    type: "session:lineage-handover",
    sessionId: outcome.from,
    successorSessionId: outcome.to,
    adopted: outcome.adopted,
    skipped: outcome.skipped,
    reason,
    actor,
    ts: new Date().toISOString(),
  })
}

/**
 * Who may declare that `to` succeeds `from`?
 *
 * The human operator always may. The replaced session itself may (a brain
 * handing over its own position), and so may the replaced session's OWNER
 * (the session that spawned it - the human operator's proxy in the tree).
 * A third party - notably one of the children being handed over - may NOT:
 * that would let any subtree seize a sibling's position.
 */
export function checkSuccessorDeclaration(input: {
  /** The effective calling session id, or undefined for the operator. */
  callerSessionId: string | undefined
  /** The session being replaced. */
  from: SessionDescriptor
}): { ok: true } | { ok: false; message: string } {
  const { callerSessionId, from } = input
  if (callerSessionId === undefined) return { ok: true }
  if (callerSessionId === from.id) return { ok: true }
  if (from.parentSessionId && callerSessionId === from.parentSessionId) return { ok: true }
  return {
    ok: false,
    message:
      `only the human operator, the replaced session itself ("${from.id}"), or the ` +
      `session that owns it (${from.parentSessionId ?? "none - it is a root session"}) ` +
      `may declare a successor for it - this call came from session "${callerSessionId}".`,
  }
}

/**
 * Who may run `session_adopt` for `from`?
 *
 * The human operator always may. The DECLARED successor of `from` may -
 * i.e. the session recorded as `from.succeededBy` (the row that took over
 * `from`'s position). Nobody else: a child of `from` cannot adopt its
 * siblings, and an unrelated session cannot either.
 */
export function checkAdoptAuthority(input: {
  /** The effective calling session id, or undefined for the operator. */
  callerSessionId: string | undefined
  /** The session the children are taken from. */
  from: SessionDescriptor
  /** The declared successor of `from` (if any). */
  successorId?: string
}): { ok: true } | { ok: false; message: string } {
  const { callerSessionId, from, successorId } = input
  if (callerSessionId === undefined) return { ok: true }
  if (successorId && callerSessionId === successorId) return { ok: true }
  return {
    ok: false,
    message:
      `only the human operator or the DECLARED successor of "${from.id}" ` +
      `(${successorId ? `"${successorId}"` : "none declared"}) may adopt its children - ` +
      `this call came from session "${callerSessionId}".`,
  }
}
