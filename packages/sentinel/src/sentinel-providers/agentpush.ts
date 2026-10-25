/**
 * `agentpush` — the hosted sentinel provider (AIP-60 §5): a thin adapter over
 * the agentpush subscription API. Watching = one subscription
 * (`POST /subscriptions`, `consumerRef = agentproto:sentinel:<id>`); agentpush
 * queues matching events server-side, so they survive daemon downtime.
 *
 * Delivery modes:
 *   - poll (default): the runtime's poll loop calls `poll` (`GET
 *     /subscriptions/:id/events?after=<seq>`) and, once a batch is delivered,
 *     `ack` (`POST …/ack {upToSeq}`). The seq cursor lives in
 *     `SentinelHandle.cursor`, persisted in the sentinel store. Acked rows
 *     never come back from the server, so a restart resumes exactly where it
 *     stopped; a crash between delivery and ack re-serves the batch and the
 *     runtime's persisted `seen` window drops the duplicates (at-least-once).
 *   - push (opt-in via the `delivery: push` credential, needs a public https
 *     daemon URL): agentpush POSTs each envelope to
 *     `/inbound/sentinel-<hookKey>`; {@link parseInbound} verifies signature
 *     v2 with the per-sentinel callback secret. Subscriptions created here
 *     are stamped `state.signature = "v2"` and REJECT the legacy body-only
 *     `sha256=` header (no timestamp, so replayable); only handles persisted
 *     before the stamp existed still accept it. `poll` is then a no-op —
 *     agentpush owns retry/dead-lettering.
 *
 * The agentpush envelope IS `SentinelEvent` (design §4), passed through
 * unchanged. Signature verification mirrors agentpush's `verifySignatureV2`
 * locally — no dependency on the agentpush packages.
 *
 * Credentials: a workspace API key (`apiKey`, from `setup_sentinel_provider`
 * → `~/.agentproto/sentinel-creds/agentpush.json`, 0600) or, failing that, the
 * bearer of an imported `agentpush` MCP alias. The key is only ever placed in
 * the `Authorization` header — never logged, echoed, or put in a handle.
 * The per-sentinel callback secret lives in `handle.state` (the sentinel store
 * is 0600), never in tool output.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { verifyInboundSignature } from "../inbound-adapters.js"
import { loadImportedMcps } from "../mcp-imports.js"
import { GITHUB_DEFAULT_PR_TYPES } from "../sentinel-github-normalize.js"
import { resolveSentinelPublicUrl, type SentinelPublicUrl } from "../sentinel-public-url.js"
import { WEBHOOK_ROUTE_PREFIX } from "./webhook.js"
import {
  SentinelBackingExpiredError,
  type DeliveryPreference,
  type SentinelCreateContext,
  type SentinelEvent,
  type SentinelHandle,
  type SentinelMalformedItem,
  type SentinelPollResult,
  type SentinelProviderHandle,
  type SentinelProviderReadiness,
  type SentinelSpec,
  type SentinelUntil,
} from "./types.js"

export const AGENTPUSH_SLUG = "agentpush"
export const AGENTPUSH_DEFAULT_BASE_URL = "https://api.agentpush.io"
/** Alias name an imported agentpush MCP is expected under. */
export const AGENTPUSH_MCP_ALIAS = "agentpush"

const REQUEST_TIMEOUT_MS = 15_000
const SIGNATURE_V2_SKEW_MS = 5 * 60 * 1000

// ── Signature v2 (mirror of agentpush `verifySignatureV2`) ──────────────────

export type SignatureV2Failure =
  | "missing_timestamp"
  | "invalid_timestamp"
  | "timestamp_skew"
  | "missing_signature"
  | "invalid_signature"
  | "signature_mismatch"

export type VerifySignatureV2Result = { ok: true; timestampSec: number } | { ok: false; reason: SignatureV2Failure }

type HeaderBag = Record<string, string | string[] | undefined>

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === "string") return value
    if (value && value.length > 0) return value[0]
  }
  return undefined
}

/** `hex(HMAC-SHA256(secret, timestampSec + "." + body))`. */
export function computeSignatureV2(secret: string, timestampSec: number | string, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex")
}

/** Receiver-side check of `X-Agentpush-Timestamp` + `X-Agentpush-Signature:
 *  v2=<hex>`. `body` must be the exact raw text received. Fails closed on a
 *  missing/garbled header, a timestamp further than `skewMs` from `nowMs`
 *  (either direction), or a MAC mismatch (constant-time). */
export function verifySignatureV2(
  secret: string,
  headers: HeaderBag,
  body: string,
  nowMs: number,
  skewMs: number = SIGNATURE_V2_SKEW_MS,
): VerifySignatureV2Result {
  const rawTimestamp = headerValue(headers, "x-agentpush-timestamp")
  if (rawTimestamp === undefined || rawTimestamp.trim() === "") return { ok: false, reason: "missing_timestamp" }
  const timestamp = rawTimestamp.trim()
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "invalid_timestamp" }
  const timestampSec = Number(timestamp)
  if (Math.abs(nowMs - timestampSec * 1000) > skewMs) return { ok: false, reason: "timestamp_skew" }

  const rawSignature = headerValue(headers, "x-agentpush-signature")
  if (rawSignature === undefined || rawSignature.trim() === "") return { ok: false, reason: "missing_signature" }
  const token = rawSignature
    .split(",")
    .map(part => part.trim())
    .find(part => part.startsWith("v2="))
  if (!token) return { ok: false, reason: "invalid_signature" }
  const provided = token.slice("v2=".length).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: "invalid_signature" }

  const a = Buffer.from(provided, "hex")
  const b = Buffer.from(computeSignatureV2(secret, timestamp, body), "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" }
  return { ok: true, timestampSec }
}

// ── Envelope ────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Validate one CloudEvents envelope as agentpush emits it. The shape is
 *  agentpush's `EventEnvelope` == `SentinelEvent`; nothing is re-mapped. */
export function toSentinelEvent(raw: unknown, seq?: number): SentinelEvent | null {
  if (!isRecord(raw)) return null
  const { id, source, type, subject, time, data, summary, subjects, terminal, consumerref } = raw
  if (
    raw.specversion !== "1.0" ||
    typeof id !== "string" || id === "" ||
    typeof source !== "string" ||
    typeof type !== "string" || type === "" ||
    typeof subject !== "string" || subject === "" ||
    typeof time !== "string" ||
    !isRecord(data) ||
    typeof summary !== "string" ||
    !Array.isArray(subjects) || !subjects.every(s => typeof s === "string") ||
    typeof terminal !== "boolean"
  ) {
    return null
  }
  const envSeq = typeof raw.seq === "number" ? raw.seq : seq
  return {
    specversion: "1.0",
    id,
    source,
    type,
    subject,
    time,
    datacontenttype: "application/json",
    data,
    summary,
    subjects: subjects as string[],
    terminal,
    ...(typeof consumerref === "string" ? { consumerref } : {}),
    ...(envSeq !== undefined ? { seq: envSeq } : {}),
  }
}

// ── Errors / small helpers ──────────────────────────────────────────────────

/** Provider setup problem with an actionable message (no API key, unsupported
 *  spec). Surfaces as `provider_create_failed`. */
export class AgentpushSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentpushSetupError"
  }
}

export class AgentpushHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "AgentpushHttpError"
    this.status = status
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isHttp = (err: unknown, status: number): boolean => err instanceof AgentpushHttpError && err.status === status

const NO_API_KEY =
  "the agentpush provider needs a workspace API key: run `setup_sentinel_provider` (provider `agentpush`, " +
  "field `apiKey`), or import an `agentpush` MCP alias whose bearer token can be reused"

function callbackUrl(origin: string, hookKey: string): string {
  return `${origin}/inbound/${WEBHOOK_ROUTE_PREFIX}${hookKey}`
}

type AgentpushMode = "poll" | "push"

interface AgentpushState {
  mode: AgentpushMode
  consumerRef?: string
  hookKey?: string
  callbackSecret?: string
  /** `"v2"` = created by a build that requires timestamped v2 signatures. */
  signature?: "v2"
}

function stateOf(handle: SentinelHandle): AgentpushState {
  const s = handle.state ?? {}
  return {
    mode: s.mode === "push" ? "push" : "poll",
    ...(typeof s.consumerRef === "string" ? { consumerRef: s.consumerRef } : {}),
    ...(typeof s.hookKey === "string" ? { hookKey: s.hookKey } : {}),
    ...(typeof s.callbackSecret === "string" ? { callbackSecret: s.callbackSecret } : {}),
    ...(s.signature === "v2" ? { signature: "v2" as const } : {}),
  }
}

/** Identifiers lifted from a poison envelope for the quarantine record —
 *  strings only, length-capped, never the payload `data`. */
function excerptOf(envelope: unknown): SentinelMalformedItem["excerpt"] | undefined {
  if (!isRecord(envelope)) return undefined
  const cap = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, 200) : undefined)
  const out: NonNullable<SentinelMalformedItem["excerpt"]> = {}
  const id = cap(envelope.id)
  const type = cap(envelope.type)
  const subject = cap(envelope.subject)
  const source = cap(envelope.source)
  if (id !== undefined) out.id = id
  if (type !== undefined) out.type = type
  if (subject !== undefined) out.subject = subject
  if (source !== undefined) out.source = source
  return Object.keys(out).length > 0 ? out : undefined
}

function whyNotEnvelope(envelope: unknown): string {
  if (envelope === undefined || envelope === null) return "item has no envelope"
  if (!isRecord(envelope)) return "envelope is not a JSON object"
  const missing: string[] = []
  if (envelope.specversion !== "1.0") missing.push("specversion")
  for (const k of ["id", "type", "subject"] as const) if (typeof envelope[k] !== "string" || envelope[k] === "") missing.push(k)
  for (const k of ["source", "time", "summary"] as const) if (typeof envelope[k] !== "string") missing.push(k)
  if (!isRecord(envelope.data)) missing.push("data")
  if (!Array.isArray(envelope.subjects) || !envelope.subjects.every(x => typeof x === "string")) missing.push("subjects")
  if (typeof envelope.terminal !== "boolean") missing.push("terminal")
  return `envelope failed validation (invalid or missing: ${missing.join(", ") || "unknown"})`
}

const SUBJECT_SCHEME_RE = /^([A-Za-z][A-Za-z0-9_-]*):/

function defaultTypesFor(subject: string): string[] {
  return subject.startsWith("github:") ? [...GITHUB_DEFAULT_PR_TYPES] : ["*"]
}

/** agentpush's `Authorization` bearer from an imported `agentpush` MCP alias. */
async function importedAliasBearer(): Promise<string | undefined> {
  try {
    const config = await loadImportedMcps()
    const entry = config.imports.find(e => e.alias === AGENTPUSH_MCP_ALIAS)
    const headers = entry?.snapshot.headers
    if (!headers) return undefined
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue
      const m = /^Bearer\s+(\S+)$/i.exec(value.trim())
      if (m) return m[1]
    }
  } catch {
    // unreadable/corrupt imports file — treated as "no alias".
  }
  return undefined
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface AgentpushProviderOptions {
  /** Stored creds for the slug: `apiKey`, optional `baseUrl`, optional
   *  `delivery` (`poll` | `push`). */
  creds?: Record<string, string> | null
  /** Base URL override (wins over `creds.baseUrl`). */
  baseUrl?: string
  /** Injectable for tests — defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Injectable public URL source — defaults to the daemon-wired resolver. */
  publicUrl?: () => SentinelPublicUrl | undefined
  /** Injectable imported-alias bearer lookup. */
  importedBearer?: () => Promise<string | undefined>
  now?: () => Date
}

export function agentpushSentinelProvider(opts: AgentpushProviderOptions = {}): SentinelProviderHandle {
  const doFetch = opts.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init))
  const publicUrl = opts.publicUrl ?? resolveSentinelPublicUrl
  const importedBearer = opts.importedBearer ?? importedAliasBearer
  const now = opts.now ?? (() => new Date())

  const baseUrl = (opts.baseUrl ?? opts.creds?.baseUrl?.trim() ?? AGENTPUSH_DEFAULT_BASE_URL).replace(/\/+$/, "")
  const wantsPush = opts.creds?.delivery?.trim().toLowerCase() === "push"

  async function apiKey(): Promise<string | undefined> {
    return opts.creds?.apiKey?.trim() || (await importedBearer())
  }

  async function api(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    o: { body?: unknown; query?: Record<string, string | number> } = {},
  ): Promise<unknown> {
    const key = await apiKey()
    if (!key) throw new AgentpushSetupError(NO_API_KEY)
    const qs = o.query
      ? "?" + Object.entries(o.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
      : ""
    let res: Response
    try {
      res = await doFetch(`${baseUrl}${path}${qs}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`agentpush ${method} ${path} failed: ${errMsg(err)}`)
    }
    if (res.status === 204) return undefined
    const text = await res.text().catch(() => "")
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const detail = isRecord(json) && typeof json.error === "string" ? json.error : text.slice(0, 200)
      throw new AgentpushHttpError(res.status, `agentpush ${method} ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`)
    }
    return json
  }

  const subPath = (handle: SentinelHandle): string => {
    if (!handle.remoteId) throw new Error("agentpush: handle has no subscription id")
    return `/subscriptions/${encodeURIComponent(handle.remoteId)}`
  }

  /** One subscription serves one subject; several clauses are fine only when
   *  they share it (types are unioned — the runtime still filters per clause). */
  function subscriptionShape(spec: SentinelSpec): { source: string; subject: string; types: string[] | null } {
    if (spec.match.length === 0) throw new AgentpushSetupError("agentpush: the spec has no match clause")
    const subject = spec.match[0]!.subject
    if (spec.match.some(c => c.subject !== subject)) {
      throw new AgentpushSetupError(
        "agentpush: one sentinel watches one subject — create one sentinel per subject " +
          `(got ${[...new Set(spec.match.map(c => c.subject))].join(", ")})`,
      )
    }
    const scheme = SUBJECT_SCHEME_RE.exec(subject)?.[1]
    if (!scheme) throw new AgentpushSetupError(`agentpush: subject "${subject}" must look like "<scheme>:<path>"`)
    const types = new Set<string>()
    for (const clause of spec.match) {
      for (const t of clause.types && clause.types.length > 0 ? clause.types : defaultTypesFor(subject)) types.add(t)
    }
    return { source: scheme.toLowerCase(), subject, types: types.has("*") ? null : [...types] }
  }

  return {
    slug: AGENTPUSH_SLUG,
    name: "agentpush",
    version: "0.1.0",
    description:
      "Hosted event subscriptions over the agentpush service — GitHub App installs, Telegram bots, generic hooks. " +
      "Events queue server-side (durable across daemon downtime), delivered by poll (default, no public URL) or push. " +
      "Needs an agentpush workspace API key.",
    // Credentials come from `setup_sentinel_provider` OR an imported alias, so
    // "set up" is decided by `readiness()`, not the kit's ledger/creds check.
    requiresSetup: false,
    exclusiveRemote: true,
    capabilities: {
      subjects: ["*"],
      push: true,
      poll: true,
      durable: true,
      needsPublicUrl: false,
      requiresAuth: true,
      typicalLatencyMs: 15_000,
    },
    setupFields: [
      { name: "apiKey", description: "agentpush workspace API key (Bearer). Stored 0600, never returned.", required: true, sensitive: true },
      { name: "baseUrl", description: `agentpush API base URL. Default ${AGENTPUSH_DEFAULT_BASE_URL}.`, required: false, sensitive: false },
      {
        name: "delivery",
        description:
          "`poll` (default, no public URL needed) or `push` (agentpush calls back into this daemon; needs a public https daemon URL, else polls).",
        required: false,
        sensitive: false,
      },
    ],

    async check(): Promise<boolean> {
      return (await apiKey()) !== undefined
    },

    /** Offline: reports whether a key is available, without spending an API
     *  call per listing. A wrong/revoked key surfaces on `create`. */
    async readiness(): Promise<SentinelProviderReadiness> {
      return (await apiKey()) ? { ready: true } : { ready: false, reason: NO_API_KEY }
    },

    preferredDelivery(intervalMs: number): DeliveryPreference {
      if (wantsPush) {
        const pub = publicUrl()
        if (pub?.url.startsWith("https://")) return { mode: "push", callbackUrl: pub.url }
      }
      return { mode: "poll", intervalMs }
    },

    async create(spec: SentinelSpec, delivery: DeliveryPreference, ctx?: SentinelCreateContext): Promise<SentinelHandle> {
      const { source, subject, types } = subscriptionShape(spec)
      const sentinelId = ctx?.sentinelId ?? `unbound_${randomBytes(6).toString("hex")}`
      const consumerRef = `agentproto:sentinel:${sentinelId}`

      // push needs somewhere to call: without an origin, poll instead.
      const push = delivery.mode === "push" && typeof delivery.callbackUrl === "string" && delivery.callbackUrl !== ""
      const hookKey = push ? randomBytes(16).toString("hex") : undefined
      const callbackSecret = push ? randomBytes(32).toString("hex") : undefined

      const json = await api("POST", "/subscriptions", {
        body: {
          name: `agentproto sentinel ${sentinelId}`,
          source,
          subject,
          types,
          mode: push ? "push" : "poll",
          consumer_ref: consumerRef,
          until: spec.until,
          ...(push ? { callback_url: callbackUrl((delivery as { callbackUrl: string }).callbackUrl, hookKey!), callback_secret: callbackSecret } : {}),
        },
      })
      const id = isRecord(json) && isRecord(json.subscription) ? json.subscription.id : undefined
      if (typeof id !== "string" || id === "") throw new Error("agentpush: create returned no subscription id")

      return {
        provider: AGENTPUSH_SLUG,
        remoteId: id,
        cursor: "0",
        state: {
          mode: push ? "push" : "poll",
          consumerRef,
          signature: "v2",
          ...(push ? { hookKey, callbackSecret } : {}),
        },
      }
    },

    /**
     * Daemon-boot re-attach: checks the subscription still exists (404 is the
     * one definite failure — recreate the sentinel) and, for a push
     * subscription, re-points the callback when the public URL changed.
     * TOLERANT of everything else (offline, 5xx, revoked key): the sentinel
     * stays active and `poll` reports the error, rather than every sentinel
     * flipping to `error` because agentpush was briefly unreachable at boot.
     * The mode of an existing subscription is never switched here.
     */
    async attach(handle: SentinelHandle, delivery: DeliveryPreference): Promise<SentinelHandle> {
      if (!handle.remoteId) return { ...handle }
      let sub: Record<string, unknown> | undefined
      try {
        const json = await api("GET", subPath(handle))
        sub = isRecord(json) && isRecord(json.subscription) ? json.subscription : undefined
      } catch (err) {
        if (isHttp(err, 404)) {
          throw new Error(`agentpush subscription ${handle.remoteId} no longer exists — re-create the sentinel`)
        }
        return { ...handle }
      }
      const st = stateOf(handle)
      if (st.mode === "push" && st.hookKey && delivery.mode === "push" && delivery.callbackUrl && sub) {
        const wanted = callbackUrl(delivery.callbackUrl, st.hookKey)
        if (sub.callback_url !== wanted) {
          try {
            await api("PATCH", subPath(handle), { body: { callback_url: wanted } })
          } catch {
            // best-effort; a later boot retries.
          }
        }
      }
      return { ...handle }
    },

    /** Idempotent: a subscription already gone is success. */
    async cancel(handle: SentinelHandle): Promise<void> {
      if (!handle.remoteId) return
      try {
        await api("DELETE", subPath(handle))
      } catch (err) {
        if (!isHttp(err, 404)) throw err
      }
    },

    /**
     * Extend the remote subscription's lifetime. `PATCH` accepts `until`
     * without rejecting an already-expired row, so the returned `status` is
     * checked: anything but `active` (or a 404) means the backing subscription
     * is gone and must be recreated — never silently re-provisioned here.
     */
    async renew(handle: SentinelHandle, until: SentinelUntil): Promise<SentinelHandle> {
      if (!handle.remoteId) throw new SentinelBackingExpiredError("agentpush: handle has no subscription id")
      let json: unknown
      try {
        json = await api("PATCH", subPath(handle), { body: { until } })
      } catch (err) {
        if (isHttp(err, 404)) {
          throw new SentinelBackingExpiredError(`the agentpush subscription ${handle.remoteId} was deleted`, handle.remoteId)
        }
        throw err
      }
      const sub = isRecord(json) && isRecord(json.subscription) ? json.subscription : undefined
      const status = sub && typeof sub.status === "string" ? sub.status : undefined
      if (status === "expired" || status === "deleted") {
        throw new SentinelBackingExpiredError(`the agentpush subscription ${handle.remoteId} is ${status}`, handle.remoteId)
      }
      return { ...handle }
    },

    async status(handle: SentinelHandle): Promise<{ ok: boolean; detail?: string; pending?: number }> {
      try {
        const json = await api("GET", subPath(handle))
        const sub = isRecord(json) && isRecord(json.subscription) ? json.subscription : undefined
        const status = sub && typeof sub.status === "string" ? sub.status : "unknown"
        if (status === "active") return { ok: true }
        return { ok: false, detail: `the agentpush subscription is ${status}` }
      } catch (err) {
        return { ok: false, detail: isHttp(err, 404) ? "the agentpush subscription was deleted" : errMsg(err) }
      }
    },

    async poll(handle: SentinelHandle, limit: number): Promise<SentinelPollResult> {
      const after = handle.cursor ?? "0"
      // Push subscriptions are drained by agentpush's own dispatcher (with
      // retry + dead-lettering); polling them too would race it.
      if (stateOf(handle).mode === "push") return { events: [], cursor: after }

      const json = await api("GET", `${subPath(handle)}/events`, { query: { after, limit: Math.max(1, Math.min(limit, 1000)) } })
      const items = isRecord(json) && Array.isArray(json.items) ? json.items : []
      const events: SentinelEvent[] = []
      const malformed: SentinelMalformedItem[] = []
      let cursor = Number(after)
      if (!Number.isFinite(cursor)) cursor = 0
      for (const item of items) {
        const seq = isRecord(item) && typeof item.seq === "number" ? item.seq : undefined
        if (seq !== undefined && seq > cursor) cursor = seq
        const envelope = isRecord(item) ? item.envelope : undefined
        const event = toSentinelEvent(envelope, seq)
        if (event) {
          events.push(event)
          continue
        }
        // Poison item: surface it so the runtime quarantines it BEFORE the
        // cursor moves past it (a silent skip would lose it on ack).
        let serialized = ""
        try {
          serialized = JSON.stringify(item) ?? ""
        } catch {
          // unserializable — digest stays empty
        }
        const excerpt = excerptOf(envelope)
        malformed.push({
          ...(seq !== undefined ? { seq } : {}),
          ...(isRecord(item) && typeof item.delivery_id === "string" ? { remoteDeliveryId: item.delivery_id } : {}),
          error: isRecord(item) ? whyNotEnvelope(envelope) : "poll item is not a JSON object",
          ...(excerpt ? { excerpt } : {}),
          ...(serialized ? { digest: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized) } : {}),
        })
      }
      return { events, cursor: String(cursor), ...(malformed.length > 0 ? { malformed } : {}) }
    },

    /** Called by the runtime after a polled batch is delivered. Nothing new
     *  (cursor unchanged) is a no-op — no request on an empty tick. */
    async ack(handle: SentinelHandle, cursor: string): Promise<void> {
      if (stateOf(handle).mode === "push") return
      const upToSeq = Number(cursor)
      if (!Number.isInteger(upToSeq) || upToSeq <= 0) return
      if (handle.cursor !== undefined && Number(handle.cursor) >= upToSeq) return
      await api("POST", `${subPath(handle)}/ack`, { body: { upToSeq } })
    },

    parseInbound(req, handle): { ok: true; events: SentinelEvent[] } | { ok: false; reason: string } {
      const st = stateOf(handle)
      if (st.mode !== "push" || !st.callbackSecret) return { ok: false, reason: "unknown_hook" }

      const signature = headerValue(req.headers, "x-agentpush-signature")
      if (!signature || signature.trim() === "") return { ok: false, reason: "missing_signature" }

      if (signature.trim().startsWith("sha256=")) {
        if (st.signature === "v2") return { ok: false, reason: "legacy_signature_rejected" }
        // Legacy header: HMAC of the body alone (no timestamp), kept by
        // agentpush for existing routes until they migrate.
        const legacy = verifyInboundSignature("agentpush", {
          rawBody: req.rawBody,
          headers: req.headers,
          secret: st.callbackSecret,
          nowMs: now().getTime(),
        })
        if (!legacy.ok) return { ok: false, reason: "bad_signature" }
      } else {
        const v2 = verifySignatureV2(st.callbackSecret, req.headers, req.rawBody, now().getTime())
        if (!v2.ok) {
          if (v2.reason === "missing_timestamp" || v2.reason === "missing_signature") return { ok: false, reason: "missing_signature" }
          if (v2.reason === "timestamp_skew") return { ok: false, reason: "stale_timestamp" }
          return { ok: false, reason: "bad_signature" }
        }
      }

      let payload: unknown
      try {
        payload = JSON.parse(req.rawBody)
      } catch {
        return { ok: false, reason: "invalid_json" }
      }
      const event = toSentinelEvent(payload)
      if (!event) return { ok: false, reason: "invalid_envelope" }
      return { ok: true, events: [event] }
    },

    defaultTypes: defaultTypesFor,
  }
}
