/**
 * A conformance check any REACH webhook receiver can run in its own tests.
 *
 * Given the receiver's handler `(req: Request) => Promise<Response>` and the
 * `whsec_` secret it verifies with, it checks that:
 *
 * 1. a signed message gets a 2xx answer whose body is a valid receipt;
 * 2. the same `dedupeKey` sent twice gets `deduped`, or the same receipt;
 * 3. an answer that is not a receipt (a bare 200, an empty body, `{ ok: true }`)
 *    fails: acknowledging is a receipt, never a status code.
 *
 * Uses the Web `Request`, `Response` and `crypto.subtle` globals only. The
 * signature follows Standard Webhooks, the way the host signs: HMAC-SHA256
 * over `<webhook-id>.<webhook-timestamp>.<body>` keyed by the base64 payload
 * of the `whsec_` secret, sent as `webhook-signature: v1,<base64>`.
 */

import { parseReachReceipt } from "./receipt.js"
import type { ReachMessage, ReachReceiptBody, ReachWebhookBody } from "./types.js"

const WHSEC_PREFIX = "whsec_"

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** `v1,<base64>` for one body, the Standard Webhooks way. */
export async function signReachBody(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  if (!secret.startsWith(WHSEC_PREFIX)) throw new Error("reach: the secret must start with whsec_")
  const raw = base64ToBytes(secret.slice(WHSEC_PREFIX.length))
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  return `v1,${bytesToBase64(new Uint8Array(mac))}`
}

/** A signed `POST` carrying one REACH webhook body, as the host sends it. */
export async function buildSignedReachRequest(
  url: string,
  secret: string,
  body: ReachWebhookBody,
  opts: { id?: string; timestamp?: number } = {},
): Promise<Request> {
  const text = JSON.stringify(body)
  const id = opts.id ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": await signReachBody(secret, id, timestamp, text),
    },
    body: text,
  })
}

export interface ReachConformanceCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface ReachConformanceResult {
  ok: boolean
  checks: ReachConformanceCheck[]
}

export interface ReachConformanceOptions {
  secret: string
  /** Default `https://receiver.invalid/reach`. Only the handler sees it. */
  url?: string
  /** Default: an `ask` from a `conformance` source. The `dedupeKey` is
   *  replaced by a fresh one each run. */
  message?: ReachMessage
}

type Answer = { ok: true; receipt: ReachReceiptBody } | { ok: false; detail: string }

async function post(
  handler: (req: Request) => Promise<Response>,
  url: string,
  secret: string,
  message: ReachMessage,
): Promise<Answer> {
  let res: Response
  try {
    res = await handler(await buildSignedReachRequest(url, secret, { type: "message", message }))
  } catch (err) {
    return { ok: false, detail: `the handler threw: ${err instanceof Error ? err.message : String(err)}` }
  }
  const text = await res.text().catch(() => "")
  if (res.status < 200 || res.status > 299) return { ok: false, detail: `HTTP ${res.status}` }
  const parsed = parseReachReceipt(text)
  if (!parsed.ok) return { ok: false, detail: `HTTP ${res.status} without a valid receipt: ${parsed.error}` }
  return { ok: true, receipt: parsed.receipt }
}

export async function runReachConformance(
  handler: (req: Request) => Promise<Response>,
  opts: ReachConformanceOptions,
): Promise<ReachConformanceResult> {
  const url = opts.url ?? "https://receiver.invalid/reach"
  const dedupeKey = `reach-conformance:${crypto.randomUUID()}`
  const message: ReachMessage = {
    ...(opts.message ?? {
      summary: "REACH conformance check",
      intent: "ask",
      to: "owner",
      urgency: "normal",
      source: { kind: "conformance" },
      ask: { ref: "conformance", options: ["approve", "deny"] },
      dedupeKey,
    }),
    dedupeKey,
  }
  const checks: ReachConformanceCheck[] = []

  const first = await post(handler, url, opts.secret, message)
  checks.push(
    first.ok
      ? { name: "a signed message gets a valid receipt", ok: true, detail: first.receipt.status }
      : { name: "a signed message gets a valid receipt", ok: false, detail: first.detail },
  )

  const second = await post(handler, url, opts.secret, message)
  const name = "the same dedupeKey twice gets deduped or the same receipt"
  if (!second.ok) {
    checks.push({ name, ok: false, detail: second.detail })
  } else if (second.receipt.status === "deduped" || (first.ok && first.receipt.status === second.receipt.status)) {
    checks.push({ name, ok: true, detail: second.receipt.status })
  } else {
    checks.push({ name, ok: false, detail: `first ${first.ok ? first.receipt.status : "invalid"}, then ${second.receipt.status}` })
  }

  return { ok: checks.every(c => c.ok), checks }
}
