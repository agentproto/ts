/**
 * Constant-time string equality for comparing a caller-supplied bearer
 * token against the configured secret. `crypto.timingSafeEqual` alone
 * isn't enough here — it throws on mismatched buffer lengths, and a
 * caller can measure that throw (vs. a full compare) to learn the
 * secret's length one guess at a time. HMAC-blinding both inputs to a
 * fixed-size digest first removes the length signal entirely: any two
 * strings, of any length, produce same-length digests to compare.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const key = randomBytes(32)
  const digestA = createHmac("sha256", key).update(a, "utf8").digest()
  const digestB = createHmac("sha256", key).update(b, "utf8").digest()
  return timingSafeEqual(digestA, digestB)
}
