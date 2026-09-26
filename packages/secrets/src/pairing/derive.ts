/**
 * Pairing-derived key material (design: DESIGN §3/§4).
 *
 * All derivations are HKDF-SHA256 over secret material the untrusted
 * rendezvous never sees, so it can't reproduce any of them:
 *
 *   - **pair root** `K_pair = HKDF(session, "pair-root")`: the long-term shared
 *     secret persisted by both sides (daemon `pairings.json`, client
 *     `pair-credentials.json`). Everything a reconnect needs derives from it.
 *   - **route / auth split** (pair/v2): every pairing secret — the offer secret
 *     from the offer URL, and the pair root per epoch — yields TWO one-way
 *     outputs under distinct labels:
 *       - a **route token**, the ONLY value that goes on the broker upgrade URL
 *         (`?side=…&t=<route>`). It is an opaque meeting-point name; it
 *         authenticates nothing.
 *       - an **auth token**, sent ONLY inside the sealed hello (opened by the
 *         daemon's X25519 key alone) and checked by the daemon in constant time.
 *     HKDF is one-way, so a broker that logs every route it ever sees still
 *     can't compute an auth token. pair/v1 used a single value for both jobs,
 *     which let the broker pair as a client (offer) or replay a reconnect.
 *
 * Labels (salt ‖ info), all HKDF-SHA256:
 *
 * | output            | IKM                    | salt                        | info                           | len |
 * | ----------------- | ---------------------- | --------------------------- | ------------------------------ | --- |
 * | pair root         | sorted session keys    | transcript hash             | `agentproto/pair-root`         | 32  |
 * | offer route       | UTF-8 of offer secret  | `agentproto/pair-offer`     | `agentproto/rv-route`          | 16  |
 * | offer auth        | UTF-8 of offer secret  | `agentproto/pair-offer`     | `agentproto/rv-auth`           | 32  |
 * | epoch route `e`   | pair root (raw bytes)  | `agentproto/rv-route-salt`  | `agentproto/rv-route` ‖ u64(e) | 16  |
 * | epoch auth `e`    | pair root (raw bytes)  | `agentproto/rv-auth-salt`   | `agentproto/rv-auth` ‖ u64(e)  | 32  |
 *
 * Tokens are base64url: a 16-byte route is 22 chars (the broker's width), a
 * 32-byte auth is 43. The epoch route is byte-identical to pair/v1's epoch
 * token on purpose: a legacy (v1) client still meets the daemon at the same
 * place, so the daemon can tell it to re-pair instead of leaving it to time out.
 * That leaks nothing new — the route was always public to the broker.
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
 * Every derivation is async (WebCrypto HKDF is) and takes an optional trailing
 * `crypto` provider.
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
const RV_ROUTE_INFO = "agentproto/rv-route"
const RV_AUTH_INFO = "agentproto/rv-auth"
/** Fixed salts for the epoch HKDFs — the pair root is the (secret) IKM, the
 *  epoch rides in `info`, so each salt is a constant domain tag. */
const RV_ROUTE_SALT = "agentproto/rv-route-salt"
const RV_AUTH_SALT = "agentproto/rv-auth-salt"
/** Salt for both offer derivations (the offer secret is the IKM). */
const OFFER_SALT = "agentproto/pair-offer"

/** Length of a route token, in bytes (→ 22 base64url chars, the width the
 *  broker has always carried). */
const ROUTE_TOKEN_LEN = 16
/** Length of an auth token, in bytes (→ 43 base64url chars). Never on a URL. */
const AUTH_TOKEN_LEN = 32
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

/** A route token (broker URL only) and its paired auth token (sealed hello
 *  only), both base64url. */
export interface RouteAuthTokens {
  route: string
  auth: string
}

/** 8-byte big-endian epoch appended to an info label, so a bit-flip in the
 *  epoch can never collide two epochs' tokens. */
function epochInfo(label: string, epoch: number): Uint8Array {
  return concatBytes(utf8Encode(label), u64be(epoch))
}

/**
 * Derive the rendezvous ROUTE token for a pairing at a given epoch:
 * `HKDF(pairRoot, salt "agentproto/rv-route-salt", "agentproto/rv-route" ‖ epoch)`.
 * base64url, so it drops straight into a `?t=` upgrade param. This is the only
 * reconnect value the broker sees; it does not authenticate. Deterministic —
 * both sides derive the same token for the same `(pairRoot, epoch)`.
 */
export async function deriveEpochRoutingToken(
  pairRoot: string,
  epoch: number,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  const okm = await crypto.hkdfSha256(
    base64Decode(pairRoot),
    utf8Encode(RV_ROUTE_SALT),
    epochInfo(RV_ROUTE_INFO, epoch),
    ROUTE_TOKEN_LEN,
  )
  return base64UrlEncode(okm)
}

/**
 * Derive the reconnect AUTH token for a pairing at a given epoch:
 * `HKDF(pairRoot, salt "agentproto/rv-auth-salt", "agentproto/rv-auth" ‖ epoch)`.
 * Carried only inside the sealed hello; the daemon compares it in constant
 * time. Never put it on a URL.
 */
export async function deriveEpochAuthToken(
  pairRoot: string,
  epoch: number,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<string> {
  const okm = await crypto.hkdfSha256(
    base64Decode(pairRoot),
    utf8Encode(RV_AUTH_SALT),
    epochInfo(RV_AUTH_INFO, epoch),
    AUTH_TOKEN_LEN,
  )
  return base64UrlEncode(okm)
}

/** Route + auth tokens for a pairing at one epoch. */
export async function deriveEpochTokens(
  pairRoot: string,
  epoch: number,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<RouteAuthTokens> {
  return {
    route: await deriveEpochRoutingToken(pairRoot, epoch, crypto),
    auth: await deriveEpochAuthToken(pairRoot, epoch, crypto),
  }
}

/**
 * Derive the route + auth tokens for a pairing offer from its secret (the
 * offer URL's `s`): the daemon parks on — and the client dials — `route`; the
 * client seals `auth` into its hello. The secret itself never leaves the offer
 * URL.
 */
export async function deriveOfferTokens(
  offerSecret: string,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<RouteAuthTokens> {
  const ikm = utf8Encode(offerSecret)
  const salt = utf8Encode(OFFER_SALT)
  const route = await crypto.hkdfSha256(ikm, salt, utf8Encode(RV_ROUTE_INFO), ROUTE_TOKEN_LEN)
  const auth = await crypto.hkdfSha256(ikm, salt, utf8Encode(RV_AUTH_INFO), AUTH_TOKEN_LEN)
  return { route: base64UrlEncode(route), auth: base64UrlEncode(auth) }
}

/**
 * The route + auth tokens a peer should accept/dial to bridge clock skew
 * around a day boundary: the current epoch and the previous one (design:
 * PLAN "accept current and previous epoch"). The daemon parks on both routes
 * so a client whose clock sits on either side of midnight still finds it; the
 * client likewise tries both when reconnecting.
 */
export async function epochRoutingTokens(
  pairRoot: string,
  now: number = Date.now(),
  crypto: CryptoProvider = webCryptoProvider,
): Promise<({ epoch: number } & RouteAuthTokens)[]> {
  const epoch = currentEpoch(now)
  return [
    { epoch, ...(await deriveEpochTokens(pairRoot, epoch, crypto)) },
    { epoch: epoch - 1, ...(await deriveEpochTokens(pairRoot, epoch - 1, crypto)) },
  ]
}
