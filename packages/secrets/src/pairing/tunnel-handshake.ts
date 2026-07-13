/**
 * @agentproto/secrets/pairing — the `tunnel-e2e/v1` handshake.
 *
 * The reverse tunnel (`agentproto serve --connect <host>`) is a DIFFERENT trust
 * relationship from the client↔daemon pairing in ./handshake.ts:
 *
 *   - There is no offer URL, no QR, no PKI. The daemon and the host already
 *     share one pre-provisioned secret — the `apt_` **tunnel token** the daemon
 *     presents as its WS bearer. Both ends hold it before the socket opens.
 *   - So instead of authenticating with a static-key seal + Ed25519 signature,
 *     both ends authenticate by proving knowledge of that shared token, and get
 *     forward secrecy from a fresh ephemeral X25519 exchange.
 *
 * ```
 *   daemon → host:   offer  = { ePub_d, mac_d = HMAC(K_auth, "offer/v1" ‖ ePub_d) }
 *   host → daemon:   accept = { ePub_h, mac_h = HMAC(K_auth, "accept/v1" ‖ ePub_d ‖ ePub_h) }
 *   both:            K_auth = HKDF(ikm = utf8(token),
 *                             salt = sha256(token), info = "…/auth/v1")   // token-only MAC key
 *                    K      = HKDF(ikm = ECDH(e_d, e_h),
 *                             salt = sha256(token), info = "…/v1")        // → K_d2h ‖ K_h2d
 * ```
 *
 * Why this shape:
 *   - **Mutual authentication at handshake time.** `mac_d` binds the daemon
 *     ephemeral to the token; the host verifies it and refuses (`bad_auth`) if
 *     the token differs — no partial session, no plaintext, before the daemon's
 *     first byte. `mac_h` binds BOTH ephemerals to the token; the daemon
 *     verifies it symmetrically. A man-in-the-middle without the token cannot
 *     forge either MAC for its own ephemeral, and cannot reuse a recorded one
 *     (it lacks the matching private key to finish the ECDH). So the confirm is
 *     a **transcript/confirm step that fails a token mismatch AT handshake time,
 *     not mid-stream** — exactly what a wrong `tunnel.token` on one side needs.
 *   - **Forward secrecy.** The session keys mix ONLY the ephemeral ECDH output;
 *     the long-term token merely salts them. A later token compromise can't
 *     decrypt a recorded past session.
 *   - **Salt-binds the token.** Because `sha256(token)` salts the session-key
 *     HKDF too, even if the MACs were somehow bypassed the derived AEAD keys
 *     still disagree under a mismatched token → the channel fails closed.
 *
 * Like ./handshake.ts, this module is deliberately **transport-agnostic**: it
 * produces and consumes plain byte messages (`encode*`/`decode*`). The code that
 * pumps those bytes over a `FrameSink` and wraps the channel lives in
 * `@agentproto/acp/tunnel`, which never depends on this package — it receives
 * only the two derived symmetric keys. Everything crypto stays here.
 */

import {
  createHash,
  createHmac,
  diffieHellman,
  hkdfSync,
  generateKeyPairSync,
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto"

/** Wire version. Bumped if the message shape or key schedule changes; both
 *  sides refuse a version they don't recognise. */
export const TUNNEL_E2E_VERSION = 1 as const

/** HKDF `info` for the two direction session keys — domain-separates this key
 *  schedule from every other HKDF use in the codebase. */
const SESSION_INFO = "agentproto/tunnel-e2e/v1"
/** HKDF `info` for the token-only MAC key used to authenticate the handshake. */
const AUTH_INFO = "agentproto/tunnel-e2e/auth/v1"
/** Label prefixes bound into each MAC so an offer MAC can never be replayed as
 *  an accept MAC (and vice versa). */
const OFFER_MAC_LABEL = "offer/v1"
const ACCEPT_MAC_LABEL = "accept/v1"

/** Length of each AES-256 direction key (bytes); two of them → 64. */
const KEY_LEN = 32
/** Length of the token-only MAC key (bytes). */
const AUTH_KEY_LEN = 32

/** Stable, machine-readable failure codes. Every rejection maps to one of these
 *  so callers (and tests) branch on a code, not a message string. */
export type TunnelHandshakeErrorCode =
  | "malformed_offer"
  | "malformed_accept"
  | "invalid_key"
  | "bad_auth" // an HMAC did not verify — the two ends hold different tunnel tokens (or a MITM)
  | "unsupported_version"

/** Raised for every tunnel-handshake failure. Never carries key material or the
 *  token; the `code` is the contract, the message is for humans. */
export class TunnelHandshakeError extends Error {
  readonly code: TunnelHandshakeErrorCode
  constructor(code: TunnelHandshakeErrorCode, message: string) {
    super(message)
    this.name = "TunnelHandshakeError"
    this.code = code
  }
}

/** Daemon → host. `ePub` is the daemon ephemeral X25519 public key (base64 SPKI
 *  DER); `mac` authenticates it under the shared tunnel token. */
export interface TunnelOffer {
  v: typeof TUNNEL_E2E_VERSION
  ePub: string
  mac: string
}

/** Host → daemon. `ePub` is the host ephemeral X25519 public key (base64 SPKI
 *  DER); `mac` authenticates both ephemerals under the shared tunnel token. */
export interface TunnelAccept {
  v: typeof TUNNEL_E2E_VERSION
  ePub: string
  mac: string
}

/**
 * A completed tunnel handshake, on either side. `sendKey`/`recvKey` are already
 * role-adjusted (the daemon's `sendKey` is the host's `recvKey`), so the
 * consumer — `wrapE2E` — never has to know which side it is.
 */
export interface TunnelE2ESession {
  /** AES-256-GCM key for frames THIS side sends. 32 bytes. */
  sendKey: Uint8Array
  /** AES-256-GCM key for frames THIS side receives. 32 bytes. */
  recvKey: Uint8Array
  /** `sha256(SESSION_INFO ‖ ePub_d ‖ ePub_h)` — the exact transcript both sides
   *  bound to. Exposed for parity with `PairingSession`; not required to use. */
  transcriptHash: Uint8Array
}

// ─── key + mac helpers ──────────────────────────────────────────

/** Salt shared by both HKDF steps: the SHA-256 of the pre-shared tunnel token.
 *  Binding it here is what authenticates the two ends — a peer without the
 *  token derives a different salt, so both the MAC key and the session keys
 *  disagree and the channel fails closed. */
function tokenSalt(token: string): Buffer {
  return createHash("sha256").update(Buffer.from(token, "utf8")).digest()
}

/** The token-only MAC key. Derived solely from the token (no ephemeral), so
 *  each side can compute it independently before/without the peer's ephemeral. */
function deriveAuthKey(token: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(token, "utf8"), tokenSalt(token), AUTH_INFO, AUTH_KEY_LEN),
  )
}

/** HMAC-SHA256 over `label ‖ <raw parts>` under the token-only auth key. The
 *  parts are the raw DER bytes of the ephemeral public keys, so both sides MAC
 *  identical bytes regardless of any base64 re-encoding. */
function computeMac(authKey: Buffer, label: string, ...parts: Buffer[]): Buffer {
  const h = createHmac("sha256", authKey)
  h.update(Buffer.from(label, "utf8"))
  for (const p of parts) h.update(p)
  return h.digest()
}

/** Constant-time compare of a received MAC (base64) against the expected MAC.
 *  Length-guards first so `timingSafeEqual` never throws on a truncated MAC. */
function macMatches(expected: Buffer, receivedB64: string): boolean {
  let received: Buffer
  try {
    received = Buffer.from(receivedB64, "base64")
  } catch {
    return false
  }
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}

function x25519PublicKey(b64Der: string): KeyObject {
  try {
    return createPublicKey({ key: Buffer.from(b64Der, "base64"), format: "der", type: "spki" })
  } catch {
    throw new TunnelHandshakeError("invalid_key", "peer ephemeral X25519 public key is invalid")
  }
}

/** The transcript hash: `sha256(SESSION_INFO ‖ ePub_d_raw ‖ ePub_h_raw)`. */
function transcriptHash(ePubDRaw: Buffer, ePubHRaw: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from(SESSION_INFO, "utf8"))
    .update(ePubDRaw)
    .update(ePubHRaw)
    .digest()
}

/** Derive the two direction keys from the ephemeral ECDH output, salted by the
 *  token. The key split (d2h then h2d) is identical on both sides. */
function deriveDirectionKeys(
  ecdh: Buffer,
  salt: Buffer,
): { kd2h: Buffer; kh2d: Buffer } {
  const okm = Buffer.from(hkdfSync("sha256", ecdh, salt, SESSION_INFO, KEY_LEN * 2))
  return { kd2h: okm.subarray(0, KEY_LEN), kh2d: okm.subarray(KEY_LEN, KEY_LEN * 2) }
}

/** Generate an ephemeral X25519 keypair and return the private KeyObject plus
 *  its public half as base64 SPKI DER (the wire form) and raw DER bytes (the
 *  MAC/transcript form). */
function generateEphemeral(): { priv: KeyObject; pubB64: string; pubRaw: Buffer } {
  const kp = generateKeyPairSync("x25519")
  const pubRaw = kp.publicKey.export({ type: "spki", format: "der" })
  return { priv: kp.privateKey, pubB64: pubRaw.toString("base64"), pubRaw }
}

// ─── daemon (initiator) side ────────────────────────────────────

/** A started daemon handshake: send `offer`, then feed the host's `accept` to
 *  `complete` to derive the session. */
export interface StartedTunnelHandshake {
  offer: TunnelOffer
  /**
   * Verify the host accept and derive the session. Throws `TunnelHandshakeError`
   * on a bad MAC (`bad_auth` — the host holds a different token), a malformed
   * accept, or an invalid key — never returns partial state.
   */
  complete(accept: TunnelAccept): TunnelE2ESession
}

/**
 * Begin the daemon (initiator) side. Generates the daemon ephemeral keypair,
 * MACs it under the token, and returns the `offer` to send plus a `complete` to
 * run once the host replies with its `accept`.
 */
export function startTunnelHandshake(token: string): StartedTunnelHandshake {
  const authKey = deriveAuthKey(token)
  const salt = tokenSalt(token)
  const eph = generateEphemeral()

  const offer: TunnelOffer = {
    v: TUNNEL_E2E_VERSION,
    ePub: eph.pubB64,
    mac: computeMac(authKey, OFFER_MAC_LABEL, eph.pubRaw).toString("base64"),
  }

  const complete = (accept: TunnelAccept): TunnelE2ESession => {
    if (accept.v !== TUNNEL_E2E_VERSION) {
      throw new TunnelHandshakeError(
        "unsupported_version",
        `unsupported accept version ${String(accept.v)}`,
      )
    }
    const hostPub = x25519PublicKey(accept.ePub)
    const hostPubRaw = Buffer.from(accept.ePub, "base64")

    const expected = computeMac(authKey, ACCEPT_MAC_LABEL, eph.pubRaw, hostPubRaw)
    if (!macMatches(expected, accept.mac)) {
      throw new TunnelHandshakeError(
        "bad_auth",
        "host accept did not authenticate under the shared tunnel token",
      )
    }

    const ecdh = diffieHellman({ privateKey: eph.priv, publicKey: hostPub })
    const { kd2h, kh2d } = deriveDirectionKeys(ecdh, salt)
    return {
      // Daemon SENDS daemon→host (kd2h) and RECEIVES host→daemon (kh2d).
      sendKey: kd2h,
      recvKey: kh2d,
      transcriptHash: transcriptHash(eph.pubRaw, hostPubRaw),
    }
  }

  return { offer, complete }
}

// ─── host (responder) side ──────────────────────────────────────

/** A completed host handshake: send `accept`, keep `session`. */
export interface TunnelHandshakeResult {
  accept: TunnelAccept
  session: TunnelE2ESession
}

/**
 * Respond to a daemon offer (host side). Verifies the offer MAC under the shared
 * token, generates the host ephemeral, MACs both ephemerals, and derives the
 * session. Throws `TunnelHandshakeError` on a bad MAC (`bad_auth`), malformed
 * offer, or invalid key BEFORE producing any accept — so a mismatched token
 * yields no session and no reply, failing closed at handshake time.
 */
export function respondToTunnelHandshake(
  offer: TunnelOffer,
  token: string,
): TunnelHandshakeResult {
  if (offer.v !== TUNNEL_E2E_VERSION) {
    throw new TunnelHandshakeError(
      "unsupported_version",
      `unsupported offer version ${String(offer.v)}`,
    )
  }
  const authKey = deriveAuthKey(token)
  const salt = tokenSalt(token)

  const daemonPub = x25519PublicKey(offer.ePub)
  const daemonPubRaw = Buffer.from(offer.ePub, "base64")

  const expected = computeMac(authKey, OFFER_MAC_LABEL, daemonPubRaw)
  if (!macMatches(expected, offer.mac)) {
    throw new TunnelHandshakeError(
      "bad_auth",
      "daemon offer did not authenticate under the shared tunnel token",
    )
  }

  const eph = generateEphemeral()
  const accept: TunnelAccept = {
    v: TUNNEL_E2E_VERSION,
    ePub: eph.pubB64,
    mac: computeMac(authKey, ACCEPT_MAC_LABEL, daemonPubRaw, eph.pubRaw).toString("base64"),
  }

  const ecdh = diffieHellman({ privateKey: eph.priv, publicKey: daemonPub })
  const { kd2h, kh2d } = deriveDirectionKeys(ecdh, salt)
  return {
    accept,
    session: {
      // Host SENDS host→daemon (kh2d) and RECEIVES daemon→host (kd2h).
      sendKey: kh2d,
      recvKey: kd2h,
      transcriptHash: transcriptHash(daemonPubRaw, eph.pubRaw),
    },
  }
}

// ─── message (de)serialization ──────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

/** Serialize a handshake message to bytes for transport. */
export function encodeTunnelMessage(message: TunnelOffer | TunnelAccept): Uint8Array {
  return Buffer.from(JSON.stringify(message), "utf8")
}

function parseJson(bytes: Uint8Array, code: TunnelHandshakeErrorCode): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new TunnelHandshakeError(code, "message was not valid JSON (truncated or corrupt)")
  }
}

/** Parse + validate a daemon offer from raw bytes. Truncated or malformed input
 *  throws `TunnelHandshakeError("malformed_offer")` — never a partial object. */
export function decodeTunnelOffer(bytes: Uint8Array): TunnelOffer {
  const parsed = parseJson(bytes, "malformed_offer")
  if (
    !isRecord(parsed) ||
    parsed["v"] !== TUNNEL_E2E_VERSION ||
    typeof parsed["ePub"] !== "string" ||
    typeof parsed["mac"] !== "string"
  ) {
    throw new TunnelHandshakeError("malformed_offer", "offer message is malformed")
  }
  return { v: TUNNEL_E2E_VERSION, ePub: parsed["ePub"], mac: parsed["mac"] }
}

/** Parse + validate a host accept from raw bytes. Truncated or malformed input
 *  throws `TunnelHandshakeError("malformed_accept")`. */
export function decodeTunnelAccept(bytes: Uint8Array): TunnelAccept {
  const parsed = parseJson(bytes, "malformed_accept")
  if (
    !isRecord(parsed) ||
    parsed["v"] !== TUNNEL_E2E_VERSION ||
    typeof parsed["ePub"] !== "string" ||
    typeof parsed["mac"] !== "string"
  ) {
    throw new TunnelHandshakeError("malformed_accept", "accept message is malformed")
  }
  return { v: TUNNEL_E2E_VERSION, ePub: parsed["ePub"], mac: parsed["mac"] }
}
