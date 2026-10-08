/**
 * Signed event delivery with bounded retry (W-A of
 * `.plans/sentinel-mcp-events/PLAN.md`, §3 frozen).
 *
 * I2 — the body is serialized ONCE: the clamp (when needed) happens first,
 * then the exact bytes are signed per attempt with a FRESH timestamp. An
 * observer sees a different `webhook-signature` header per attempt while the
 * body bytes stay bitwise identical — `signWebhook` returns ONLY headers and
 * never re-serializes.
 *
 * ≤ 256 KiB — when the serialized body exceeds 262 144 bytes, `data` is
 * replaced with `{summary, subject}` and the envelope gains `truncated: true`
 * (no read tool — plan §5), and the CLAMPED bytes (not the original) are what
 * every attempt signs.
 *
 * Retry — exponential backoff bounded to 5 attempts; 3xx / other 4xx / 5xx /
 * network errors retry; 410/413 are terminal with NO further attempt;
 * 2xx = delivered. The returned `DeliveryState` is what the caller persists
 * into the store for post-restart resume (W-B's job to wire).
 */

import { signWebhook } from "./signing.js"
import { ssrfFetch } from "./ssrf-fetch.js"

export type McpEventEnvelope = {
  /** OpenAI doc wire shape VERBATIM (developers.openai.com/plugins/build/mcp-events):
   *  `eventId` (NOT `id` — the `webhook-id` header carries eventId), `name`,
   *  `timestamp`, `data`, `cursor`. A top-level `type` field = protocol
   *  control notification only — never sent by us (no control events). */
  eventId: string
  name: string
  timestamp: string
  data: Record<string, unknown>
  cursor: string | null
  truncated?: boolean // set only when true (256 KiB clamp extension)
}

export interface DeliveryState {
  attempts: number
  lastError?: string
  lastAt?: string
}

export interface DeliveryReplay {
  subId: string
  callbackUrl: string
  secrets: readonly string[]
}

/** One event → one POST. Frozen §3 outcome. */
export type DeliveryOutcome =
  | { ok: true; delivery: DeliveryState }
  | { ok: false; reason: string; delivery: DeliveryState }

export interface SsrfFetchArgs {
  method?: "POST"
  headers?: Record<string, string>
  body?: Uint8Array
  timeoutMs: number
}

export interface DeliverEventDeps {
  /** Replaces the POST boundary (tests only). Default: the shared `ssrfFetch` gate. */
  fetch?: (url: string, init: SsrfFetchArgs) => Promise<{ status: number; body: string }>
  /** Backoff sleep (tests only). Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Clock (tests only). Default: real wall clock. */
  now?: () => number
}

export const CLAMP_LIMIT_BYTES = 262_144
export const MAX_ATTEMPTS = 5
const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 4_000

/** Bounded exponential backoff: 250, 500, 1000, 2000, capped at 4000 (attempt ≥ 4). */
export function deliveryBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
}

/** 410 (Gone) / 413 (Payload Too Large) are terminal — never retried. */
const TERMINAL_NO_RETRY_STATUSES = new Set([410, 413])

export function serializeEnvelope(envelope: McpEventEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope))
}

/** Serialize once; over-size → `{summary, subject}` + `truncated:true` (§3). */
export function envelopeClampedBytes(event: McpEventEnvelope): { bytes: Uint8Array; clamped: boolean } {
  let bytes = serializeEnvelope(event)
  if (bytes.byteLength <= CLAMP_LIMIT_BYTES) return { bytes, clamped: false }
  const data = event.data as { subject?: unknown } | null
  const clampedEvent: McpEventEnvelope = {
    ...event,
    data: {
      summary: `Payload exceeded the ${CLAMP_LIMIT_BYTES}-byte wire clamp and was truncated`,
      subject: data && typeof data === "object" && "subject" in data ? (data.subject as unknown) : null,
    },
    truncated: true,
  }
  bytes = serializeEnvelope(clampedEvent)
  return { bytes, clamped: true }
}

export async function deliverEventEnvelope(
  replay: DeliveryReplay,
  event: McpEventEnvelope,
  deps: DeliverEventDeps = {},
): Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetcher =
    deps.fetch ??
    ((url: string, init: SsrfFetchArgs) => ssrfFetch(url, init))

  // Serialize ONCE (I2) — clamp BEFORE any signature; the loop keeps THESE bytes.
  const { bytes: payloadBytes } = envelopeClampedBytes(event)

  const delivery: DeliveryState = { attempts: 0 }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(deliveryBackoffDelay(attempt))
    delivery.attempts += 1
    delivery.lastAt = new Date(now()).toISOString()
    const timestamp = Math.floor(now() / 1000) // fresh seconds per attempt
    let signed: HeadersInput
    try {
      signed = signWebhook({ msgId: event.eventId, timestamp, payload: payloadBytes, secrets: replay.secrets })
    } catch (err) {
      delivery.lastError = `signing failed: ${(err as Error).message}`
      return { ok: false, reason: "invalid_secret", delivery }
    }
    let response: { status: number; body: string }
    try {
      response = await fetcher(replay.callbackUrl, {
        method: "POST",
        headers: { ...signed, "content-type": "application/json", "X-MCP-Subscription-Id": replay.subId },
        body: payloadBytes,
        timeoutMs: 15_000, // delivery default (challenge uses 10_000)
      })
    } catch (err) {
      delivery.lastError = err instanceof Error ? err.message : String(err)
      if (attempt < MAX_ATTEMPTS - 1) continue
      return { ok: false, reason: "network", delivery }
    }
    if (response.status >= 200 && response.status <= 299) {
      return { ok: true, delivery }
    }
    if (TERMINAL_NO_RETRY_STATUSES.has(response.status)) {
      delivery.lastError = `terminal status ${response.status}`
      return { ok: false, reason: `http_${response.status}`, delivery }
    }
    delivery.lastError = `retryable status ${response.status}` // 3xx/other 4xx/5xx → next attempt
  }
  return { ok: false, reason: "retries_exhausted", delivery }
}

type HeadersInput = { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string }
