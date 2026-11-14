/**
 * Strict receipt parsing. A receiver's answer is trusted only when it is a
 * well-formed receipt: anything else (an empty body, a bare `{ ok: true }`,
 * an unknown status, a `deferred` without a valid `until`) is refused, so a
 * receiver can never acknowledge by accident.
 *
 * Unknown keys are ignored, not refused: a receiver may add its own fields
 * (a message id, a trace id) without breaking delivery. The returned receipt
 * carries only the known fields, so nothing unknown is ever kept.
 */

import { REACH_RECEIPT_STATUSES, type ReachReceiptBody } from "./types.js"

export type ParseReachReceiptResult = { ok: true; receipt: ReachReceiptBody } | { ok: false; error: string }

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value))
}

/** `body` is the parsed JSON, or the raw text of a response. */
export function parseReachReceipt(body: unknown): ParseReachReceiptResult {
  let value = body
  if (typeof value === "string") {
    if (value.trim() === "") return { ok: false, error: "empty body" }
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return { ok: false, error: "body is not JSON" }
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "receipt must be a JSON object" }
  }
  const r = value as Record<string, unknown>
  if (r.adapterId !== undefined && typeof r.adapterId !== "string") return { ok: false, error: "adapterId must be a string" }
  if (r.at !== undefined && !isIsoDate(r.at)) return { ok: false, error: "at must be an ISO timestamp" }
  const status = r.status
  if (typeof status !== "string" || !(REACH_RECEIPT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "status must be one of " + REACH_RECEIPT_STATUSES.join(", ") }
  }
  switch (status) {
    case "delivered":
    case "deduped":
      if (r.until !== undefined || r.reason !== undefined) return { ok: false, error: `${status} takes no until or reason` }
      return { ok: true, receipt: { status } }
    case "deferred":
      if (!isIsoDate(r.until)) return { ok: false, error: "deferred needs until, an ISO timestamp" }
      if (r.reason !== undefined) return { ok: false, error: "deferred takes no reason" }
      return { ok: true, receipt: { status, until: r.until } }
    default: {
      const s = status as "undelivered" | "failed"
      if (typeof r.reason !== "string" || r.reason.trim() === "") return { ok: false, error: `${s} needs a reason` }
      if (r.until !== undefined) return { ok: false, error: `${s} takes no until` }
      return { ok: true, receipt: { status: s, reason: r.reason } }
    }
  }
}
