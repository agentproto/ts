/**
 * Deterministic MCP Events subscription ids (W-C of
 * `.plans/sentinel-mcp-events/PLAN.md`, §3 frozen).
 *
 * The id is a pure function of the subscription IDENTITY — authenticated
 * principal + normalized callback URL + event name + subscription arguments —
 * so the SAME logical subscription always lands on the SAME id. That is what
 * makes `events/subscribe` idempotent (upsert, never duplicate) and lets
 * `events/unsubscribe` recompute the id instead of trusting a caller-supplied
 * one.
 *
 * Hashing input is RFC 8785 (JCS) canonical JSON: recursive key sort by
 * UTF-16 code units, ECMAScript number serialization, Unicode minimization
 * (literal non-ASCII, control chars escaped). The `args` payload is trustless
 * input and nested objects are legal, so a plain `JSON.stringify` (key order
 * dependent) would let `{a:1,b:2}` and `{b:2,a:1}` mint two different
 * subscriptions for one logical watch — exactly the duplicate the doc warns
 * against. The canonical form is a single source of truth shared by subscribe
 * and unsubscribe.
 */

import { createHash } from "node:crypto"

export interface SubscriptionIdentity {
  /** Authenticated principal (`daemon-bearer` or `session:<id>`). */
  principal: string
  /** Callback URL exactly as submitted (identity component; no normalization
   *  beyond what the caller already applied — challenge caching normalizes
   *  separately). */
  callbackUrl: string
  /** Official wire event name, e.g. `github.pull_request.closed`. */
  eventName: string
  /** Subscription arguments (JSON, nested objects legal). */
  args: Record<string, unknown>
}

/**
 * RFC 8785 (JCS) canonical JSON over a JSON-legal value. Throws on values
 * JSON cannot carry (`undefined`, functions, non-finite numbers) rather than
 * silently coercing them — a trustless `args` payload must fail loudly, not
 * hash to a phantom identity.
 *
 * `JSON.stringify` already implements the JCS string and number rules for
 * well-formed JSON: ECMAScript shortest-round-trip number printing (`-0` →
 * `"0"`), control-char escaping, literal non-ASCII (Unicode minimization),
 * and `\uXXXX` for lone surrogates (ES2019 well-formed stringify). Only the
 * recursive object-key sort is added here.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number is not JSON")
      return JSON.stringify(value)
    case "string":
      return JSON.stringify(value)
    case "object":
      break
    default:
      throw new Error(`JCS: unsupported value type "${typeof value}"`)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcs).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  // Default `Array.prototype.sort` orders strings by UTF-16 code unit, which
  // is exactly RFC 8785 §3.2.3's property ordering.
  const keys = Object.keys(obj).sort()
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(obj[key])}`)
  return `{${members.join(",")}}`
}

/** `sub_<hex32>` — sha256 over the JCS canonical identity, first 128 bits. */
export function subscriptionId(identity: SubscriptionIdentity): `sub_${string}` {
  const canonical = canonicalizeJcs({
    principal: identity.principal,
    callbackUrl: identity.callbackUrl,
    eventName: identity.eventName,
    args: identity.args,
  })
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex")
  return `sub_${digest.slice(0, 32)}`
}
