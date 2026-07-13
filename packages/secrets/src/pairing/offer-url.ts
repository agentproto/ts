/**
 * The pairing offer URL codec (design: DESIGN §2).
 *
 * `agentproto pair offer` prints a single URL (also renderable as a QR):
 *
 * ```
 *   agentproto://pair?v=1
 *     &rv=<rendezvous ws/wss url>          // where both sides meet
 *     &id=<fingerprint>                    // daemon identity fingerprint (16 hex)
 *     &pk=<b64url x25519 SPKI DER>         // daemon static encryption key
 *     &sk=<b64url ed25519 SPKI DER>        // daemon signing key
 *     &t=<one-time offer token>            // rendezvous routing + first-contact proof
 *     &exp=<unix seconds>                  // offer expiry
 * ```
 *
 * The URL **is** the bootstrap secret. It carries the daemon's public keys, so
 * a client that scans it can pin the daemon and detect a man-in-the-middle
 * rendezvous (verifying the handshake signature against `sk`); and it carries a
 * one-time, short-TTL token so a stranger who never saw the URL can't pair.
 *
 * This module is a **pure codec** — it validates structure and echoes bytes; it
 * performs no I/O and no network calls, so it is safe to run on either side
 * (the daemon builds it, the client parses it). It lives in `@agentproto/secrets`
 * beside the handshake so both sides share one authority on the format.
 *
 * Key material travels **base64url** in the URL (no `+`/`/`/`=` to percent-
 * escape). The handshake, however, speaks standard base64 SPKI DER, so
 * `parseOfferUrl` returns `daemonX25519Pub`/`daemonEd25519Pub` already converted
 * back to standard base64 — feed them straight into `startClientHandshake`.
 */

import { identityFingerprint } from "../identity/index.js"
import { PairingError } from "./handshake.js"

/** URL scheme + host for offer URLs. */
export const OFFER_URL_SCHEME = "agentproto:" as const
export const OFFER_URL_HOST = "pair" as const
/** Offer-format version. Bumped if the param set changes. */
export const OFFER_VERSION = 1 as const

/**
 * A parsed, structurally-valid pairing offer. `daemonX25519Pub` /
 * `daemonEd25519Pub` are standard-base64 SPKI DER (handshake-ready). `token` is
 * the opaque one-time offer token verbatim (the daemon checks it against its
 * offer store). `exp` is unix **seconds**.
 */
export interface PairingOffer {
  v: typeof OFFER_VERSION
  /** Rendezvous endpoint both sides dial (ws:// or wss://). */
  rendezvousUrl: string
  /** Daemon identity fingerprint (16 hex) — must equal fingerprint(pk). */
  fingerprint: string
  /** Daemon static X25519 public key, standard base64 SPKI DER. */
  daemonX25519Pub: string
  /** Daemon static Ed25519 public key, standard base64 SPKI DER. */
  daemonEd25519Pub: string
  /** One-time offer token (routing + first-contact proof). */
  token: string
  /** Offer expiry, unix seconds. */
  exp: number
}

// ─── base64 ⇄ base64url ──────────────────────────────────────────

function b64ToB64url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlToB64(b64url: string): string {
  const replaced = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const pad = replaced.length % 4
  return pad === 0 ? replaced : replaced + "=".repeat(4 - pad)
}

/** True when `s` is a non-empty base64url string (the alphabet only). */
function isB64url(s: string): boolean {
  return s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s)
}

// ─── encode ──────────────────────────────────────────────────────

/**
 * Build the offer URL from an offer. The public keys come in as standard
 * base64 (the shape the identity file + handshake use) and are emitted as
 * base64url. `token` is emitted verbatim (callers mint it as base64url).
 */
export function encodeOfferUrl(offer: PairingOffer): string {
  const params = new URLSearchParams()
  params.set("v", String(OFFER_VERSION))
  params.set("rv", offer.rendezvousUrl)
  params.set("id", offer.fingerprint)
  params.set("pk", b64ToB64url(offer.daemonX25519Pub))
  params.set("sk", b64ToB64url(offer.daemonEd25519Pub))
  params.set("t", offer.token)
  params.set("exp", String(offer.exp))
  return `${OFFER_URL_SCHEME}//${OFFER_URL_HOST}?${params.toString()}`
}

// ─── parse ───────────────────────────────────────────────────────

export interface ParseOfferOptions {
  /**
   * When set, the parser rejects an offer whose `exp` is at or before this
   * instant (unix **milliseconds**) with `PairingError("offer_expired")`. Omit
   * to parse structure only and let the caller decide when to check expiry
   * (the daemon's offer store is the authoritative single-use + expiry gate).
   */
  now?: number
}

/**
 * Parse + strictly validate an offer URL. Throws `PairingError` — never returns
 * a partial object — on any structural problem:
 *
 *   - `malformed_offer`: wrong scheme/host, unknown version, missing/blank
 *     params, non-base64url keys/token, non-integer `exp`, or a `fingerprint`
 *     that does not match `fingerprint(pk)` (tamper detection: a rendezvous or
 *     link-mangler that swaps the daemon key can't keep `id` consistent).
 *   - `offer_expired`: only when `opts.now` is supplied and `exp` has passed.
 */
export function parseOfferUrl(url: string, opts: ParseOfferOptions = {}): PairingOffer {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PairingError("malformed_offer", "offer is not a valid URL")
  }
  if (parsed.protocol !== OFFER_URL_SCHEME) {
    throw new PairingError(
      "malformed_offer",
      `offer scheme must be "${OFFER_URL_SCHEME}//" (got "${parsed.protocol}//")`,
    )
  }
  // `agentproto://pair?…` parses with host="pair"; tolerate `agentproto:pair?…`
  // (host="" pathname="pair") too, since some QR scanners/relayers normalise the
  // authority away.
  const host = parsed.host || parsed.pathname.replace(/^\/+/, "")
  if (host !== OFFER_URL_HOST) {
    throw new PairingError("malformed_offer", `offer host must be "${OFFER_URL_HOST}"`)
  }

  const q = parsed.searchParams
  const v = q.get("v")
  if (v !== String(OFFER_VERSION)) {
    throw new PairingError("malformed_offer", `unsupported offer version "${v ?? "(absent)"}"`)
  }

  const rendezvousUrl = req(q, "rv")
  // The rendezvous must be a ws/wss URL; reject anything else early so a
  // tampered offer can't point the client at an arbitrary scheme.
  let rvParsed: URL
  try {
    rvParsed = new URL(rendezvousUrl)
  } catch {
    throw new PairingError("malformed_offer", "offer `rv` is not a valid URL")
  }
  if (rvParsed.protocol !== "ws:" && rvParsed.protocol !== "wss:") {
    throw new PairingError("malformed_offer", "offer `rv` must be a ws:// or wss:// URL")
  }

  const fingerprint = req(q, "id")
  if (!/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new PairingError("malformed_offer", "offer `id` is not a 16-hex fingerprint")
  }

  const pkUrl = req(q, "pk")
  const skUrl = req(q, "sk")
  if (!isB64url(pkUrl) || !isB64url(skUrl)) {
    throw new PairingError("malformed_offer", "offer `pk`/`sk` must be base64url")
  }
  const daemonX25519Pub = b64urlToB64(pkUrl)
  const daemonEd25519Pub = b64urlToB64(skUrl)

  const token = req(q, "t")
  if (!isB64url(token)) {
    throw new PairingError("malformed_offer", "offer `t` (token) must be base64url")
  }

  const expRaw = req(q, "exp")
  const exp = Number(expRaw)
  if (!Number.isInteger(exp) || exp <= 0) {
    throw new PairingError("malformed_offer", "offer `exp` is not a positive unix timestamp")
  }

  // Integrity: `id` must be the fingerprint OF the offered X25519 key. This is
  // what turns the URL into a self-authenticating bootstrap secret — a party
  // that swaps `pk` for their own key can't also produce a matching `id` without
  // it being obviously a different fingerprint the human never saw.
  if (identityFingerprint(daemonX25519Pub) !== fingerprint) {
    throw new PairingError(
      "malformed_offer",
      "offer `id` does not match fingerprint(pk) — tampered or corrupt offer",
    )
  }

  if (opts.now !== undefined && exp * 1000 <= opts.now) {
    throw new PairingError("offer_expired", "offer has expired")
  }

  return {
    v: OFFER_VERSION,
    rendezvousUrl,
    fingerprint,
    daemonX25519Pub,
    daemonEd25519Pub,
    token,
    exp,
  }
}

function req(q: URLSearchParams, key: string): string {
  const v = q.get(key)
  if (v === null || v === "") {
    throw new PairingError("malformed_offer", `offer is missing required param "${key}"`)
  }
  return v
}
