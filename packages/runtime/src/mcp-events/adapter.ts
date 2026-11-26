/**
 * MCP Events adapter (W-C of `.plans/sentinel-mcp-events/PLAN.md`, §2/§3).
 *
 * Three methods over the existing Sentinel core — `events/list`,
 * `events/subscribe`, `events/unsubscribe`. This module owns the subscription
 * lifecycle; the transport (native JSON-RPC methods + `events:{}` in
 * `server/discover`) lives in `@agentproto/mcp-server` and is wired in
 * `runtime/index.ts`.
 *
 * Poll and replay: `events/poll` is served by a durable journal fed by a shared
 * provider watch (`poll-lease.ts`, `poll-journal.ts`), independent of the
 * webhook outbox. Webhook subscribe results keep `cursor: null` /
 * `truncated: false`: past events are not replayed over a webhook, poll is the
 * replay path.
 *
 * Subscription ids are deterministic (`subscription-id.ts`): subscribe upserts
 * on identity, unsubscribe RECOMPUTES the id (never an id-lookup). The store
 * has no CAS and `create()` silently overwrites, so every mutation is
 * serialized behind an in-process async mutex.
 */

import "../sentinel-platform.js"

import { decodeWhsecSecret } from "../webhook-egress/signing.js"
import { verifyCallback, type ChallengeFailureReason, type ChallengeOutcome } from "../webhook-egress/challenge.js"
import {
  deliveryPreferenceFor,
  SentinelBackingExpiredError,
  type SentinelEvent,
  type SentinelProviderHandle,
  type SentinelSpec,
  type SentinelUntil,
} from "@agentproto/sentinel"
import type { CancelTombstoneStore } from "@agentproto/sentinel"
import type { SentinelStore } from "@agentproto/sentinel"
import type { McpEventEnvelope } from "../webhook-egress/delivery.js"
import { createHash } from "node:crypto"
import { subscriptionId } from "./subscription-id.js"
import { journalKey, type JournalEvent, type PollJournal } from "./poll-journal.js"
import { PollLeaseError, type PollLeaseManager } from "./poll-lease.js"
import {
  findEventDefinition,
  tenantScope,
  validateAgainstInputSchema,
  type EventDefinition,
  type EventDeliveryMode,
  type EventRegistration,
  type Principal,
} from "./events-registry.js"

// ── TTL / refreshBefore (§3) ─────────────────────────────────────────────

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Store minimum lifetime — prevents churn-refresh for a tiny requested TTL. */
export const MIN_TTL_MS = 60 * 1000

/**
 * `refreshBefore` is the GRANTED EXPIRATION itself (`until.ms` as ISO-8601),
 * per the official doc — never a pre-expiry hint. `until:{kind:"never"}`
 * (only granted for `ttlMs: null`) yields `null`.
 */
export function computeRefreshBefore(until: SentinelUntil): string | null {
  return until.kind === "at" ? new Date(until.ms).toISOString() : null
}

/**
 * `ttlMs` mapping (§2):
 *   omitted → default 7d;
 *   number  → grant `min(requested, 30d)`, floored at 60s;
 *   null    → `until:{kind:"never"}` (no expiration).
 */
export function untilForTtl(ttlMs: number | null | undefined, now: number): SentinelUntil {
  if (ttlMs === null) return { kind: "never" }
  const requested = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs
  const granted = Math.max(MIN_TTL_MS, Math.min(requested, MAX_TTL_MS))
  return { kind: "at", ms: now + granted }
}

// ── JSON-RPC errors ──────────────────────────────────────────────────────

/**
 * An error the native-method transport surfaces verbatim as a JSON-RPC error:
 * the SDK's request path copies `code` and `data` straight onto the error
 * response, so no transport-side catch is needed.
 */
export class McpEventsError extends Error {
  readonly code: number
  readonly data?: Record<string, unknown>
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = "McpEventsError"
    this.code = code
    this.data = data
  }
}

/** Official MCP Events error codes (SEP-3415). */
export const EVENTS_ERR = {
  invalidParams: -32602,
  internal: -32603,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpoint: -32027,
} as const

/** `-32602 Invalid params` — bad args vs `inputSchema`, bad cursor, … */
export function invalidParams(reason: string, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.invalidParams, `Invalid params: ${detail}`, { reason })
}

/** `-32023 NotFound` — unknown event type. */
export function eventNotFound(reason: string, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.notFound, `NotFound: ${detail}`, { reason })
}

/** `-32024 Forbidden` — the caller may not use this event with these arguments. */
export function forbidden(reason: string, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.forbidden, `Forbidden: ${detail}`, { reason })
}

/** `-32025 ResourceExhausted` — a server-side quota is spent. */
export function resourceExhausted(reason: string, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.resourceExhausted, `ResourceExhausted: ${detail}`, { reason })
}

/** `-32026 Unsupported` — the delivery mode or provider is not offered for this event. */
export function unsupported(reason: string, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.unsupported, `Unsupported: ${detail}`, { reason })
}

/**
 * `-32027 CallbackEndpointError` with `data.reason` from the challenge table
 * (SsrfFetchReason → ChallengeFailureReason → RPC reason). The challenge
 * outcome's reason is already the RPC value, so it is passed through as-is.
 * `data.legacyCode` carries the pre-standard `-32015` for one release.
 */
export function callbackEndpointError(reason: ChallengeFailureReason, detail: string): McpEventsError {
  return new McpEventsError(EVENTS_ERR.callbackEndpoint, `CallbackEndpointError: ${detail}`, { reason, legacyCode: -32015 })
}

/**
 * The remote subscription behind a refresh could not be renewed. The spec has
 * no dedicated code, so this is `-32603` with `data.kind:"backing_subscription"`
 * (`data.legacyCode` carries the pre-standard `-32016` for one release).
 * `data.reason`:
 *   - `backing_subscription_expired`: the remote is already expired/deleted;
 *     the caller must unsubscribe and subscribe again (a refresh never
 *     silently provisions a second remote). Local state is untouched.
 *   - `backing_renew_failed`: transient (provider unreachable); retry the
 *     refresh. Local state is untouched.
 */
export function backingSubscriptionError(
  reason: "backing_subscription_expired" | "backing_renew_failed",
  detail: string,
  subscriptionId: string,
): McpEventsError {
  return new McpEventsError(EVENTS_ERR.internal, `BackingSubscriptionError: ${detail}`, {
    kind: "backing_subscription",
    reason,
    subscriptionId,
    legacyCode: -32016,
  })
}

// ── Serialize subscribe/unsubscribe mutations ────────────────────────────

let mutationChain: Promise<unknown> = Promise.resolve()

/** In-process async mutex: `SentinelStore` has no CAS and `create()`
 *  overwrites silently, so two concurrent mutations on one identity must not
 *  both run their read-modify-write. */
function withSubscribeMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn)
  mutationChain = run.catch(() => undefined)
  return run
}

// ── Types (§3) ───────────────────────────────────────────────────────────

export interface EventsListRequest {
  cursor?: string
  pageSize?: number
}

export interface EventsListContext {
  principal: Principal
  /** When false, `poll` is not advertised in `delivery` (the extension is switched off). Default true. */
  pollEnabled?: boolean
}

export interface EventsListResult {
  events: EventDefinition[]
  /** Omitted on the last page (never `null`). */
  nextCursor?: string
}

export interface EventsSubscribeInput {
  name: string
  arguments: Record<string, unknown>
  delivery: { mode: "webhook"; url: string; secret: string }
  ttlMs?: number | null
  /** Validated, but webhook delivery never replays past events: poll is the replay path. */
  cursor?: string | null
  maxAgeMs?: number
}

export interface EventsSubscribeContext {
  principal: Principal
  store: SentinelStore
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  nowMs?: () => number
  /** DI seam (tests): replaces `verifyCallback`'s POST boundary. */
  verify?: typeof verifyCallback
  activeIntervalMs?: number
}

export interface EventsSubscribeResult {
  id: `sub_${string}`
  refreshBefore: string | null
  cursor: string | null
  truncated?: boolean
}

export interface EventsUnsubscribeInput {
  name: string
  arguments: Record<string, unknown>
  /** `mode` is optional and defaults to `webhook`. */
  delivery: { mode?: "webhook"; url: string }
}

export interface EventsUnsubscribeContext {
  principal: Principal
  store: SentinelStore
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** Persisted remote-cancel store. Present ⇒ unsubscribe records a tombstone
   *  keyed by provider + remote id, drops the local row (delivery eligibility
   *  ends immediately) and lets the sweep converge an unreachable remote. */
  tombstones?: CancelTombstoneStore
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const LIST_PAGE_DEFAULT = 50
const LIST_PAGE_MAX = 200

/** Opaque list cursor = offset + scheme checkpoint (base64url JSON). */
function encodeListCursor(offset: number, scheme: string): string {
  return Buffer.from(JSON.stringify({ offset, scheme }), "utf8").toString("base64url")
}

function decodeListCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown }
    if (typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("bad offset")
    }
    return parsed.offset
  } catch {
    throw invalidParams("invalid_cursor", "`cursor` is not a cursor issued by a previous events/list response")
  }
}

function requireWebhookDelivery(
  delivery: unknown,
  opts: { modeOptional?: boolean } = {},
): { mode: "webhook"; url: string; secret?: string } {
  if (!isRecord(delivery)) throw invalidParams("invalid_delivery", "`delivery` must be an object")
  const mode = delivery.mode
  if (mode === undefined ? !opts.modeOptional : mode !== "webhook") {
    throw unsupported("unsupported_delivery_mode", 'delivery.mode must be "webhook" (use events/poll for pull delivery)')
  }
  if (typeof delivery.url !== "string" || delivery.url.length === 0) {
    throw invalidParams("invalid_callback_url", "delivery.url is required")
  }
  return { mode: "webhook", url: delivery.url, ...(typeof delivery.secret === "string" ? { secret: delivery.secret } : {}) }
}

function validateArgsOrThrow(name: string, registration: EventRegistration, args: unknown): Record<string, unknown> {
  if (!isRecord(args)) throw invalidParams("invalid_arguments", "`arguments` must be an object")
  const schemaCheck = validateAgainstInputSchema(registration.definition.inputSchema, args)
  if (!schemaCheck.ok) {
    throw invalidParams("invalid_arguments", `arguments for "${name}": ${schemaCheck.reason}`)
  }
  return args
}

// ── events/list ──────────────────────────────────────────────────────────

export async function eventsList(r: EventsListRequest, ctx: EventsListContext): Promise<EventsListResult> {
  const schemes = tenantScope(ctx.principal)
  const pollEnabled = ctx.pollEnabled !== false
  const definitions = schemes.flatMap((scheme) =>
    scheme.events.map((event): EventDefinition => ({
      ...event.definition,
      delivery: event.definition.delivery.filter((mode): mode is EventDeliveryMode => pollEnabled || mode !== "poll"),
    })),
  )
  const requested = r.pageSize ?? LIST_PAGE_DEFAULT
  const pageSize = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : LIST_PAGE_DEFAULT, LIST_PAGE_MAX))
  const offset = decodeListCursor(r.cursor)
  const page = definitions.slice(offset, offset + pageSize)
  const next = offset + page.length
  const scheme = schemes[0]?.scheme ?? "*"
  return { events: page, ...(next < definitions.length ? { nextCursor: encodeListCursor(next, scheme) } : {}) }
}

// ── events/subscribe ─────────────────────────────────────────────────────

export async function eventsSubscribe(
  input: EventsSubscribeInput,
  ctx: EventsSubscribeContext,
): Promise<EventsSubscribeResult> {
  const now = ctx.nowMs ?? Date.now

  const registration = findEventDefinition(input.name)
  if (!registration) throw eventNotFound("unknown_event", `unknown event "${input.name}"`)
  const args = validateArgsOrThrow(input.name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw forbidden("unauthorized", `not authorized to subscribe to "${input.name}" with the given arguments`)
  }
  const mapped = registration.meta.argumentsToMatch(args)
  if (!mapped.ok) throw invalidParams("invalid_arguments", `arguments for "${input.name}": ${mapped.reason}`)

  const delivery = requireWebhookDelivery(input.delivery)
  const secret = delivery.secret
  if (secret === undefined || decodeWhsecSecret(secret) === null) {
    throw invalidParams(
      "invalid_secret",
      "delivery.secret must be `whsec_` followed by base64 that decodes to 24..64 bytes",
    )
  }
  if (input.ttlMs !== undefined && input.ttlMs !== null && (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs))) {
    throw invalidParams("invalid_ttl", "`ttlMs` must be a finite number or null")
  }
  if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== "string") {
    throw invalidParams("invalid_cursor", "`cursor` must be a string or null")
  }
  validateMaxAgeMs(input.maxAgeMs)

  const id = subscriptionId({
    principal: ctx.principal,
    callbackUrl: delivery.url,
    eventName: input.name,
    args,
  })

  // verifyCallback FIRST, before any store mutation (plan §4 W-C task 3). The
  // challenge cache is keyed on sha256(secret), so a NEW secret during a
  // refresh always misses and forces a fresh challenge — the cache can never
  // bless an unverified secret.
  const verify = ctx.verify ?? verifyCallback
  const outcome: ChallengeOutcome = await verify({ principal: ctx.principal, url: delivery.url, subscriptionId: id, secret })
  if (!outcome.ok) throw callbackEndpointError(outcome.reason, outcome.detail)

  return withSubscribeMutex(async () => {
    const until = untilForTtl(input.ttlMs, now())
    const existing = ctx.store.get(id)

    if (existing) {
      // REFRESH: same deterministic identity. Rotate the signing secret when
      // the submitted one differs (`putSentinelSecret` records
      // `prevSecret` + `rotatedAt`; delivery dual-signs during the window).
      // A submitted cursor is validated but not replayed over the webhook.
      const target = existing.spec.target
      if (target.kind !== "webhook") {
        throw invalidParams("identity_conflict", `subscription ${id} exists with a non-webhook target`)
      }
      // Renew the backing remote FIRST: local TTL/secret only move once the
      // remote lifetime has moved, so a failure leaves the previous state
      // intact and local never outlives the remote.
      let handle = existing.handle
      const provider = await ctx.resolveProvider(existing.provider)
      if (provider?.renew) {
        try {
          handle = await provider.renew(existing.handle, until)
        } catch (err) {
          if (err instanceof SentinelBackingExpiredError) {
            throw backingSubscriptionError(
              "backing_subscription_expired",
              `${err.message}; unsubscribe and subscribe again`,
              id,
            )
          }
          throw backingSubscriptionError(
            "backing_renew_failed",
            err instanceof Error ? err.message : String(err),
            id,
          )
        }
      }
      const ref = ctx.store.materializeWebhookTargetRef(target)
      if (ref !== undefined) ctx.store.putSentinelSecret(ref, { secret })
      ctx.store.update(id, { spec: { ...existing.spec, until }, handle, status: "active" })
      return { id, refreshBefore: computeRefreshBefore(until), cursor: null, truncated: false }
    }

    // CREATE
    const provider = await ctx.resolveProvider(mapped.providerSlug)
    if (!provider) {
      throw unsupported("provider_unavailable", `sentinel provider "${mapped.providerSlug}" is not available`)
    }
    const spec: SentinelSpec = {
      match: mapped.matchClauses,
      until,
      target: { kind: "webhook", url: delivery.url, secret },
      provider: mapped.providerSlug,
    }
    const handle = await provider.create(spec, deliveryPreferenceFor(provider, ctx.activeIntervalMs ?? 15_000), {
      sentinelId: id,
    })
    ctx.store.create({ id, spec, provider: mapped.providerSlug, handle })
    return { id, refreshBefore: computeRefreshBefore(until), cursor: null, truncated: false }
  })
}

// ── events/unsubscribe ───────────────────────────────────────────────────

export async function eventsUnsubscribe(
  input: EventsUnsubscribeInput,
  ctx: EventsUnsubscribeContext,
): Promise<{}> {
  const registration = findEventDefinition(input.name)
  if (!registration) throw eventNotFound("unknown_event", `unknown event "${input.name}"`)
  const args = validateArgsOrThrow(input.name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw forbidden("unauthorized", `not authorized to unsubscribe from "${input.name}" with the given arguments`)
  }
  const delivery = requireWebhookDelivery(input.delivery, { modeOptional: true })

  // RECOMPUTE the deterministic id (never an id-lookup): unsubscribe identity
  // is the SAME identity subscribe used, minus the secret.
  const id = subscriptionId({
    principal: ctx.principal,
    callbackUrl: delivery.url,
    eventName: input.name,
    args,
  })

  await withSubscribeMutex(async () => {
    const existing = ctx.store.get(id)
    if (!existing) return // idempotent: second call returns {} with no record
    if (ctx.tombstones) {
      try {
        // Tombstone durable → local row dropped (no more deliveries) → remote
        // delete attempted; if it fails the sweep retries until 404/204.
        await ctx.tombstones.cancel(existing.handle, () => ctx.store.remove(id))
        return
      } catch {
        // Could not persist the intent: fall back to best-effort below.
      }
    }
    const provider = await ctx.resolveProvider(existing.provider)
    if (provider) {
      try {
        await provider.cancel(existing.handle)
      } catch {
        // Best-effort — a stuck provider-side watch must not strand removal.
      }
    }
    ctx.store.remove(id)
  })
  return {}
}

// ── Envelope mapping (canonical owner) ───────────────────────────────────

/**
 * CloudEvents `SentinelEvent` → the MCP Events wire envelope (official doc
 * verbatim): `id→eventId`, `type→name`, `time→timestamp`, `data→data` (plus
 * the `subject`/`summary` projection so the 256 KiB clamp's `{summary,
 * subject}` replacement never goes blind), and `cursor: null` (v1
 * non-replayable). No top-level `type` — that field is reserved for protocol
 * control notifications we never send.
 */
export function toMcpEvent(event: SentinelEvent): McpEventEnvelope {
  return {
    eventId: event.id,
    name: event.type,
    timestamp: event.time,
    data: { ...event.data, subject: event.subject, summary: event.summary },
    cursor: null,
  }
}

/** The journal/poll event shape: the webhook envelope without its `cursor` member. */
export function toJournalEvent(event: SentinelEvent): JournalEvent {
  const { eventId, name, timestamp, data } = toMcpEvent(event)
  return { eventId, name, timestamp, data }
}

function validateMaxAgeMs(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidParams("invalid_max_age", "`maxAgeMs` must be a positive number")
  }
}

// ── events/poll ──────────────────────────────────────────────────────────

export const POLL_DEFAULT_MAX_EVENTS = 100
export const POLL_MAX_EVENTS = 1000

export interface EventsPollInput {
  name: string
  arguments: Record<string, unknown>
  /** `null` / omitted = from now. */
  cursor?: string | null
  maxAgeMs?: number
  maxEvents?: number
}

export interface EventsPollContext {
  principal: Principal
  journal: PollJournal
  leases: PollLeaseManager
}

export interface EventsPollResult {
  events: JournalEvent[]
  cursor: string
  truncated: boolean
  hasMore: boolean
  nextPollMs: number
}

function principalTag(principal: Principal): string {
  return createHash("sha256").update(principal).digest("base64url").slice(0, 12)
}

function encodePollCursor(journalId: string, seq: number, principal: Principal): string {
  return Buffer.from(JSON.stringify({ v: 1, j: journalId, s: seq, p: principalTag(principal) }), "utf8").toString("base64url")
}

function decodePollCursor(cursor: string, principal: Principal): { journalId: string; seq: number } {
  let parsed: { v?: unknown; j?: unknown; s?: unknown; p?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw invalidParams("invalid_cursor", "`cursor` is not a cursor issued by a previous events/poll response")
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.v !== 1 ||
    typeof parsed.j !== "string" ||
    typeof parsed.s !== "number" ||
    !Number.isInteger(parsed.s) ||
    parsed.s < 0 ||
    typeof parsed.p !== "string"
  ) {
    throw invalidParams("invalid_cursor", "`cursor` is not a cursor issued by a previous events/poll response")
  }
  if (parsed.p !== principalTag(principal)) {
    throw forbidden("cursor_principal_mismatch", "`cursor` was issued to a different caller")
  }
  return { journalId: parsed.j, seq: parsed.s }
}

/**
 * `events/poll`: pull the events of `(name, arguments)` after `cursor`. Needs no
 * prior subscribe; the cursor is the client's only state. `cursor: null` starts
 * from now; a cursor older than the journal (or the retention, or a watch gap)
 * answers `truncated: true` with the events that remain, never an error.
 */
export async function eventsPoll(input: EventsPollInput, ctx: EventsPollContext): Promise<EventsPollResult> {
  const registration = findEventDefinition(input.name)
  if (!registration) throw eventNotFound("unknown_event", `unknown event "${input.name}"`)
  const args = validateArgsOrThrow(input.name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw forbidden("unauthorized", `not authorized to poll "${input.name}" with the given arguments`)
  }
  if (!registration.definition.delivery.includes("poll") || !registration.meta.replayable) {
    throw unsupported("unsupported_delivery_mode", `"${input.name}" is not offered for poll delivery`)
  }
  const mapped = registration.meta.argumentsToMatch(args)
  if (!mapped.ok) throw invalidParams("invalid_arguments", `arguments for "${input.name}": ${mapped.reason}`)

  if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== "string") {
    throw invalidParams("invalid_cursor", "`cursor` must be a string or null")
  }
  validateMaxAgeMs(input.maxAgeMs)
  let maxEvents = POLL_DEFAULT_MAX_EVENTS
  if (input.maxEvents !== undefined) {
    if (typeof input.maxEvents !== "number" || !Number.isInteger(input.maxEvents) || input.maxEvents < 1) {
      throw invalidParams("invalid_max_events", "`maxEvents` must be a positive integer")
    }
    maxEvents = Math.min(input.maxEvents, POLL_MAX_EVENTS)
  }
  const after = typeof input.cursor === "string" ? decodePollCursor(input.cursor, ctx.principal) : null

  const key = journalKey(input.name, args)
  try {
    await ctx.leases.acquire({ key, name: input.name, mapped })
  } catch (err) {
    if (err instanceof PollLeaseError) {
      if (err.kind === "exhausted") throw resourceExhausted("poll_watch_quota", err.message)
      if (err.kind === "unsupported") throw unsupported("provider_unavailable", err.message)
      throw new McpEventsError(EVENTS_ERR.internal, `BackingSubscriptionError: ${err.message}`, {
        kind: "backing_subscription",
        reason: "backing_create_failed",
      })
    }
    throw err
  }

  const read = ctx.journal.read(key, { after, ...(input.maxAgeMs !== undefined ? { maxAgeMs: input.maxAgeMs } : {}), maxEvents })
  return {
    events: read.events.map(e => e.event),
    cursor: encodePollCursor(read.journalId, read.lastReturnedSeq, ctx.principal),
    truncated: read.truncated,
    hasMore: read.hasMore,
    nextPollMs: read.hasMore ? 0 : ctx.leases.nextPollMs,
  }
}
