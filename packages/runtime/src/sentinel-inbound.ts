/**
 * Push ingress for sentinel providers — the "sentinel" inbound dialect's
 * handler (AIP-60 §5/§9). `http-server.ts` hands a raw `POST
 * /inbound/sentinel-<hookKey>` request here; the `webhook` provider verifies
 * the GitHub HMAC and normalizes the delivery, then each sentinel bound to that
 * hook gets the events through the runtime's normal delivery path
 * (`deliverPushed`: seen-dedup, match, `until`).
 *
 * Kept HTTP-free (status + body out) so it's testable without a server.
 */

import type { Sentinel, SentinelStore } from "./sentinel-store.js"
import type { SentinelEvent, SentinelProviderHandle } from "./sentinel-providers/types.js"
import { WEBHOOK_SLUG } from "./sentinel-providers/webhook.js"

export interface SentinelInboundDeps {
  store: Pick<SentinelStore, "list">
  runtime: {
    deliverPushed(sentinelId: string, events: readonly SentinelEvent[]): Promise<{ delivered: number; failed: boolean }>
  }
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
}

export interface SentinelInboundResult {
  status: number
  body: Record<string, unknown>
}

/** `null` = `hookKey` is not a known sentinel hook (the caller answers a
 *  generic 404 — nothing about hook keys is echoed). */
export async function handleSentinelInbound(
  hookKey: string,
  req: { rawBody: string; headers: Record<string, string | string[] | undefined> },
  deps: SentinelInboundDeps,
): Promise<SentinelInboundResult | null> {
  const provider = await deps.resolveProvider(WEBHOOK_SLUG)
  if (!provider?.parseInbound) return null

  const parsed = provider.parseInbound(req, { provider: WEBHOOK_SLUG, state: { hookKey } })
  if (!parsed.ok) {
    if (parsed.reason === "unknown_hook") return null
    if (parsed.reason === "missing_signature" || parsed.reason === "bad_signature") {
      return { status: 401, body: { error: "bad_signature", reason: parsed.reason } }
    }
    return { status: 400, body: { error: parsed.reason } }
  }
  if (parsed.events.length === 0) return { status: 200, body: { ok: true, action: "ignored", events: 0 } }

  const bound: Sentinel[] = deps.store
    .list()
    .filter(s => s.provider === WEBHOOK_SLUG && s.handle.state?.hookKey === hookKey)

  let delivered = 0
  let failed = false
  for (const sentinel of bound) {
    const result = await deps.runtime.deliverPushed(sentinel.id, parsed.events)
    delivered += result.delivered
    if (result.failed) failed = true
  }
  // 5xx (not 200) so a delivery that threw stays retryable: it was never
  // marked seen, so GitHub's redelivery is delivered rather than swallowed.
  if (failed) return { status: 500, body: { error: "delivery_failed" } }
  return { status: 200, body: { ok: true, events: parsed.events.length, sentinels: bound.length, delivered } }
}
