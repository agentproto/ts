import { createHmac } from "node:crypto"

/**
 * agentgovernance/v1 hash-chain — compute primitives.
 *
 * Canonical-bytes serialization (deterministic JSON):
 *   - Object keys sorted lexicographically (codepoint order)
 *   - Numbers: JSON.stringify representation (matches ECMAScript ToString for finite numbers)
 *   - Strings: JSON.stringify (RFC 8259 string escaping)
 *   - Arrays: in-order
 *   - `undefined` values removed (treated as absent)
 *   - No whitespace, UTF-8
 *
 * This is a strict subset of RFC 8785 (JCS). For alpha compatibility, agents
 * SHOULD avoid number values that round-trip differently in JSON (very large
 * integers above 2^53, NaN, ±Infinity, exponent edge cases). The protocol doc
 * specifies the exact rules; verifiers in other languages can be implemented
 * by following protocol.md.
 *
 * Hash chain:
 *   signature_n = HMAC-SHA256(
 *     key = secret_bytes,
 *     data = prev_signature_hex_utf8 ‖ canonical_bytes(row_n_minus_signature)
 *   )
 *
 * The very first line uses the workspace genesis seed as prev_signature.
 */

const TEXT_ENCODER = new TextEncoder()

/**
 * Canonicalize a row to deterministic UTF-8 bytes.
 *
 * Sorts object keys, drops `undefined` values, and emits whitespace-free JSON.
 */
export function canonicalize(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(canonicalJsonString(value))
}

/** Internal: canonical JSON string. */
export function canonicalJsonString(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) {
    throw new Error(
      "canonicalJsonString: top-level undefined is not representable"
    )
  }
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `canonicalJsonString: non-finite number ${value} is not JSON-representable`
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonString).join(",") + "]"
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return (
      "{" +
      entries
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJsonString(v))
        .join(",") +
      "}"
    )
  }
  throw new Error(`canonicalJsonString: unsupported value type ${typeof value}`)
}

export interface ChainComputeOptions {
  /** Workspace genesis seed (hex) — used as prev_signature for the first line. */
  genesisSeed: string
  /** HMAC secret key (utf-8 string or hex). */
  secret: string
}

export interface ComputedChainSignature {
  /** Hex-encoded HMAC-SHA256. */
  signature: string
  /** Hex-encoded prevSignature carried into this row. */
  prevSignature: string
}

/**
 * Compute the chain signature for a row given the previous signature.
 *
 * @param row - The audit-event row (the `signature` field, if present, is excluded from the canonical bytes).
 * @param prevSignature - The previous line's signature (or the workspace genesis seed for the first line). Hex-encoded.
 * @param secret - HMAC secret (passed verbatim as the HMAC key).
 * @returns Hex-encoded SHA-256 HMAC.
 */
export function computeChainSignature(
  row: Record<string, unknown>,
  prevSignature: string,
  secret: string
): string {
  if (!isHex64(prevSignature)) {
    throw new Error(
      "computeChainSignature: prevSignature must be 64-char lowercase hex"
    )
  }
  // Strip the `signature` field from the row to break the circularity:
  // we hash everything *except* the signature itself.
  const { signature: _omit, ...rowWithoutSignature } = row
  const canonical = canonicalize(rowWithoutSignature)
  const hmac = createHmac("sha256", secret)
  // Feed prev_signature hex as UTF-8 bytes (per protocol.md), then canonical row bytes.
  hmac.update(prevSignature, "utf8")
  hmac.update(canonical)
  return hmac.digest("hex")
}

/**
 * Compute the signature and produce a ready-to-write row with `prevSignature` and `signature` populated.
 */
export function chainRow(
  rowWithoutChainFields: Record<string, unknown>,
  prevSignature: string,
  secret: string
): Record<string, unknown> & { prevSignature: string; signature: string } {
  const withPrev = { ...rowWithoutChainFields, prevSignature }
  const signature = computeChainSignature(withPrev, prevSignature, secret)
  return { ...withPrev, signature }
}

function isHex64(s: string): boolean {
  return /^[a-f0-9]{64}$/.test(s)
}
