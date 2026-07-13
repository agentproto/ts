/**
 * Constant-time string equality for comparing rendezvous routing tokens.
 *
 * The token a client presents on the upgrade URL is the routing key AND the
 * first-contact proof (design DESIGN §2/§3). Comparing it against the token the
 * parked counterpart presented with a plain `===` leaks, via timing, how many
 * leading bytes matched — a byte-at-a-time oracle a malicious counterpart could
 * ride to guess another pairing's token. `crypto.timingSafeEqual` alone isn't
 * enough: it throws on length mismatch, and a caller can measure that throw (vs.
 * a full compare) to learn the token's length. HMAC-blinding both inputs to a
 * fixed-size digest first removes the length signal entirely — any two strings
 * of any length produce same-length digests to compare.
 *
 * Copied (pattern, not dependency) from `@agentproto/relay/timing-safe` so the
 * broker package stays dependency-light and self-contained.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const key = randomBytes(32)
  const digestA = createHmac("sha256", key).update(a, "utf8").digest()
  const digestB = createHmac("sha256", key).update(b, "utf8").digest()
  return timingSafeEqual(digestA, digestB)
}
