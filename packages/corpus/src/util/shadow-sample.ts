/**
 * Deterministic shadow-traffic sampling.
 *
 * A stable token (e.g. a conversation id) is hashed with a per-arm salt
 * into a 0..1 bucket, so the SAME token always lands the same arm — an
 * eval batch partitioned by that token is reproducible, and a shadow
 * layer rolls out to a fixed fraction of traffic rather than flickering
 * per request.
 *
 * Used by both the playbook overlay resolver and the knowledge-stack
 * resolver so % rollout behaves identically across the two.
 */

import { createHash } from "node:crypto"

export const DEFAULT_SHADOW_TRAFFIC_PCT = 0.1

/** Deterministic bucket in [0, 1) from a token + salt. */
export function deterministicBucket(token: string, salt: string): number {
  const h = createHash("sha256").update(`${token}|${salt}`).digest()
  // First 4 bytes as a uint32 → [0, 1).
  return h.readUInt32BE(0) / 0x1_0000_0000
}

/**
 * True iff this token is sampled into a shadow arm of width `pct`. No
 * token (e.g. a one-shot tool call) → never sampled: shadow arms only
 * fire on traffic with stable identity.
 */
export function sampleShadow(
  token: string | undefined,
  salt: string,
  pct: number = DEFAULT_SHADOW_TRAFFIC_PCT
): boolean {
  if (!token) return false
  if (pct <= 0) return false
  if (pct >= 1) return true
  return deterministicBucket(token, salt) < pct
}
