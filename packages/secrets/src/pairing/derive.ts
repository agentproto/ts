/**
 * Pairing-derived key material (design: DESIGN §3/§4).
 *
 * Two derivations, both HKDF-SHA256 over secret session material so the
 * untrusted rendezvous — which sees the handshake transcript in the clear —
 * can never reproduce them:
 *
 *   - **pair root** `K_pair = HKDF(session, "pair-root")`: the long-term shared
 *     secret persisted by both sides (daemon `pairings.json`, client
 *     `credentials.json`). Everything a reconnect needs derives from it.
 *   - **epoch routing token** `t' = HKDF(K_pair, "rv-route" ‖ epoch)`: the
 *     rendezvous routing token for a reconnect, rotated per UTC day so the
 *     broker can't link a pairing's sessions across days. Both sides derive the
 *     same token for the same epoch without any further communication.
 *
 * ## Why the pair root is derived order-independently
 *
 * A `PairingSession` exposes `sendKey`/`recvKey`, which are **role-swapped**
 * between the two peers (the client's `sendKey` is the daemon's `recvKey`). To
 * get an identical root on both sides without threading a "which side am I"
 * flag, we sort the two keys byte-wise before mixing them: the *set* {sendKey,
 * recvKey} is identical on both sides, so the sorted concatenation — and thus
 * the HKDF output — is identical. Both keys are secret ECDH-derived material the
 * rendezvous never sees, so the root (and every epoch token) stays secret.
 *
 * Both derivations are async (WebCrypto HKDF is) and take an optional trailing
 * `crypto` provider.
 *
 * This uses the shipped P1 `PairingSession` verbatim (no change to the key
 * schedule) — it only reads the two direction keys and the transcript hash.
 */

import {
  base64Decode,
  base64Encode,
  base64UrlEncode,
  compareBytes,
  concatBytes,
  u64be,
  utf8Encode,
} from "../crypto/bytes.js"
import type { CryptoProvider } from "../crypto/types.js"
import { webCryptoProvider } from "../crypto/webcrypto.js"
import type { PairingSession } from "./handshake.js"

const PAIR_ROOT_INFO = "agentproto/pair-root"
const RV_ROUTE_INFO_PREFIX = "agentproto/rv-route"
/** Fixed salt for the epoch-token HKDF — the pair root is the (secret) IKM,
 *  the epoch rides in `info`, so the salt is a constant domain tag. */
const RV_ROUTE_SALT = "agentproto/rv-route-salt"

/** Length of a derived epoch routing token, in bytes (→ 22 base64url chars,
 *  same width as a 16-byte offer token). */
const ROUTE_TOKEN_LEN = 16
/** Length of the pair root, in bytes. */
const PAIR_ROOT_LEN = 32

const MS_PER_DAY = 86_400_000

/**
 * Derive the long-term pair root from a completed handshake session. Returns
 * standard base64 (persisted in `pairings.json` / `credentials.json`). Both
 * peers, despite role-swapped direction keys, produce the identical root.
 */
export async function derivePairRoot(
  session: Pick<PairingSession, "sendKey" | "recvKey" | "transcriptHash">,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  const k1 = session.sendKey
  const k2 = session.recvKey
  // Order-independent: sort the two keys so client and daemon mix them the same
  // way regardless of which is "send" for them.
  const [lo, hi] = compareBytes(k1, k2) <= 0 ? [k1, k2] : [k2, k1]
  const ikm = concatBytes(lo, hi)
  const okm = await crypto.hkdfSha256(ikm, session.transcriptHash, utf8Encode(PAIR_ROOT_INFO), PAIR_ROOT_LEN)
  return base64Encode(okm)
}

/** The current pairing epoch — the UTC day number. Injectable `now` (ms) for
 *  tests; defaults to the wall clock. */
export function currentEpoch(now: number = Date.now()): number {
  return Math.floor(now / MS_PER_DAY)
}

/**
 * Import a base64 pair root as a **non-extractable** WebCrypto HKDF key.
 *
 * A browser client can persist that `CryptoKey` (e.g. in IndexedDB, which
 * structured-clones it) instead of the raw secret: script can then derive epoch
 * routing tokens with it but never read the root back out. The derivation is
 * unchanged — `deriveEpochRoutingToken` accepts either form and yields the same
 * token for the same root.
 */
export async function importPairRootKey(pairRoot: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(base64Decode(pairRoot)),
    "HKDF",
    false,
    ["deriveBits"],
  )
}

/** The per-epoch HKDF salt + info (shared by both pair-root forms). */
function routeParams(epoch: number): { salt: Uint8Array; info: Uint8Array } {
  // 8-byte big-endian epoch appended to the info prefix, so a bit-flip in the
  // epoch can never collide two epochs' tokens.
  return {
    salt: utf8Encode(RV_ROUTE_SALT),
    info: concatBytes(utf8Encode(RV_ROUTE_INFO_PREFIX), u64be(epoch)),
  }
}

/**
 * Derive the rendezvous routing token for a pairing at a given epoch:
 * `t' = HKDF(pairRoot, "rv-route" ‖ epoch)`. Returned as base64url so it drops
 * straight into a `?t=` upgrade param. Deterministic — both sides derive the
 * same token for the same `(pairRoot, epoch)`.
 *
 * `pairRoot` is the base64 root, or an HKDF `CryptoKey` from
 * `importPairRootKey` — the latter always derives through WebCrypto, since a
 * `CryptoKey` only exists there (`crypto` is then unused).
 */
export async function deriveEpochRoutingToken(
  pairRoot: string | CryptoKey,
  epoch: number,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  const { salt, info } = routeParams(epoch)
  if (typeof pairRoot !== "string") {
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: Uint8Array.from(salt), info: Uint8Array.from(info) },
      pairRoot,
      ROUTE_TOKEN_LEN * 8,
    )
    return base64UrlEncode(new Uint8Array(bits))
  }
  const okm = await crypto.hkdfSha256(base64Decode(pairRoot), salt, info, ROUTE_TOKEN_LEN)
  return base64UrlEncode(okm)
}

/**
 * The set of epoch routing tokens a peer should accept/dial to bridge clock
 * skew around a day boundary: the current epoch and the previous one (design:
 * PLAN "accept current and previous epoch"). The daemon parks on both so a
 * client whose clock sits on either side of midnight still finds it; the client
 * likewise tries both when reconnecting.
 */
export async function epochRoutingTokens(
  pairRoot: string | CryptoKey,
  now: number = Date.now(),
  crypto: CryptoProvider = webCryptoProvider,
): Promise<{ epoch: number; token: string }[]> {
  const epoch = currentEpoch(now)
  return [
    { epoch, token: await deriveEpochRoutingToken(pairRoot, epoch, crypto) },
    { epoch: epoch - 1, token: await deriveEpochRoutingToken(pairRoot, epoch - 1, crypto) },
  ]
}
