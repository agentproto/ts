/**
 * The `webhook` adapter kind: a signed `POST` of `{ type: "message", message }`
 * to a configured URL. The receiver answers a REACH receipt; a non-2xx
 * answer, a body that is not a valid receipt (`parseReachReceipt`), or no
 * answer within `timeoutMs` (default 5000) is `failed`. `close` posts
 * `{ type: "close", dedupeKey, outcome }` the same way, once, best effort.
 *
 * Signed with `webhook-egress/signing.ts` (Standard Webhooks, `whsec_`). The
 * URL is owner configuration, not model input, and the first receiver is a
 * product on the same machine, so this does not go through the SSRF-guarded
 * egress fetch (it refuses loopback and plain http by design). Redirects are
 * not followed. Neither the URL nor the secret is ever put in a receipt or a
 * log line.
 */

import { randomUUID } from "node:crypto"

import {
  parseReachReceipt,
  type ReachAdapter,
  type ReachCapabilities,
  type ReachReceipt,
  type ReachReceiptBody,
  type ReachWebhookBody,
} from "@agentproto/reach"

import { signWebhook } from "../webhook-egress/signing.js"

export const DEFAULT_REACH_WEBHOOK_TIMEOUT_MS = 5000

export const WEBHOOK_REACH_CAPABILITIES: ReachCapabilities = {
  maxChars: Number.MAX_SAFE_INTEGER,
  actions: 0,
  files: false,
  link: false,
  defers: true,
  retracts: true,
  identity: false,
}

export interface WebhookReachAdapterOptions {
  id: string
  url: string
  secret: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
}

type PostOutcome = { ok: true; status: number; text: string } | { ok: false; reason: string }

export function createWebhookReachAdapter(opts: WebhookReachAdapterOptions): ReachAdapter {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date())
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REACH_WEBHOOK_TIMEOUT_MS

  async function post(body: ReachWebhookBody): Promise<PostOutcome> {
    const payload = new TextEncoder().encode(JSON.stringify(body))
    const headers = signWebhook({
      msgId: `msg_${randomUUID().replace(/-/g, "")}`,
      timestamp: Math.floor(Date.now() / 1000),
      payload,
      secrets: [opts.secret],
    })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<PostOutcome>(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ ok: false, reason: "timeout" })
      }, timeoutMs)
    })
    const exchange = (async (): Promise<PostOutcome> => {
      try {
        const res = await doFetch(opts.url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: payload,
          redirect: "manual",
          signal: controller.signal,
        })
        const text = await res.text().catch(() => "")
        return { ok: true, status: res.status, text }
      } catch {
        return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" }
      }
    })()
    try {
      return await Promise.race([exchange, timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  const receipt = (body: ReachReceiptBody): ReachReceipt =>
    ({ ...body, adapterId: opts.id, at: now().toISOString() }) as ReachReceipt

  return {
    id: opts.id,
    kind: "webhook",
    capabilities: WEBHOOK_REACH_CAPABILITIES,
    async send(message) {
      const out = await post({ type: "message", message })
      if (!out.ok) return receipt({ status: "failed", reason: out.reason })
      if (out.status < 200 || out.status > 299) return receipt({ status: "failed", reason: `http-${out.status}` })
      const parsed = parseReachReceipt(out.text)
      if (!parsed.ok) return receipt({ status: "failed", reason: "malformed-receipt" })
      return receipt(parsed.receipt)
    },
    async close(dedupeKey, outcome) {
      await post({ type: "close", dedupeKey, outcome }).catch(() => undefined)
    },
  }
}
