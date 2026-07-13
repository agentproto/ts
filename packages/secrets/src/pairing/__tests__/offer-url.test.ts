import { describe, it, expect } from "vitest"
import {
  encodeOfferUrl,
  parseOfferUrl,
  type PairingOffer,
} from "../offer-url.js"
import { PairingError, type PairingErrorCode } from "../handshake.js"
import { generateIdentity, identityFingerprint } from "../../identity/index.js"

function makeOffer(overrides: Partial<PairingOffer> = {}): PairingOffer {
  const identity = generateIdentity()
  return {
    v: 1,
    rendezvousUrl: "wss://rendezvous.example/v1",
    fingerprint: identityFingerprint(identity.x25519.pub),
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    token: "AAAABBBBCCCCDDDDEEEEFF",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }
}

function expectPairingError(fn: () => unknown, code: PairingErrorCode): void {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(PairingError)
  if (thrown instanceof PairingError) expect(thrown.code).toBe(code)
}

describe("offer URL codec", () => {
  it("round-trips an offer", () => {
    const offer = makeOffer()
    const url = encodeOfferUrl(offer)
    expect(url.startsWith("agentproto://pair?")).toBe(true)
    const parsed = parseOfferUrl(url)
    expect(parsed).toEqual(offer)
  })

  it("emits base64url key params (no +/=/ in the URL query)", () => {
    const url = encodeOfferUrl(makeOffer())
    const query = url.slice(url.indexOf("?") + 1)
    // pk/sk are base64url; the only reserved chars in the query should be `&`
    // and `=` between key/value pairs (URLSearchParams), never `+` or `/`.
    const pk = new URLSearchParams(query).get("pk") ?? ""
    expect(pk).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("recomputes the daemon fingerprint and accepts a consistent offer", () => {
    const offer = makeOffer()
    const parsed = parseOfferUrl(encodeOfferUrl(offer))
    expect(identityFingerprint(parsed.daemonX25519Pub)).toBe(parsed.fingerprint)
  })

  it("rejects a tampered public key (fingerprint no longer matches id)", () => {
    const offer = makeOffer()
    const other = generateIdentity()
    // Swap in a different pk but keep the original id — MITM the QR.
    const url = encodeOfferUrl({ ...offer, daemonX25519Pub: other.x25519.pub })
    expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects a missing param", () => {
    const url = encodeOfferUrl(makeOffer())
    const stripped = url.replace(/&t=[^&]+/, "")
    expectPairingError(() => parseOfferUrl(stripped), "malformed_offer")
  })

  it("rejects a wrong scheme", () => {
    const url = encodeOfferUrl(makeOffer()).replace("agentproto://", "https://")
    expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects an unknown version", () => {
    const url = encodeOfferUrl(makeOffer()).replace("v=1", "v=2")
    expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects a non-ws rendezvous URL", () => {
    const offer = makeOffer({ rendezvousUrl: "http://evil.example/v1" })
    expectPairingError(() => parseOfferUrl(encodeOfferUrl(offer)), "malformed_offer")
  })

  it("rejects a non-integer exp", () => {
    const url = encodeOfferUrl(makeOffer()).replace(/exp=\d+/, "exp=not-a-number")
    expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("parses without expiry check by default, but rejects when now is past exp", () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const url = encodeOfferUrl(makeOffer({ exp: past }))
    // Structural parse succeeds without `now`.
    expect(parseOfferUrl(url).exp).toBe(past)
    // With `now`, an expired offer is rejected.
    expectPairingError(() => parseOfferUrl(url, { now: Date.now() }), "offer_expired")
  })

  it("accepts a still-valid offer when now is supplied", () => {
    const url = encodeOfferUrl(makeOffer())
    expect(() => parseOfferUrl(url, { now: Date.now() })).not.toThrow()
  })

  it("feeds parsed keys straight back into the handshake shape (standard base64)", () => {
    const offer = makeOffer()
    const parsed = parseOfferUrl(encodeOfferUrl(offer))
    // Standard base64 (may contain +/= after padding) — equals the identity form.
    expect(parsed.daemonX25519Pub).toBe(offer.daemonX25519Pub)
    expect(parsed.daemonEd25519Pub).toBe(offer.daemonEd25519Pub)
  })
})
