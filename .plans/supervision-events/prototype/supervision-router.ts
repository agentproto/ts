/**
 * Prototype of the central primitive proposed in ../DESIGN.md: given one
 * normalized bus event, decide WHO must hear about it (routing with
 * inheritance, single controller, workspace default, escalation) and HOW
 * (dedup, one-unread-per-subject coalescing, priority, quiet hours).
 *
 * Pure and dependency-free on purpose: no daemon wiring, no I/O. It exists to
 * pin the semantics the design relies on with executable tests
 * (`node --test .plans/supervision-events/prototype/supervision-router.test.ts`), not to be imported by
 * the runtime as-is. Node >= 22.18 runs it directly (type stripping), so it only
 * uses erasable TypeScript syntax.
 */

// ── Data model ──────────────────────────────────────────────────────────

export type Priority = "critical" | "attention" | "info"

const PRIORITY_RANK: Record<Priority, number> = { info: 0, attention: 1, critical: 2 }

/** CloudEvents-shaped, as appended to the per-workspace journal. */
export interface BusEvent {
  id: string // stable: a redelivery of the same fact carries the same id
  seq: number // journal offset, assigned on append
  type: string // e.g. "agentproto.session.turn_ended", "github.pull_request.ready"
  subject: string // e.g. "session:sess_x", "github:org/repo#12"
  workspace: string
  /** Session the event is ABOUT (for lifecycle events, and for external
   *  events whose subject is linked to a session, e.g. the PR's author). */
  sessionId?: string
  priority: Priority
  /** Coalescing key — "one unread notification per subject". Defaults to `subject`. */
  coalesceKey?: string
  terminal?: boolean
  summary: string
}

export interface SessionNode {
  id: string
  parentId?: string
  workspace: string
  alive: boolean
}

/** Who a delivery goes to: a session's durable inbox, or the workspace's
 *  human fallback channel (webhook / chat relay). */
export type Party = { kind: "session"; id: string } | { kind: "human"; channel: string }

/** Explicit supervision edge, distinct from parent/child lineage. At most one
 *  `controller` per session (the lease; `epoch` is the fencing token);
 *  any number of `observer`s. `scope: "subtree"` = inherited by descendants. */
export interface SupervisionEdge {
  sessionId: string
  role: "controller" | "observer"
  holder: Party
  scope: "self" | "subtree"
  epoch: number
}

/** Declarative subscription. Empty/absent filter fields match everything. */
export interface Subscription {
  id: string
  subscriber: Party
  workspace: string
  types?: string[] // exact or prefix ("github.pull_request.*")
  subjects?: string[] // exact or prefix ("github:org/repo#*")
  /** Session-scoped subscription; with `subtree`, also every descendant. */
  session?: { id: string; scope: "self" | "subtree" }
  minPriority?: Priority
}

export interface WorkspaceSupervision {
  workspace: string
  /** Supervisor inherited by every ROOT session of the workspace. */
  defaultController?: Party
  /** Last resort when no live session would receive a non-info event. */
  fallback?: Party
  /** Local hours [start, end) during which `info`/`attention` to a HUMAN is
   *  deferred to a digest. `critical` always goes through. */
  quietHours?: { start: number; end: number }
}

export interface RoutingContext {
  sessions: Map<string, SessionNode>
  edges: SupervisionEdge[]
  subscriptions: Subscription[]
  workspaces: Map<string, WorkspaceSupervision>
}

// ── Routing ─────────────────────────────────────────────────────────────

function matchPattern(pattern: string, value: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : pattern === value
}

/** The session itself, then its ancestors nearest-first. */
export function lineage(ctx: RoutingContext, sessionId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let cur: string | undefined = sessionId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = ctx.sessions.get(cur)?.parentId
  }
  return out
}

function partyKey(p: Party): string {
  return p.kind === "session" ? `session:${p.id}` : `human:${p.channel}`
}

function isLive(ctx: RoutingContext, p: Party): boolean {
  return p.kind === "human" || ctx.sessions.get(p.id)?.alive === true
}

/**
 * The effective controller of a session: its own controller edge, else the
 * nearest ancestor's `subtree` controller, else — for a lineage that tops out
 * at a root — the workspace default. A DEAD holder is skipped and the search
 * continues upward (Erlang-style escalation to the next supervisor), so a
 * crashed supervisor never silently swallows its subtree's events.
 */
export function effectiveController(
  ctx: RoutingContext,
  sessionId: string,
): { holder: Party; via: "own" | "inherited" | "workspace-default" } | undefined {
  const chain = lineage(ctx, sessionId)
  for (const [i, id] of chain.entries()) {
    const edge = ctx.edges.find(
      e => e.sessionId === id && e.role === "controller" && (i === 0 || e.scope === "subtree"),
    )
    if (edge && isLive(ctx, edge.holder)) return { holder: edge.holder, via: i === 0 ? "own" : "inherited" }
  }
  const ws = ctx.sessions.get(sessionId)?.workspace
  const def = ws ? ctx.workspaces.get(ws)?.defaultController : undefined
  if (def && isLive(ctx, def)) return { holder: def, via: "workspace-default" }
  return undefined
}

function subscriptionMatches(ctx: RoutingContext, sub: Subscription, ev: BusEvent): boolean {
  if (sub.workspace !== ev.workspace) return false
  if (sub.types?.length && !sub.types.some(t => matchPattern(t, ev.type))) return false
  if (sub.subjects?.length && !sub.subjects.some(s => matchPattern(s, ev.subject))) return false
  if (sub.minPriority && PRIORITY_RANK[ev.priority] < PRIORITY_RANK[sub.minPriority]) return false
  if (sub.session) {
    if (!ev.sessionId) return false
    if (sub.session.scope === "self") return ev.sessionId === sub.session.id
    return lineage(ctx, ev.sessionId).includes(sub.session.id)
  }
  return true
}

export interface Route {
  recipients: Party[]
  /** True when no live session recipient existed and the event went to the
   *  workspace fallback instead (invariant I2's escape hatch). */
  escalated: boolean
  /** True when nobody at all can receive it — a broken invariant the
   *  reconciliation sweep must surface (`supervision_health`). */
  undeliverable: boolean
}

/**
 * Recipients of one event = matching subscriptions ∪ observers (own or
 * inherited) ∪ the effective controller. Dead session recipients are dropped;
 * if that leaves no live SESSION for a non-info event, the workspace fallback
 * is added (escalation). Deduped by party.
 */
export function route(ctx: RoutingContext, ev: BusEvent): Route {
  const out = new Map<string, Party>()
  const add = (p: Party) => out.set(partyKey(p), p)

  for (const sub of ctx.subscriptions) if (subscriptionMatches(ctx, sub, ev)) add(sub.subscriber)

  if (ev.sessionId) {
    const chain = lineage(ctx, ev.sessionId)
    for (const [i, id] of chain.entries()) {
      for (const e of ctx.edges) {
        if (e.sessionId === id && e.role === "observer" && (i === 0 || e.scope === "subtree")) add(e.holder)
      }
    }
    const ctl = effectiveController(ctx, ev.sessionId)
    if (ctl) add(ctl.holder)
  }

  const live = [...out.values()].filter(p => isLive(ctx, p))
  // Never notify a session about its own event.
  const recipients = live.filter(p => !(p.kind === "session" && p.id === ev.sessionId))
  const hasLiveSession = recipients.some(p => p.kind === "session")

  let escalated = false
  if (!hasLiveSession && ev.priority !== "info") {
    const fb = ctx.workspaces.get(ev.workspace)?.fallback
    if (fb && isLive(ctx, fb) && !recipients.some(p => partyKey(p) === partyKey(fb))) {
      recipients.push(fb)
      escalated = true
    }
  }
  return { recipients, escalated, undeliverable: recipients.length === 0 && ev.priority !== "info" }
}

// ── Delivery: durable inbox with dedup + coalescing ─────────────────────

export interface InboxEntry {
  key: string // subscriber + coalesceKey
  coalesceKey: string
  lastEventId: string
  lastSeq: number
  eventIds: string[]
  count: number
  priority: Priority // max priority seen since last ack
  summary: string // latest summary wins: the CURRENT state of the subject
  terminal: boolean
  deferred: boolean // parked for the digest (quiet hours / info)
  acked: boolean
}

export type DeliveryAction = "wake" | "steer" | "digest" | "duplicate" | "coalesced"

/**
 * Per-subscriber inbox. Invariants it enforces:
 *  - idempotent: the same event id twice is a no-op ("duplicate") — this is
 *    what makes at-least-once upstream (redelivery after restart) safe;
 *  - one unread entry per coalesce key: a second event on a subject whose
 *    entry is still unacked updates it in place ("coalesced") instead of
 *    producing a second wake-up — UNLESS it raises the priority or is
 *    terminal, which must still wake;
 *  - `info` never wakes anyone; it is digest-only;
 *  - quiet hours defer non-critical deliveries to a HUMAN party.
 */
export class Inbox {
  readonly entries = new Map<string, InboxEntry>()
  private readonly seen = new Set<string>()
  private readonly party: Party
  private readonly quietHours: { start: number; end: number } | undefined

  constructor(party: Party, opts: { quietHours?: { start: number; end: number } } = {}) {
    this.party = party
    this.quietHours = opts.quietHours
  }

  private inQuietHours(hour: number): boolean {
    const q = this.quietHours
    if (!q || this.party.kind !== "human") return false
    return q.start <= q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end
  }

  deliver(ev: BusEvent, opts: { hour?: number; recipientBusy?: boolean } = {}): DeliveryAction {
    if (this.seen.has(ev.id)) return "duplicate"
    this.seen.add(ev.id)

    const coalesceKey = ev.coalesceKey ?? ev.subject
    const key = `${partyKey(this.party)}|${coalesceKey}`
    const deferred =
      ev.priority === "info" || (ev.priority !== "critical" && this.inQuietHours(opts.hour ?? 12))
    const prev = this.entries.get(key)

    if (prev && !prev.acked) {
      const raised = PRIORITY_RANK[ev.priority] > PRIORITY_RANK[prev.priority]
      prev.lastEventId = ev.id
      prev.lastSeq = ev.seq
      prev.eventIds.push(ev.id)
      prev.count++
      prev.summary = ev.summary
      prev.terminal = prev.terminal || ev.terminal === true
      if (raised) prev.priority = ev.priority
      if ((raised || ev.terminal) && !deferred) {
        prev.deferred = false
        return opts.recipientBusy && ev.priority === "critical" ? "steer" : "wake"
      }
      return "coalesced"
    }

    this.entries.set(key, {
      key,
      coalesceKey,
      lastEventId: ev.id,
      lastSeq: ev.seq,
      eventIds: [ev.id],
      count: 1,
      priority: ev.priority,
      summary: ev.summary,
      terminal: ev.terminal === true,
      deferred,
      acked: false,
    })
    if (deferred) return "digest"
    return opts.recipientBusy && ev.priority === "critical" ? "steer" : "wake"
  }

  /** Ack up to a journal offset (consumer cursor). Unacked entries are what
   *  a restarted / compacted supervisor is re-briefed with. */
  ackThrough(seq: number): void {
    for (const e of this.entries.values()) if (e.lastSeq <= seq) e.acked = true
  }

  unread(): InboxEntry[] {
    return [...this.entries.values()].filter(e => !e.acked).sort((a, b) => a.lastSeq - b.lastSeq)
  }
}

// ── Watch-after-terminal (DeathWatch semantics) ─────────────────────────

/**
 * A watch registered on a subject that is ALREADY terminal must deliver the
 * terminal event immediately and close itself — never sit "active" waiting
 * for a transition that already happened (the failure mode measured in
 * DESIGN.md §2: 9 PR watches stuck active on merged/closed PRs, their merge
 * never notified). Akka's DeathWatch gives exactly this guarantee.
 */
export function baselineEvents(
  subject: string,
  snapshot: { state: "open" | "merged" | "closed"; fetchedAt: string },
): { events: Array<Pick<BusEvent, "type" | "subject" | "terminal" | "summary">>; closeWatch: boolean } {
  if (snapshot.state === "open") return { events: [], closeWatch: false }
  return {
    events: [
      {
        type: "github.pull_request.closed",
        subject,
        terminal: true,
        summary: `${subject} ${snapshot.state} (already ${snapshot.state} when the watch started)`,
      },
    ],
    closeWatch: true,
  }
}
