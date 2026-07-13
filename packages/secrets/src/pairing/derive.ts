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
 * This uses the shipped P1 `PairingSession` verbatim (no change to the key
 * schedule) — it only reads the two direction keys and the transcript hash.
 */

import { hkdfSync } from "node:crypto"
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

function toBuf(u8: Uint8Array): Buffer {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8)
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Derive the long-term pair root from a completed handshake session. Returns
 * standard base64 (persisted in `pairings.json` / `credentials.json`). Both
 * peers, despite role-swapped direction keys, produce the identical root.
 */
export function derivePairRoot(session: PairingSession): string {
  const k1 = toBuf(session.sendKey)
  const k2 = toBuf(session.recvKey)
  // Order-independent: sort the two keys so client and daemon mix them the same
  // way regardless of which is "send" for them.
  const [lo, hi] = Buffer.compare(k1, k2) <= 0 ? [k1, k2] : [k2, k1]
  const ikm = Buffer.concat([lo, hi])
  const okm = hkdfSync("sha256", ikm, toBuf(session.transcriptHash), PAIR_ROOT_INFO, PAIR_ROOT_LEN)
  return Buffer.from(okm).toString("base64")
}

/** The current pairing epoch — the UTC day number. Injectable `now` (ms) for
 *  tests; defaults to the wall clock. */
export function currentEpoch(now: number = Date.now()): number {
  return Math.floor(now / MS_PER_DAY)
}

/**
 * Derive the rendezvous routing token for a pairing at a given epoch:
 * `t' = HKDF(pairRoot, "rv-route" ‖ epoch)`. Returned as base64url so it drops
 * straight into a `?t=` upgrade param. Deterministic — both sides derive the
 * same token for the same `(pairRoot, epoch)`.
 */
export function deriveEpochRoutingToken(pairRoot: string, epoch: number): string {
  const ikm = Buffer.from(pairRoot, "base64")
  // 8-byte big-endian epoch appended to the info prefix, so a bit-flip in the
  // epoch can never collide two epochs' tokens.
  const epochBytes = Buffer.alloc(8)
  epochBytes.writeBigUInt64BE(BigInt(epoch))
  const info = Buffer.concat([Buffer.from(RV_ROUTE_INFO_PREFIX, "utf8"), epochBytes])
  const okm = hkdfSync("sha256", ikm, Buffer.from(RV_ROUTE_SALT, "utf8"), info, ROUTE_TOKEN_LEN)
  return b64url(Buffer.from(okm))
}

/**
 * The set of epoch routing tokens a peer should accept/dial to bridge clock
 * skew around a day boundary: the current epoch and the previous one (design:
 * PLAN "accept current and previous epoch"). The daemon parks on both so a
 * client whose clock sits on either side of midnight still finds it; the client
 * likewise tries both when reconnecting.
 */
export function epochRoutingTokens(
  pairRoot: string,
  now: number = Date.now(),
): { epoch: number; token: string }[] {
  const epoch = currentEpoch(now)
  return [
    { epoch, token: deriveEpochRoutingToken(pairRoot, epoch) },
    { epoch: epoch - 1, token: deriveEpochRoutingToken(pairRoot, epoch - 1) },
  ]
}
