/**
 * @agentproto/secrets/pairing — the `pair/v1` session handshake
 * (design: DESIGN §4).
 *
 * A Noise-flavoured, two-message handshake that lets a client and a daemon —
 * connected only through an untrusted rendezvous that byte-splices their
 * sockets — derive per-direction AEAD keys such that the rendezvous can neither
 * read nor forge the session:
 *
 * ```
 *   client → daemon:  e_pub                       // ephemeral X25519
 *                     ct₀ = Seal(to = daemon_x25519,
 *                            {clientPub: e_pub, clientName, offerToken})
 *   daemon → client:  d_e_pub, sig = Ed25519(daemon_ed25519,
 *                            transcript = sha256(e_pub ‖ ct₀ ‖ d_e_pub))
 *   both:             K  = HKDF-SHA256(ECDH(e, d_e) ‖ ECDH(e, daemon_x25519),
 *                            salt = transcript, info = "agentproto/pair/v1")
 *                     → K_c2d ‖ K_d2c  (two AES-256-GCM keys)
 * ```
 *
 * Why this shape:
 *   - The client learned the daemon's static public keys out-of-band (the offer
 *     URL / QR). Verifying `sig` against the offer's Ed25519 key proves the peer
 *     is the daemon the human scanned, not a rendezvous impersonating it — MITM
 *     protection without a CA.
 *   - The daemon proves the client is authorised by opening `ct₀` (only the
 *     daemon's X25519 private key can) and checking the one-time `offerToken`.
 *   - `sig` covers the whole transcript and the transcript salts the key
 *     schedule, so any tampering with `e_pub`, `ct₀`, or `d_e_pub` in flight
 *     makes either the signature or the derived keys disagree — the session
 *     fails closed, never continuing with attacker-chosen material.
 *
 * The primitives come from a `CryptoProvider` (node:crypto or WebCrypto), so this
 * one implementation runs in Node and in a browser; every entry point that does
 * crypto is async and takes an optional trailing `crypto` argument.
 *
 * This module is deliberately **transport-agnostic**: it produces and consumes
 * plain messages (`encode*`/`decode*` give byte arrays). The code that pumps
 * those bytes over a `FrameSink` lives in `@agentproto/acp/tunnel`, which stays
 * free of any dependency on this package — it receives only the derived keys.
 * All crypto stays here so the acp layer never touches key material beyond the
 * two symmetric session keys.
 */

import {
  base64Decode,
  base64Encode,
  concatBytes,
  utf8Decode,
  utf8Encode,
} from "../crypto/bytes.js"
import type { CryptoProvider } from "../crypto/types.js"
import { webCryptoProvider } from "../crypto/webcrypto.js"
import { seal, unseal, SealError } from "../seal/core.js"
import {
  identityFingerprint,
  signTranscript,
  verifyTranscript,
  type DaemonIdentity,
} from "../identity/core.js"

/** Wire version of the handshake. Bumped if the message shape or key schedule
 *  changes; both sides refuse a version they don't recognise. */
export const PAIR_VERSION = 1 as const

/** HKDF `info` — domain-separates this key schedule from every other HKDF use
 *  in the codebase (seal boxes, future rendezvous-token derivation). */
const HKDF_INFO = utf8Encode("agentproto/pair/v1")

/** Length of each direction key: AES-256 → 32 bytes, two of them → 64. */
const KEY_LEN = 32

/** Stable, machine-readable failure codes. Every rejection maps to one of
 *  these so callers (and tests) branch on a code, not a message string. */
export type PairingErrorCode =
  | "malformed_hello"
  | "malformed_reply"
  | "invalid_key"
  | "unseal_failed"
  | "ephemeral_mismatch"
  | "offer_rejected"
  | "bad_signature"
  // P2: offer-URL codec (offer-url.ts) rejection vectors.
  | "malformed_offer"
  | "offer_expired"

/** Raised for every handshake failure. Never carries key material or
 *  plaintext; the `code` is the contract, the message is for humans. */
export class PairingError extends Error {
  readonly code: PairingErrorCode
  constructor(code: PairingErrorCode, message: string) {
    super(message)
    this.name = "PairingError"
    this.code = code
  }
}

/** Client → daemon. `ePub` is the client ephemeral X25519 public key (base64
 *  SPKI DER); `ct0` is the sealed hello payload (a `seal()` envelope string). */
export interface PairingHello {
  v: typeof PAIR_VERSION
  ePub: string
  ct0: string
}

/** Daemon → client. `dePub` is the daemon ephemeral X25519 public key (base64
 *  SPKI DER); `sig` is the Ed25519 transcript signature (base64). */
export interface PairingReply {
  v: typeof PAIR_VERSION
  dePub: string
  sig: string
}

/** The sealed hello payload, opened only by the daemon. */
interface HelloPayload {
  /** Echo of the client ephemeral public key — bound inside the seal so a
   *  rendezvous can't swap `ePub` without breaking the seal. */
  clientPub: string
  /** Human-facing client label the daemon shows on `pair accept`. */
  clientName: string
  /** One-time offer token from the offer URL — the daemon's proof the client
   *  holds a fresh, unspent offer. */
  offerToken: string
}

/**
 * The result of a completed handshake, on either side. `sendKey`/`recvKey` are
 * already role-adjusted (a client's `sendKey` is a daemon's `recvKey`), so the
 * consumer — `wrapE2E` — never has to know which side it is.
 */
export interface PairingSession {
  /** AES-256-GCM key for frames THIS side sends. 32 bytes. */
  sendKey: Uint8Array
  /** AES-256-GCM key for frames THIS side receives. 32 bytes. */
  recvKey: Uint8Array
  /** Fingerprint of the peer's static identity (the daemon's X25519 key on the
   *  client side; in P1, the client's ephemeral key on the daemon side, since
   *  clients have no persisted identity until P2's pairings store). */
  peerFingerprint: string
  /** `sha256(e_pub ‖ ct₀ ‖ d_e_pub)` — the exact transcript both sides bound
   *  to. A later phase channel-binds reconnect tokens to this. */
  transcriptHash: Uint8Array
  /**
   * The human-facing client label carried in the sealed hello. On the daemon
   * side this is the name the peer chose (surfaced in `pairings.json` and on
   * `pair accept`); on the client side it echoes the name this side supplied.
   * Optional so pre-P2 callers constructing a session literal are unaffected —
   * P2 (pairing-registry) reads it to name a persisted pairing without opening
   * the seal a second time. Populated by both handshake entry points below.
   */
  clientName?: string
}

// ─── key helpers ────────────────────────────────────────────────

/** Decode a base64 SPKI X25519 public key, rejecting anything the provider
 *  can't import with `invalid_key`. */
async function x25519PublicKey(crypto: CryptoProvider, b64Der: string, what: string): Promise<Uint8Array> {
  const der = base64Decode(b64Der)
  try {
    await crypto.x25519ValidatePublicKey(der)
  } catch {
    throw new PairingError("invalid_key", `invalid ${what} X25519 public key`)
  }
  return der
}

/**
 * Compute the transcript hash from the raw wire bytes of each message part.
 * Using the wire bytes (not a re-export of the parsed key) guarantees both
 * sides hash identical bytes regardless of any DER canonicalisation.
 */
function transcriptHash(
  crypto: CryptoProvider,
  ePubB64: string,
  ct0: string,
  dePubB64: string,
): Promise<Uint8Array> {
  return crypto.sha256(concatBytes(base64Decode(ePubB64), utf8Encode(ct0), base64Decode(dePubB64)))
}

/** Derive the two direction keys from the two ECDH outputs, salted by the
 *  transcript. Concatenation order (ECDH(e,d_e) then ECDH(e,static)) and the
 *  key split (c2d then d2c) are identical on both sides. */
async function deriveDirectionKeys(
  crypto: CryptoProvider,
  ecdhEphemeral: Uint8Array,
  ecdhStatic: Uint8Array,
  transcript: Uint8Array,
): Promise<{ kc2d: Uint8Array; kd2c: Uint8Array }> {
  const ikm = concatBytes(ecdhEphemeral, ecdhStatic)
  const okm = await crypto.hkdfSha256(ikm, transcript, HKDF_INFO, KEY_LEN * 2)
  return {
    kc2d: okm.subarray(0, KEY_LEN),
    kd2c: okm.subarray(KEY_LEN, KEY_LEN * 2),
  }
}

// ─── client side ────────────────────────────────────────────────

/** Everything the client learned from the offer URL, plus its chosen name. */
export interface ClientHandshakeParams {
  /** Daemon static X25519 public key (base64 SPKI DER) — the seal recipient
   *  and one ECDH input. From the offer's `pk`. */
  daemonX25519Pub: string
  /** Daemon static Ed25519 public key (base64 SPKI DER) — verifies `sig`.
   *  From the offer's `sk`. */
  daemonEd25519Pub: string
  /** One-time offer token. From the offer's `t`. */
  offerToken: string
  /** Human-facing client label the daemon displays on accept. */
  clientName: string
}

/** A started client handshake: send `hello`, then feed the daemon's reply to
 *  `complete` to derive the session. */
export interface StartedClientHandshake {
  hello: PairingHello
  /** Verify the daemon reply and derive the session. Rejects with
   *  `PairingError` on a bad signature, malformed reply, or invalid key —
   *  never resolves partial state. */
  complete(reply: PairingReply): Promise<PairingSession>
}

/**
 * Begin a client handshake. Generates the client ephemeral keypair, seals the
 * hello payload to the daemon's static key, and resolves to the `hello` to send
 * plus a `complete` to run once the daemon replies.
 *
 * `crypto` selects the primitive implementation (default: WebCrypto here,
 * `node:crypto` through the `@agentproto/secrets/pairing` Node entry). The
 * provider is captured for `complete` as well.
 */
export async function startClientHandshake(
  params: ClientHandshakeParams,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<StartedClientHandshake> {
  // Validate the daemon keys up front so a bad offer fails before we transmit.
  const daemonStatic = await x25519PublicKey(crypto, params.daemonX25519Pub, "daemon")

  const ephemeral = await crypto.x25519GenerateKeyPair()
  const ePubB64 = base64Encode(ephemeral.publicKey)

  const payload: HelloPayload = {
    clientPub: ePubB64,
    clientName: params.clientName,
    offerToken: params.offerToken,
  }
  const ct0 = await seal(JSON.stringify(payload), params.daemonX25519Pub, crypto)
  const hello: PairingHello = { v: PAIR_VERSION, ePub: ePubB64, ct0 }

  const complete = async (reply: PairingReply): Promise<PairingSession> => {
    if (reply.v !== PAIR_VERSION) {
      throw new PairingError("malformed_reply", `unsupported reply version ${reply.v}`)
    }
    const dePub = await x25519PublicKey(crypto, reply.dePub, "daemon ephemeral")
    const transcript = await transcriptHash(crypto, ePubB64, ct0, reply.dePub)

    if (!(await verifyTranscript(params.daemonEd25519Pub, transcript, reply.sig, crypto))) {
      throw new PairingError(
        "bad_signature",
        "daemon transcript signature did not verify against the offered key"
      )
    }

    const ecdhEphemeral = await crypto.x25519(ephemeral.privateKey, dePub)
    const ecdhStatic = await crypto.x25519(ephemeral.privateKey, daemonStatic)
    const { kc2d, kd2c } = await deriveDirectionKeys(crypto, ecdhEphemeral, ecdhStatic, transcript)

    return {
      sendKey: kc2d,
      recvKey: kd2c,
      peerFingerprint: await identityFingerprint(params.daemonX25519Pub, crypto),
      transcriptHash: transcript,
      clientName: params.clientName,
    }
  }

  return { hello, complete }
}

// ─── daemon side ────────────────────────────────────────────────

/** What the daemon brings to the handshake: its identity, and a predicate that
 *  validates (and, in P2, spends) the one-time offer token. */
export interface DaemonHandshakeParams {
  identity: DaemonIdentity
  /**
   * Validate the presented offer token. Returning false rejects the handshake
   * with `offer_rejected`. The daemon owns single-use + expiry policy here so
   * this module never needs to know about the offer store — a stale or already
   * spent token simply returns false. May be async.
   */
  verifyOfferToken: (token: string) => boolean | Promise<boolean>
}

/** A completed daemon handshake: send `reply`, keep `session`. */
export interface DaemonHandshakeResult {
  reply: PairingReply
  session: PairingSession
}

/**
 * Respond to a client hello. Opens the sealed payload with the daemon's X25519
 * private key, checks the offer token and the ephemeral-key binding, signs the
 * transcript, and derives the session. Rejects with `PairingError` on any
 * failure — a tampered `ct₀`, a swapped `ePub`, a rejected token — before
 * producing any reply, so a rejected client learns nothing and gets no session.
 */
export async function respondToHandshake(
  hello: PairingHello,
  params: DaemonHandshakeParams,
  crypto: CryptoProvider = webCryptoProvider,
): Promise<DaemonHandshakeResult> {
  if (hello.v !== PAIR_VERSION) {
    throw new PairingError("malformed_hello", `unsupported hello version ${hello.v}`)
  }
  const clientEphemeral = await x25519PublicKey(crypto, hello.ePub, "client ephemeral")

  let payloadJson: string
  try {
    payloadJson = await unseal(hello.ct0, params.identity.x25519.priv, crypto)
  } catch (err) {
    if (err instanceof SealError) {
      throw new PairingError(
        "unseal_failed",
        "could not open sealed hello — wrong daemon key or tampered ct₀"
      )
    }
    throw err
  }

  const payload = parseHelloPayload(payloadJson)

  // The sealed payload echoes the client ephemeral key; it must match the
  // cleartext ePub, or a rendezvous swapped ePub while relaying the intact
  // (opaque) seal. Binds the ephemeral to the sealed offer proof.
  if (payload.clientPub !== hello.ePub) {
    throw new PairingError(
      "ephemeral_mismatch",
      "sealed clientPub does not match the hello ephemeral key"
    )
  }

  if (!(await params.verifyOfferToken(payload.offerToken))) {
    throw new PairingError("offer_rejected", "offer token was rejected (unknown, expired, or spent)")
  }

  const daemonEphemeral = await crypto.x25519GenerateKeyPair()
  const dePubB64 = base64Encode(daemonEphemeral.publicKey)

  const transcript = await transcriptHash(crypto, hello.ePub, hello.ct0, dePubB64)
  const sig = await signTranscript(params.identity.ed25519.priv, transcript, crypto)

  const daemonStaticPriv = base64Decode(params.identity.x25519.priv)
  const ecdhEphemeral = await crypto.x25519(daemonEphemeral.privateKey, clientEphemeral)
  let ecdhStatic: Uint8Array
  try {
    ecdhStatic = await crypto.x25519(daemonStaticPriv, clientEphemeral)
  } catch {
    throw new PairingError("invalid_key", "invalid daemon static X25519 private key")
  }
  const { kc2d, kd2c } = await deriveDirectionKeys(crypto, ecdhEphemeral, ecdhStatic, transcript)

  return {
    reply: { v: PAIR_VERSION, dePub: dePubB64, sig },
    session: {
      // Daemon sends on c2d's counterpart: it RECEIVES client→daemon (kc2d)
      // and SENDS daemon→client (kd2c).
      sendKey: kd2c,
      recvKey: kc2d,
      peerFingerprint: await identityFingerprint(payload.clientPub, crypto),
      transcriptHash: transcript,
      clientName: payload.clientName,
    },
  }
}

// ─── message (de)serialization ──────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function parseHelloPayload(json: string): HelloPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new PairingError("malformed_hello", "sealed hello payload was not valid JSON")
  }
  if (
    !isRecord(parsed) ||
    typeof parsed["clientPub"] !== "string" ||
    typeof parsed["clientName"] !== "string" ||
    typeof parsed["offerToken"] !== "string"
  ) {
    throw new PairingError("malformed_hello", "sealed hello payload is missing required fields")
  }
  return {
    clientPub: parsed["clientPub"],
    clientName: parsed["clientName"],
    offerToken: parsed["offerToken"],
  }
}

/** Serialize a handshake message to bytes for transport. */
export function encodePairingMessage(message: PairingHello | PairingReply): Uint8Array {
  return utf8Encode(JSON.stringify(message))
}

/** Parse + validate a client hello from raw bytes. Truncated or malformed
 *  input throws `PairingError("malformed_hello")` — never a partial object. */
export function decodePairingHello(bytes: Uint8Array): PairingHello {
  const parsed = parseJson(bytes, "malformed_hello")
  if (
    !isRecord(parsed) ||
    parsed["v"] !== PAIR_VERSION ||
    typeof parsed["ePub"] !== "string" ||
    typeof parsed["ct0"] !== "string"
  ) {
    throw new PairingError("malformed_hello", "hello message is malformed")
  }
  return { v: PAIR_VERSION, ePub: parsed["ePub"], ct0: parsed["ct0"] }
}

/** Parse + validate a daemon reply from raw bytes. Truncated or malformed
 *  input throws `PairingError("malformed_reply")`. */
export function decodePairingReply(bytes: Uint8Array): PairingReply {
  const parsed = parseJson(bytes, "malformed_reply")
  if (
    !isRecord(parsed) ||
    parsed["v"] !== PAIR_VERSION ||
    typeof parsed["dePub"] !== "string" ||
    typeof parsed["sig"] !== "string"
  ) {
    throw new PairingError("malformed_reply", "reply message is malformed")
  }
  return { v: PAIR_VERSION, dePub: parsed["dePub"], sig: parsed["sig"] }
}

function parseJson(bytes: Uint8Array, code: PairingErrorCode): unknown {
  try {
    return JSON.parse(utf8Decode(bytes))
  } catch {
    throw new PairingError(code, "message was not valid JSON (truncated or corrupt)")
  }
}
