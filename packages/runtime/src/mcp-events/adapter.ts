/**
 * MCP Events adapter (W-C of `.plans/sentinel-mcp-events/PLAN.md`, §2/§3).
 *
 * Three methods over the existing Sentinel core — `events/list`,
 * `events/subscribe`, `events/unsubscribe`. This module owns the subscription
 * lifecycle; the transport (native JSON-RPC methods + `events:{}` in
 * `server/discover`) lives in `@agentproto/mcp-server` and is wired in
 * `runtime/index.ts`.
 *
 * INVARIANTS v1 (plan §2, code-verified):
 *   - every event is NON-REPLAYABLE → `cursor` is always `null`, `truncated`
 *     is never set;
 *   - no `read` tool, no separate package, no batching.
 *
 * Subscription ids are deterministic (`subscription-id.ts`): subscribe upserts
 * on identity, unsubscribe RECOMPUTES the id (never an id-lookup). The store
 * has no CAS and `create()` silently overwrites, so every mutation is
 * serialized behind an in-process async mutex.
 */

import { decodeWhsecSecret } from "../webhook-egress/signing.js"
import { verifyCallback, type ChallengeFailureReason, type ChallengeOutcome } from "../webhook-egress/challenge.js"
import {
  deliveryPreferenceFor,
  SentinelBackingExpiredError,
  type SentinelEvent,
  type SentinelProviderHandle,
  type SentinelSpec,
  type SentinelUntil,
} from "../sentinel-providers/types.js"
import type { CancelTombstoneStore } from "../sentinel-cancel-tombstones.js"
import type { SentinelStore } from "../sentinel-store.js"
import type { McpEventEnvelope } from "../webhook-egress/delivery.js"
import { subscriptionId } from "./subscription-id.js"
import {
  findEventDefinition,
  tenantScope,
  validateAgainstInputSchema,
  type EventDefinition,
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

/** `-32602 Invalid params` — unknown event, bad args vs `inputSchema`, … */
export function invalidParams(reason: string, detail: string): McpEventsError {
  return new McpEventsError(-32602, `Invalid params: ${detail}`, { reason })
}

/**
 * `-32015 CallbackEndpointError` with `data.reason` from the §3 challenge
 * table (SsrfFetchReason → ChallengeFailureReason → RPC reason). The
 * challenge outcome's reason is already the RPC value, so it is passed
 * through as-is.
 */
export function callbackEndpointError(reason: ChallengeFailureReason, detail: string): McpEventsError {
  return new McpEventsError(-32015, `CallbackEndpointError: ${detail}`, { reason })
}

/**
 * `-32016 BackingSubscriptionError` — the remote subscription behind a
 * refresh could not be renewed. `data.reason`:
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
  return new McpEventsError(-32016, `BackingSubscriptionError: ${detail}`, { reason, subscriptionId })
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
}

export interface EventsListResult {
  events: EventDefinition[]
  nextCursor: string | null
}

export interface EventsSubscribeInput {
  name: string
  arguments: Record<string, unknown>
  delivery: { mode: "webhook"; url: string; secret: string }
  ttlMs?: number | null
  /** Refresh/replay handle (null on first subscribe). v1 ignores it: all
   *  events are non-replayable, so it never changes the returned cursor. */
  cursor?: string | null
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
  delivery: { mode: "webhook"; url: string }
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

function requireWebhookDelivery(delivery: unknown): { mode: "webhook"; url: string; secret?: string } {
  if (!isRecord(delivery) || delivery.mode !== "webhook") {
    throw invalidParams("unsupported_delivery_mode", 'delivery.mode must be "webhook"')
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
  const definitions = schemes.flatMap((scheme) => scheme.events.map((event) => event.definition))
  const requested = r.pageSize ?? LIST_PAGE_DEFAULT
  const pageSize = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : LIST_PAGE_DEFAULT, LIST_PAGE_MAX))
  const offset = decodeListCursor(r.cursor)
  const page = definitions.slice(offset, offset + pageSize)
  const next = offset + page.length
  const scheme = schemes[0]?.scheme ?? "*"
  return { events: page, nextCursor: next < definitions.length ? encodeListCursor(next, scheme) : null }
}

// ── events/subscribe ─────────────────────────────────────────────────────

export async function eventsSubscribe(
  input: EventsSubscribeInput,
  ctx: EventsSubscribeContext,
): Promise<EventsSubscribeResult> {
  const now = ctx.nowMs ?? Date.now

  const registration = findEventDefinition(input.name)
  if (!registration) throw invalidParams("unknown_event", `unknown event "${input.name}"`)
  const args = validateArgsOrThrow(input.name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw invalidParams("unauthorized", `not authorized to subscribe to "${input.name}" with the given arguments`)
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
      // A submitted cursor is IGNORED — v1 events are non-replayable.
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
      return { id, refreshBefore: computeRefreshBefore(until), cursor: null }
    }

    // CREATE
    const provider = await ctx.resolveProvider(mapped.providerSlug)
    if (!provider) {
      throw invalidParams("provider_unavailable", `sentinel provider "${mapped.providerSlug}" is not available`)
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
    return { id, refreshBefore: computeRefreshBefore(until), cursor: null }
  })
}

// ── events/unsubscribe ───────────────────────────────────────────────────

export async function eventsUnsubscribe(
  input: EventsUnsubscribeInput,
  ctx: EventsUnsubscribeContext,
): Promise<{}> {
  const registration = findEventDefinition(input.name)
  if (!registration) throw invalidParams("unknown_event", `unknown event "${input.name}"`)
  const args = validateArgsOrThrow(input.name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw invalidParams("unauthorized", `not authorized to unsubscribe from "${input.name}" with the given arguments`)
  }
  const delivery = requireWebhookDelivery(input.delivery)

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
