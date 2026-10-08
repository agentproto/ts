/**
 * SentinelRuntime — the poll loop + delivery engine over poll-capable
 * sentinel providers (AIP-60 §2/§3/§6).
 *
 * Per tick: for every pollable sentinel (`active` or `orphaned` — the
 * provider-side watch is never cancelled just because a session died, the
 * PR is still real), resolve its provider, `poll()` new events, dedupe via
 * the store's persisted `seen` window, filter against `spec.match` (OR
 * semantics across clauses — design contract change: a spec now watches ANY
 * of several `{subject, types?}` clauses, not just one), and land each match
 * into the target session's AIP-46 inbox via
 * `sessions.sendMessage` IN-PROCESS (`relation: "system"`, `kind: "notice"`),
 * ack'ing the provider only once the whole batch has been handled (at-least-
 * once — a redelivered event is a no-op via `seen`).
 *
 * Dead session: `sendMessage` throws `SessionNotAliveError` -> resume via the
 * SAME `isSessionAlive`/`restartSession` hooks `inbound-router.ts` uses, and
 * retry once; otherwise the event is appended to
 * `~/.agentproto/sentinels-parked.jsonl` and the sentinel is marked
 * `orphaned`.
 *
 * Push providers (`webhook`) have no `poll()`: the daemon's inbound route
 * hands their parsed events to `deliverPushed`, which runs the SAME
 * per-event pipeline (seen -> match -> deliver -> markSeen -> lifetime) so
 * dedup, `until` and dead-session handling behave identically to polling.
 *
 * Cadence: 15s while any pollable sentinel had an event in the last 10 min,
 * 60s otherwise (design §3) — a self-rescheduling `setTimeout` rather than
 * `setInterval` so the interval can adapt tick to tick.
 */

import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"
import { mkdirSync, appendFileSync } from "node:fs"

import {
  createSessionMessage,
  MAX_MESSAGE_DATA_BYTES,
  type MessageUrgency,
  type SessionMessage,
} from "./session-message.js"
import { createHash } from "node:crypto"

import { SessionNotAliveError, type SendMessageResult } from "./sessions.js"
import { DELIBERATE_END_REASONS } from "./session-end-reason.js"
import { isRetired, type RetirementFields } from "./session-retirement.js"
import type {
  Sentinel,
  SentinelStatus,
  SentinelStore,
  SentinelWebhookSecret,
  SentinelWebhookTargetAtRest,
} from "./sentinel-store.js"
// A VALUE import (not `import type`): the runtime scopes the rotation window.
import { WEBHOOK_SECRET_ROTATION_WINDOW_MS } from "./sentinel-store.js"
import {
  createCancelTombstoneStore,
  defaultCancelTombstonePath,
  type CancelTombstoneStore,
} from "./sentinel-cancel-tombstones.js"
import {
  createSentinelQuarantine,
  defaultSentinelQuarantinePath,
  type SentinelQuarantine,
} from "./sentinel-quarantine.js"
import {
  createSentinelWebhookOutbox,
  type SentinelWebhookOutboxOptions,
  type SentinelWebhookOutbox,
  type SentinelWebhookOutboxRow,
} from "./sentinel-webhook-outbox.js"
import type { DeliveryReplay } from "./webhook-egress/delivery.js"
import {
  deliveryPreferenceFor,
  type SentinelEvent,
  type SentinelMatchClause,
  type SentinelPollResult,
  type SentinelProviderHandle,
} from "./sentinel-providers/types.js"

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_ACTIVE_INTERVAL_MS = 15_000
const DEFAULT_IDLE_INTERVAL_MS = 60_000
const DEFAULT_HOT_WINDOW_MS = 10 * 60 * 1000
const POLL_BATCH_LIMIT = 50

// Defined in session-end-reason.ts (cycle-free) so sessions.ts can share it.
export { DELIBERATE_END_REASONS }

const CLOSED_SUBJECTS_CAP = 500

/** Statuses whose provider-side watch stays live — the sentinel keeps
 *  polling even while `orphaned` (design §2: "the provider-side watch is
 *  never cancelled just because a session died"). */
const POLLABLE_STATUSES: ReadonlySet<SentinelStatus> = new Set(["active", "orphaned"])

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Matching (design §4 — type/subject grammar; contract change — `match`
// clauses, OR semantics) ──────────────────────────────────────────────

function effectiveTypes(clause: SentinelMatchClause, provider: SentinelProviderHandle): string[] {
  return clause.types && clause.types.length > 0 ? clause.types : provider.defaultTypes(clause.subject)
}

/** `*` is the only wildcard — matches any run of characters, same
 *  expressiveness the design's `types`/subject globs need. */
function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes("*")) return false
  const escaped = pattern
    .split("*")
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/** A clause subject ending in `*` prefix-matches any of the event's
 *  `subjects`; otherwise it must appear exactly. */
function matchesSubject(clauseSubject: string, eventSubjects: readonly string[]): boolean {
  if (clauseSubject.endsWith("*")) {
    const prefix = clauseSubject.slice(0, -1)
    return eventSubjects.some(s => s.startsWith(prefix))
  }
  return eventSubjects.includes(clauseSubject)
}

function clauseMatches(
  clause: SentinelMatchClause,
  event: SentinelEvent,
  provider: SentinelProviderHandle,
): boolean {
  const types = effectiveTypes(clause, provider)
  return types.some(t => matchesGlob(t, event.type)) && matchesSubject(clause.subject, event.subjects)
}

/** OR across `spec.match`: the event matches the sentinel if ANY clause
 *  matches. */
function eventMatchesSpec(
  sentinel: Sentinel,
  event: SentinelEvent,
  provider: SentinelProviderHandle,
): boolean {
  return sentinel.spec.match.some(clause => clauseMatches(clause, event, provider))
}

/** Envelope trimmed to fit the AIP-46 `data` cap — drop the provider's raw
 *  projection first (the biggest variable part), then fall back to a bare
 *  identity stub. */
function trimEventForEnvelope(event: SentinelEvent): Record<string, unknown> {
  const byteSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8")
  const full: Record<string, unknown> = { ...event }
  if (byteSize(full) <= MAX_MESSAGE_DATA_BYTES) return full
  const trimmed = { ...full, data: { truncated: true } }
  if (byteSize(trimmed) <= MAX_MESSAGE_DATA_BYTES) return trimmed
  return { id: event.id, type: event.type, subject: event.subject, summary: event.summary, truncated: true }
}

// ── Public surface ────────────────────────────────────────────────────

/** The slice of `SessionsRegistry` the runtime needs — structural so this
 *  module stays unit-testable without a full registry (same shape as
 *  `supervisor-notify.ts`'s `SupervisorNotifyRegistry`). */
export interface SentinelRuntimeRegistry {
  sendMessage(
    msg: SessionMessage,
    opts?: { source?: string; origin?: string; allowInterrupt?: boolean },
  ): Promise<SendMessageResult>
}

/** What the sentinel needs to know about a target session to decide whether
 *  it may be revived: the retirement fields (see `isRetired`), its parent,
 *  and the end of its `continuedTo` chain when one exists. */
export interface SentinelSessionInfo extends Omit<RetirementFields, "endedReason"> {
  endedReason?: string
  parentSessionId?: string
  /** End of the target's `continuedTo` chain (a row that still exists). */
  successorId?: string
}

export interface SentinelRuntimeOptions {
  store: SentinelStore
  registry: SentinelRuntimeRegistry
  /** Resolve a sentinel's provider slug to a live handle — the daemon wires
   *  this to `resolveSentinelProvider` + the sentinel creds store; tests
   *  wire it directly to a `createFakeSentinelProvider()` instance. */
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** Same hook `inbound-router.ts` uses (`index.ts`'s `isSessionAlive`). */
  isSessionAlive: (sessionId: string) => boolean
  /** Same hook `inbound-router.ts` uses (`index.ts`'s `restartInboundSession`). */
  restartSession: (sessionId: string) => Promise<string>
  /** Looks up a session's end reason + parent. When the target ended with a
   *  deliberate outcome (`operator-completed`, `steward-*`, `operator-stopped`)
   *  the sentinel never resumes it — the notice goes to the parent (if alive)
   *  or is parked. Omitted → every dead target is resumed (legacy). */
  sessionInfo?: (sessionId: string) => SentinelSessionInfo | undefined
  /** Poll cadence while "hot" (an event landed within `hotWindowMs`).
   *  Default 15s. */
  activeIntervalMs?: number
  /** Poll cadence otherwise. Default 60s. */
  idleIntervalMs?: number
  /** Window that counts as "hot". Default 10 minutes. */
  hotWindowMs?: number
  /** Override for the parked-event journal (tests). Default
   *  `~/.agentproto/sentinels-parked.jsonl`. */
  parkedPath?: string
  nowMs?: () => number
  log?: (line: string) => void
  /** Override persist path for the webhook outbox (tests). Default
   *  `~/.agentproto/sentinel-webhook-outbox.json`. Present ⇒ persisted. */
  outboxPath?: string
  /** DI boundary (not module fakes): replaces W-A's `deliverEventEnvelope`
   *  as the outbox's POST boundary. When given (and `outboxPath` is not),
   *  outbox disk persistence defaults OFF — tests must not sweep the
   *  operator's real outbox file. */
  deliverEvent?: SentinelWebhookOutboxOptions["deliverEvent"]
  /** Force the outbox's disk persistence on/off explicitly. */
  outboxPersist?: boolean
  /** Rotation window for the dual-sign delivery. Default 10 min. */
  secretRotationWindowMs?: number
  /** Poison-item quarantine JSONL (tests). Default
   *  `~/.agentproto/sentinel-quarantine.jsonl`; in-memory when the outbox is
   *  non-persistent (`deliverEvent` without `outboxPath`, or
   *  `outboxPersist: false`) so tests never touch the operator's file. */
  quarantinePath?: string
  /** Cancel-tombstone file (tests). Same default/persistence rule as
   *  `quarantinePath`: `~/.agentproto/sentinel-cancel-tombstones.json`. */
  cancelTombstonePath?: string
}

export interface SentinelRuntime {
  /** Re-attaches every pollable sentinel to its provider, then starts the
   *  poll timer. Startup ALSO runs the `until.at` expiry sweep and resumes
   *  every persisted webhook outbox row (by exact stored bytes). */
  start(): Promise<void>
  stop(): void
  /** Force one poll tick across every poll-capable, pollable sentinel —
   *  used by tests and (later) `sentinel_poll_now`. */
  pollOnce(): Promise<void>
  /** Deliver events a push provider already parsed + verified (the
   *  `/inbound/sentinel-<hookKey>` route) to one sentinel, through the same
   *  dedup/match/lifetime pipeline the poll loop uses. `failed: true` means a
   *  delivery threw and was NOT marked seen — the caller should answer 5xx so
   *  the sender can redeliver. Unknown or non-live sentinels are a no-op. */
  deliverPushed(sentinelId: string, events: readonly SentinelEvent[]): Promise<{ delivered: number; failed: boolean }>
  /** The persisted outbox behind every `target.kind === "webhook"` sentinel —
   *  rows in, terminal-state acks out (see `sentinel-webhook-outbox.ts`). */
  readonly webhookOutbox: SentinelWebhookOutbox
  /** Poison polled items (could not be parsed into events) recorded before
   *  their cursor was acknowledged. Identifiers + error only — no payload. */
  readonly quarantine: SentinelQuarantine
  /** Persisted remote-deletion intents (keyed by provider + remote id) behind
   *  every unwatch/unsubscribe/expiry; swept each tick and at start. */
  readonly cancelTombstones: CancelTombstoneStore
}

export function createSentinelRuntime(opts: SentinelRuntimeOptions): SentinelRuntime {
  const { store } = opts
  const nowMs = opts.nowMs ?? Date.now
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const activeIntervalMs = opts.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS
  const idleIntervalMs = opts.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS
  const hotWindowMs = opts.hotWindowMs ?? DEFAULT_HOT_WINDOW_MS
  const parkedPath = opts.parkedPath ?? resolve(agentprotoHome(), "sentinels-parked.jsonl")

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false

  // ── Parking (dead, unresumable session) ─────────────────────────────

  function parkEvent(sentinel: Sentinel, event: SentinelEvent, reason: string): void {
    try {
      mkdirSync(dirname(parkedPath), { recursive: true })
      const line = JSON.stringify({
        sentinelId: sentinel.id,
        event,
        reason,
        ts: new Date(nowMs()).toISOString(),
      })
      appendFileSync(parkedPath, line + "\n", { mode: 0o600 })
    } catch (err) {
      log(`[sentinel-runtime] failed to park event for ${sentinel.id}: ${describeError(err)}`)
    }
  }

  function markOrphaned(sentinel: Sentinel): void {
    const current = store.get(sentinel.id)
    if (current && current.status !== "orphaned") store.update(sentinel.id, { status: "orphaned" })
  }

  // ── Expiry (plan §4 W-B task 2 — consulted BEFORE every phase that can
  // deliver; until-at was previously applied only AFTER an event crossed
  // the whole pipeline, so an expired sub could deliver its first post-
  // expiry event and an idle expired sub never expired) ───────────────

  /** Pure `until` consultation — never mutates. Sweep callers flip status. */
  function isExpiredSpec(sentinel: Sentinel): boolean {
    return sentinel.spec.until.kind === "at" && nowMs() >= sentinel.spec.until.ms
  }

  /** The gate a delivery-capable phase consults: gone or expired — no. */
  function isDeliverableLive(sentinelId: string): boolean {
    const current = store.get(sentinelId)
    return current !== undefined && current.status !== "expired" && !isExpiredSpec(current)
  }

  /** Startup + per-tick sweep: flip every expired-but-still-active sentinel
   *  to `status: "expired"` ("ended:expired") and cancel its provider-side
   *  watch. */
  async function sweepExpiredSentinels(): Promise<number> {
    let swept = 0
    for (const sentinel of store.list()) {
      if (sentinel.status === "active" && isExpiredSpec(sentinel)) {
        await expireSentinel(sentinel)
        swept++
      }
    }
    if (swept > 0) log(`[sentinel-runtime] expiry sweep: ${swept} sentinel(s) flipped to expired`)
    return swept
  }

  async function expireSentinel(sentinel: Sentinel): Promise<void> {
    if (store.get(sentinel.id)?.status !== "expired") {
      store.update(sentinel.id, { status: "expired" })
    }
    try {
      // Persisted intent + retry: a failed remote delete converges in the sweep.
      await cancelTombstones.cancel(sentinel.handle)
    } catch (err) {
      log(`[sentinel-runtime] expiry cancel failed for ${sentinel.id}: ${describeError(err)}`)
    }
  }

  // ── Webhook fire path (plan §4 W-B task 3 — persisted outbox owns the
  // delivery; ack-after-terminal only) ────────────────────────────────

  const outboxPersistent =
    opts.outboxPersist ?? (opts.outboxPath !== undefined || opts.deliverEvent === undefined)
  const quarantinePath = opts.quarantinePath ?? (outboxPersistent ? defaultSentinelQuarantinePath() : undefined)
  const quarantine = createSentinelQuarantine({
    ...(quarantinePath !== undefined ? { filePath: quarantinePath } : {}),
    nowMs,
  })

  const cancelTombstonePath =
    opts.cancelTombstonePath ?? (outboxPersistent ? defaultCancelTombstonePath() : undefined)
  const cancelTombstones = createCancelTombstoneStore({
    ...(cancelTombstonePath !== undefined ? { filePath: cancelTombstonePath } : {}),
    resolveProvider: opts.resolveProvider,
    // A live local watch that owns the remote makes the tombstone stale.
    isRemoteInUse: (provider, remoteId) =>
      store.list().some(s => s.provider === provider && s.handle.remoteId === remoteId && s.status !== "expired"),
    nowMs,
    log,
  })

  const outbox = createSentinelWebhookOutbox({
    ...(opts.outboxPath !== undefined ? { filePath: opts.outboxPath } : {}),
    nowMs,
    ...(opts.outboxPersist !== undefined ? { persist: opts.outboxPersist } : {}),
    ...(opts.deliverEvent !== undefined ? { deliverEvent: opts.deliverEvent } : {}),
    log,
    /** Signing secrets for the stored `{url, secretRef}` target — dual-sign
     *  while the rotation window from `rotatedAt` is open. */
    secretsFor: (sentinelId: string): DeliveryReplay | null => {
      const sentinel = store.get(sentinelId)
      const target = sentinel?.spec.target
      if (!sentinel || target?.kind !== "webhook") return null
      const stored: SentinelWebhookSecret | undefined = store.getSentinelSecret(
        (target as unknown as SentinelWebhookTargetAtRest).secretRef,
      )
      if (!stored) return null
      const windowMs = opts.secretRotationWindowMs ?? WEBHOOK_SECRET_ROTATION_WINDOW_MS
      const secretsOut = [stored.secret]
      if (stored.prevSecret && stored.rotatedAt !== undefined && nowMs() - stored.rotatedAt < windowMs) {
        secretsOut.push(stored.prevSecret)
      }
      // Deterministic subscription identity for the replay path (W-C owns
      // the canonical-JSON `subscriptionId()`; the wire `webhook-id` header
      // carries the EVENT id — this subId never enters a signature).
      const subId = `sub_${createHash("sha256").update(`${sentinelId}:${target.url}`).digest("hex").slice(0, 32)}`
      return { subId, callbackUrl: target.url, secrets: secretsOut }
    },
    /** Expiry gate consulted BEFORE every dispatch (plan §4 W-B task 2b). */
    isExpired: (sentinelId: string): boolean => !isDeliverableLive(sentinelId),
    /** Ack-at-least-once, only after the row reached terminal status. */
    onTerminal: (sentinelId: string, row: SentinelWebhookOutboxRow): void => {
      void ackAfterTerminalRow(sentinelId, row)
    },
  })

  async function ackAfterTerminalRow(sentinelId: string, row: SentinelWebhookOutboxRow): Promise<void> {
    const sentinel = store.get(sentinelId)
    if (!sentinel) return // removed mid-flight — nothing to ack
    if (store.isSeen(sentinelId, row.eventId)) return

    store.markSeen(sentinelId, row.eventId)
    const updated = store.get(sentinelId)
    if (!updated) return
    store.update(sentinelId, { eventCount: updated.eventCount + 1, lastEventTs: nowMs() })
    const withEvent = row as unknown as { event?: SentinelEvent }
    const event = withEvent.event
    if (!event) return
    const provider = await opts.resolveProvider(sentinel.provider)
    if (!provider) return
    const current = store.get(sentinelId)
    if (current) {
      if (current.spec.until.kind === "subject_terminal") {
        checkSubjectTerminalExpiry(current, event)
        const latest = store.get(sentinelId)
        if (latest) await applyLifetime(latest, event, provider)
      } else {
        await applyLifetime(current, event, provider)
      }
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────

  function buildMessage(
    sentinel: Sentinel,
    event: SentinelEvent,
    sessionId: string,
    urgency: MessageUrgency,
  ): SessionMessage {
    // The EVENT's own subject, not the matching clause's (which may be a
    // `*` prefix template) — contract change: `correlationId` names the
    // concrete thing that happened, so `inbox_wait {correlationId}` means
    // "anything on this exact PR/issue/etc", regardless of which clause's
    // wildcard let it through.
    const scheme = event.subject.split(":")[0] || sentinel.provider
    return createSessionMessage({
      to: sessionId,
      from: { relation: "system" },
      kind: "notice",
      urgency,
      correlationId: `sentinel:${event.subject}`,
      text: `[${scheme}] ${event.summary}`,
      data: trimEventForEnvelope(event),
    })
  }

  /** The target was closed on purpose: never resume it. Hand the notice to
   *  its live parent (as `fyi`, so it lands in the inbox without forcing a
   *  turn); with no live parent, park it in the journal. */
  async function routeAroundClosedSession(
    sentinel: Sentinel,
    event: SentinelEvent,
    msg: SessionMessage,
    sessionId: string,
    info: SentinelSessionInfo,
  ): Promise<void> {
    const parentId = info.parentSessionId
    if (parentId && opts.isSessionAlive(parentId)) {
      try {
        await opts.registry.sendMessage(
          { ...msg, to: parentId, urgency: "fyi", text: `[for closed session ${sessionId}] ${msg.text}` },
          { source: "sentinel", origin: sentinel.id },
        )
        return
      } catch (err) {
        if (!(err instanceof SessionNotAliveError)) throw err
      }
    }
    parkEvent(
      sentinel,
      event,
      `session ${sessionId} retired (${info.endedReason ?? (info.archived ? "archived" : "superseded")}); not resuming, no live parent`,
    )
    markOrphaned(sentinel)
  }

  /** The target was superseded: deliver to the end of its `continuedTo`
   *  chain and re-target the sentinel there. A dead successor is revived only
   *  if it is not itself retired. */
  async function deliverToSuccessor(
    sentinel: Sentinel,
    event: SentinelEvent,
    msg: SessionMessage,
    sessionId: string,
    successorId: string,
  ): Promise<void> {
    const target = sentinel.spec.target
    if (target.kind !== "session") return
    try {
      let to = successorId
      if (!opts.isSessionAlive(successorId)) {
        const succInfo = opts.sessionInfo?.(successorId)
        if (!succInfo || isRetired(succInfo)) {
          parkEvent(sentinel, event, `session ${sessionId} superseded by ${successorId}, which is not alive`)
          markOrphaned(sentinel)
          return
        }
        to = await opts.restartSession(successorId)
      }
      await opts.registry.sendMessage({ ...msg, to }, { source: "sentinel", origin: sentinel.id })
      store.update(sentinel.id, {
        spec: { ...sentinel.spec, target: { ...target, sessionId: to } },
      })
      const current = store.get(sentinel.id)
      if (current && current.status === "orphaned") store.update(sentinel.id, { status: "active" })
    } catch (err) {
      parkEvent(sentinel, event, describeError(err))
      markOrphaned(sentinel)
    }
  }

  async function handleDeadSession(
    sentinel: Sentinel,
    event: SentinelEvent,
    msg: SessionMessage,
  ): Promise<void> {
    const target = sentinel.spec.target
    if (target.kind !== "session") return
    const sessionId = target.sessionId

    const info = opts.sessionInfo?.(sessionId)
    if (info && isRetired(info)) {
      // Retired (closed on purpose / archived / superseded): never revived,
      // in place or under a new id. Its notices go to the successor when
      // there is one, else to the parent / the parking journal.
      if (info.successorId) {
        await deliverToSuccessor(sentinel, event, msg, sessionId, info.successorId)
        return
      }
      await routeAroundClosedSession(sentinel, event, msg, sessionId, info)
      return
    }

    // The retirement check above runs first on purpose: sendMessage already
    // decided by STATUS that the target is dead, and `isSessionAlive` is a
    // pid probe that reads "alive" for a pid-less row — consulting it first
    // would park a superseded target instead of forwarding to its successor.
    if (opts.isSessionAlive(sessionId)) {
      // sendMessage reported not-alive on a session our own liveness check
      // still sees as alive (a race) — park rather than spin retrying.
      parkEvent(sentinel, event, "session reported alive but sendMessage rejected it")
      markOrphaned(sentinel)
      return
    }

    try {
      const resumedId = await opts.restartSession(sessionId)
      const resumedMsg: SessionMessage = resumedId === sessionId ? msg : { ...msg, to: resumedId }
      await opts.registry.sendMessage(resumedMsg, { source: "sentinel", origin: sentinel.id })
      if (resumedId !== sessionId) {
        store.update(sentinel.id, {
          spec: { ...sentinel.spec, target: { ...target, sessionId: resumedId } },
        })
      }
      const current = store.get(sentinel.id)
      if (current && current.status === "orphaned") store.update(sentinel.id, { status: "active" })
    } catch (err) {
      parkEvent(sentinel, event, describeError(err))
      markOrphaned(sentinel)
    }
  }

  async function deliverEvent(sentinel: Sentinel, event: SentinelEvent): Promise<void> {
    const target = sentinel.spec.target
    // Defensive only: `SentinelStore.create` already rejects any target
    // kind other than "session" (`SentinelTargetNotImplementedError`), so a
    // persisted sentinel never actually reaches this branch — narrows the
    // type for `target.sessionId`/`target.urgency` below.
    if (target.kind !== "session") return
    const msg = buildMessage(sentinel, event, target.sessionId, target.urgency)
    try {
      await opts.registry.sendMessage(msg, { source: "sentinel", origin: sentinel.id })
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        await handleDeadSession(sentinel, event, msg)
        return
      }
      // The target row is gone altogether (deleted/GC'd, not merely ended):
      // nothing to resume and nobody to route to. Rethrowing here leaves the
      // event unseen, so the sentinel re-delivers it every poll forever and
      // never reaches its terminal event — park it and orphan the sentinel.
      if (opts.sessionInfo && !opts.isSessionAlive(target.sessionId) && !opts.sessionInfo(target.sessionId)) {
        parkEvent(sentinel, event, `target session ${target.sessionId} no longer exists`)
        markOrphaned(sentinel)
        return
      }
      throw err
    }
  }

  // ── Lifetime (design §2 — `until`; contract change — `subject_terminal`
  // with multiple `match` clauses expires only once EVERY clause's subject
  // has seen a terminal event) ─────────────────────────────────────────

  /** Records which of `sentinel.spec.match`'s clause subjects this terminal
   *  event satisfies, then reports whether ALL of them now have. A
   *  single-clause spec expires on that one clause's first terminal event —
   *  same behaviour as before `match` supported fan-out. */
  function checkSubjectTerminalExpiry(sentinel: Sentinel, event: SentinelEvent): boolean {
    if (event.terminal !== true) return false
    const satisfied = sentinel.spec.match
      .map(clause => clause.subject)
      .filter(subject => matchesSubject(subject, event.subjects))
    if (satisfied.length === 0) return false

    const merged = new Set([...sentinel.terminalSubjects, ...satisfied])
    store.update(sentinel.id, { terminalSubjects: [...merged] })

    const allSubjects = sentinel.spec.match.map(clause => clause.subject)
    return allSubjects.every(subject => merged.has(subject))
  }

  async function applyLifetime(
    sentinel: Sentinel,
    event: SentinelEvent,
    provider: SentinelProviderHandle,
  ): Promise<void> {
    const until = sentinel.spec.until
    let expire: boolean
    switch (until.kind) {
      case "subject_terminal":
        expire = checkSubjectTerminalExpiry(sentinel, event)
        break
      case "count":
        expire = sentinel.eventCount >= until.n
        break
      case "at":
        expire = nowMs() >= until.ms
        break
      case "never":
        expire = false
        break
    }
    if (!expire) return
    store.update(sentinel.id, { status: "expired" })
    try {
      await provider.cancel(sentinel.handle)
    } catch (err) {
      log(`[sentinel-runtime] cancel failed for ${sentinel.id}: ${describeError(err)}`)
    }
  }

  // ── Closed subjects (merged/closed PR) ──────────────────────────────

  /** Maintains `closedSubjects` from the event stream and reports whether
   *  `event.subject` is closed AFTER this event (a terminal event closes its
   *  own subject; a `.reopened` event reopens it). Only subjects the spec
   *  actually watches are tracked. */
  function trackClosure(sentinel: Sentinel, event: SentinelEvent): boolean {
    const closed = sentinel.closedSubjects ?? []
    const isClosed = closed.includes(event.subject)
    if (event.terminal === true) {
      if (isClosed || !sentinel.spec.match.some(c => matchesSubject(c.subject, event.subjects))) return isClosed
      const next = [...closed, event.subject].slice(-CLOSED_SUBJECTS_CAP)
      store.update(sentinel.id, { closedSubjects: next })
      return true
    }
    if (isClosed && event.type.endsWith(".reopened")) {
      store.update(sentinel.id, { closedSubjects: closed.filter(s => s !== event.subject) })
      return false
    }
    return isClosed
  }

  // ── Shared per-event pipeline (poll + push) ─────────────────────────

  async function processEvents(
    sentinelId: string,
    provider: SentinelProviderHandle,
    events: readonly SentinelEvent[],
  ): Promise<{ haltedOnError: boolean; delivered: number; stoppedEarly: boolean }> {
    let haltedOnError = false
    let stoppedEarly = false
    let delivered = 0

    for (const event of events) {
      const current = store.get(sentinelId)
      if (!current) {
        stoppedEarly = true // removed mid-batch
        break
      }
      if (!POLLABLE_STATUSES.has(current.status)) {
        stoppedEarly = true // paused/expired/error — stop watching
        break
      }

      // Ingress expiry gate (poll and push alike) — plan §4 W-B task 2a:
      // an event that arrives after `until.at` must not create a
      // delivery-capable row (or a parked notice); flip first, then stop.
      if (isExpiredSpec(current)) {
        await expireSentinel(current)
        stoppedEarly = true
        break
      }

      if (store.isSeen(current.id, event.id)) continue

      const closedNow = trackClosure(current, event)
      if (closedNow && !event.terminal) {
        // Post-merge/close noise (a check_suite failing after the merge):
        // journal it, never wake or resume anything for it.
        parkEvent(current, event, `subject ${event.subject} already closed`)
        store.markSeen(current.id, event.id)
        continue
      }

      if (!eventMatchesSpec(current, event, provider)) {
        // Filtered out, not a delivery attempt — still mark it seen so it's
        // never reconsidered on a later tick.
        store.markSeen(current.id, event.id)
        continue
      }

      if (current.spec.target.kind === "webhook") {
        // Webhook fire path: the persisted outbox owns the delivery; the
        // event is acked (markSeen / counters / lifetime) ONLY once its
        // outbox row reaches terminal status. Enqueue idempotently dedups.
        try {
          await outbox.enqueue({ sentinelId: current.id, event })
        } catch (err) {
          // Don't mark seen — row bookkeeping blew; leave the at-least-once
          // promise to the dedup/outbox key on the next tick.
          log(`[sentinel-runtime] webhook enqueue failed: ${describeError(err)}`)
          haltedOnError = true
          break
        }
        continue
      }

      try {
        await deliverEvent(current, event)
      } catch (err) {
        // Do NOT mark seen: delivery did not complete (delivered OR parked
        // both resolve normally — see deliverEvent/handleDeadSession), so
        // this is a genuinely unhandled failure. Marking seen here would
        // dedupe the event out of every future redelivery attempt on the
        // next tick, silently losing it and breaking at-least-once.
        log(`[sentinel-runtime] ${current.id} delivery failed: ${describeError(err)}`)
        haltedOnError = true
        break
      }
      store.markSeen(current.id, event.id)
      delivered++

      const updated = store.update(current.id, {
        eventCount: current.eventCount + 1,
        lastEventTs: nowMs(),
      })
      if (updated) await applyLifetime(updated, event, provider)
    }

    return { haltedOnError, delivered, stoppedEarly }
  }

  // ── Poll ──────────────────────────────────────────────────────────

  async function pollSentinel(sentinel: Sentinel): Promise<void> {
    const provider = await opts.resolveProvider(sentinel.provider)
    if (!provider || !provider.poll) return

    let result: SentinelPollResult
    try {
      result = await provider.poll(sentinel.handle, POLL_BATCH_LIMIT)
    } catch (err) {
      store.update(sentinel.id, { lastError: describeError(err) })
      return
    }

    // Every poison item in the batch is durably quarantined BEFORE the cursor
    // can be acknowledged: an ack lets the remote drop the row, so an
    // unrecorded one would be lost. If the quarantine write fails, the batch
    // is left un-acked and re-served next tick (a poison item must neither be
    // lost nor stall the later valid events — those still deliver below).
    let quarantineFailed = false
    for (const item of result.malformed ?? []) {
      try {
        quarantine.record({
          sentinelId: sentinel.id,
          provider: sentinel.provider,
          ...(sentinel.handle.remoteId !== undefined ? { remoteId: sentinel.handle.remoteId } : {}),
          item,
        })
      } catch (err) {
        quarantineFailed = true
        log(`[sentinel-runtime] quarantine write failed for ${sentinel.id}: ${describeError(err)}`)
      }
    }

    const { haltedOnError, stoppedEarly } = await processEvents(sentinel.id, provider, result.events)

    // Ack only a fully-handled batch: every item at or before `cursor` is
    // delivered (outbox/session) or quarantined. A halted/stopped batch, or a
    // failed quarantine write, keeps the cursor where it was.
    if (haltedOnError || stoppedEarly || quarantineFailed) {
      if (quarantineFailed) store.update(sentinel.id, { lastError: "quarantine write failed; batch not acknowledged" })
      return
    }

    const latest = store.get(sentinel.id)
    if (latest) {
      if (provider.ack) {
        try {
          await provider.ack(latest.handle, result.cursor)
        } catch (err) {
          log(`[sentinel-runtime] ack failed for ${sentinel.id}: ${describeError(err)}`)
        }
      }
      store.update(sentinel.id, { handle: { ...latest.handle, cursor: result.cursor } })
    }
  }

  async function pollOnce(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      // Periodic sweep (plan §4 W-B task 2c): flip expired sentinels and
      // reap delivered / age-out pending webhook outbox rows.
      await sweepExpiredSentinels()
      await cancelTombstones.sweep().catch(err => log(`[sentinel-runtime] tombstone sweep failed: ${describeError(err)}`))
      outbox.sweep()
      const pollable = store.list().filter(s => POLLABLE_STATUSES.has(s.status))
      for (const sentinel of pollable) {
        await pollSentinel(sentinel)
      }
    } finally {
      inFlight = false
    }
  }

  // ── Push ────────────────────────────────────────────────────────────

  /** Per-sentinel serial chain: two concurrent deliveries of the same event
   *  (a GitHub redelivery racing the original) must not both pass `isSeen`
   *  before either calls `markSeen`. */
  const pushChains = new Map<string, Promise<unknown>>()

  function deliverPushed(
    sentinelId: string,
    events: readonly SentinelEvent[],
  ): Promise<{ delivered: number; failed: boolean }> {
    const run = async (): Promise<{ delivered: number; failed: boolean }> => {
      const sentinel = store.get(sentinelId)
      if (!sentinel || !POLLABLE_STATUSES.has(sentinel.status)) return { delivered: 0, failed: false }
      // Ingress expiry gate for push-mode (plan §4 W-B task 2a).
      if (isExpiredSpec(sentinel)) {
        await expireSentinel(sentinel)
        return { delivered: 0, failed: false }
      }
      const provider = await opts.resolveProvider(sentinel.provider)
      if (!provider) return { delivered: 0, failed: false }
      const { haltedOnError, delivered } = await processEvents(sentinelId, provider, events)
      return { delivered, failed: haltedOnError }
    }
    const prev = pushChains.get(sentinelId) ?? Promise.resolve()
    const next = prev.then(run, run)
    const tail = next.catch(() => undefined)
    pushChains.set(sentinelId, tail)
    void tail.then(() => {
      if (pushChains.get(sentinelId) === tail) pushChains.delete(sentinelId)
    })
    return next
  }

  // ── Timer ─────────────────────────────────────────────────────────

  function currentIntervalMs(): number {
    const now = nowMs()
    const hot = store
      .list()
      .some(
        s =>
          POLLABLE_STATUSES.has(s.status) &&
          s.lastEventTs !== undefined &&
          now - s.lastEventTs < hotWindowMs,
      )
    return hot ? activeIntervalMs : idleIntervalMs
  }

  function scheduleNext(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void pollOnce()
        .catch(err => log(`[sentinel-runtime] unhandled poll error: ${describeError(err)}`))
        .finally(scheduleNext)
    }, currentIntervalMs())
  }

  // ── Re-attach (daemon restart) ───────────────────────────────────────

  async function reattachAll(): Promise<void> {
    const pollable = store.list().filter(s => POLLABLE_STATUSES.has(s.status))
    for (const sentinel of pollable) {
      const provider = await opts.resolveProvider(sentinel.provider)
      if (!provider) {
        store.update(sentinel.id, {
          status: "error",
          lastError: `unknown sentinel provider "${sentinel.provider}"`,
        })
        continue
      }
      const delivery = deliveryPreferenceFor(provider, activeIntervalMs)
      try {
        const handle = await provider.attach(sentinel.handle, delivery)
        store.update(sentinel.id, { handle })
      } catch (err) {
        store.update(sentinel.id, { status: "error", lastError: describeError(err) })
      }
    }
  }

  return {
    async start(): Promise<void> {
      await reattachAll()
      // Startup duties (plan §4 W-B tasks 2c + 3): flip anything already
      // past its `until.at`, then re-dispatch every persisted outbox row
      // by its exact stored bytes.
      await sweepExpiredSentinels()
      await cancelTombstones.sweep().catch(err => log(`[sentinel-runtime] tombstone sweep failed: ${describeError(err)}`))
      await outbox.dispatch()
      if (!timer) scheduleNext()
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    pollOnce,
    deliverPushed,
    webhookOutbox: outbox,
    quarantine,
    cancelTombstones,
  }
}
