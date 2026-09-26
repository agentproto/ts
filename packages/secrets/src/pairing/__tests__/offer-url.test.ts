import { describe, it, expect } from "vitest"
import {
  encodeOfferUrl,
  parseOfferUrl,
  type PairingOffer,
} from "../offer-url.js"
import { PairingError, type PairingErrorCode } from "../handshake.js"
import { generateIdentity, identityFingerprint } from "../../identity/index.js"

async function makeOffer(overrides: Partial<PairingOffer> = {}): Promise<PairingOffer> {
  const identity = await generateIdentity()
  return {
    v: 1,
    rendezvousUrl: "wss://rendezvous.example/v1",
    fingerprint: await identityFingerprint(identity.x25519.pub),
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    token: "AAAABBBBCCCCDDDDEEEEFF",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }
}

async function expectPairingError(fn: () => unknown, code: PairingErrorCode): Promise<void> {
  let thrown: unknown
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(PairingError)
  if (thrown instanceof PairingError) expect(thrown.code).toBe(code)
}

describe("offer URL codec", async () => {
  it("round-trips an offer", async () => {
    const offer = await makeOffer()
    const url = encodeOfferUrl(offer)
    expect(url.startsWith("agentproto://pair?")).toBe(true)
    const parsed = await parseOfferUrl(url)
    expect(parsed).toEqual(offer)
  })

  it("emits base64url key params (no +/=/ in the URL query)", async () => {
    const url = encodeOfferUrl(await makeOffer())
    const query = url.slice(url.indexOf("?") + 1)
    // pk/sk are base64url; the only reserved chars in the query should be `&`
    // and `=` between key/value pairs (URLSearchParams), never `+` or `/`.
    const pk = new URLSearchParams(query).get("pk") ?? ""
    expect(pk).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("recomputes the daemon fingerprint and accepts a consistent offer", async () => {
    const offer = await makeOffer()
    const parsed = await parseOfferUrl(encodeOfferUrl(offer))
    expect(await identityFingerprint(parsed.daemonX25519Pub)).toBe(parsed.fingerprint)
  })

  it("rejects a tampered public key (fingerprint no longer matches id)", async () => {
    const offer = await makeOffer()
    const other = await generateIdentity()
    // Swap in a different pk but keep the original id — MITM the QR.
    const url = encodeOfferUrl({ ...offer, daemonX25519Pub: other.x25519.pub })
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects a missing param", async () => {
    const url = encodeOfferUrl(await makeOffer())
    const stripped = url.replace(/&t=[^&]+/, "")
    await expectPairingError(() => parseOfferUrl(stripped), "malformed_offer")
  })

  it("rejects a wrong scheme", async () => {
    const url = encodeOfferUrl(await makeOffer()).replace("agentproto://", "https://")
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects an unknown version", async () => {
    const url = encodeOfferUrl(await makeOffer()).replace("v=1", "v=2")
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects a non-ws rendezvous URL", async () => {
    const offer = await makeOffer({ rendezvousUrl: "http://evil.example/v1" })
    await expectPairingError(() => parseOfferUrl(encodeOfferUrl(offer)), "malformed_offer")
  })

  it("rejects a non-integer exp", async () => {
    const url = encodeOfferUrl(await makeOffer()).replace(/exp=\d+/, "exp=not-a-number")
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("parses without expiry check by default, but rejects when now is past exp", async () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const url = encodeOfferUrl(await makeOffer({ exp: past }))
    // Structural parse succeeds without `now`.
    expect((await parseOfferUrl(url)).exp).toBe(past)
    // With `now`, an expired offer is rejected.
    await expectPairingError(() => parseOfferUrl(url, { now: Date.now() }), "offer_expired")
  })

  it("accepts a still-valid offer when now is supplied", async () => {
    const url = encodeOfferUrl(await makeOffer())
    await expect(parseOfferUrl(url, { now: Date.now() })).resolves.toBeDefined()
  })

  it("feeds parsed keys straight back into the handshake shape (standard base64)", async () => {
    const offer = await makeOffer()
    const parsed = await parseOfferUrl(encodeOfferUrl(offer))
    // Standard base64 (may contain +/= after padding) — equals the identity form.
    expect(parsed.daemonX25519Pub).toBe(offer.daemonX25519Pub)
    expect(parsed.daemonEd25519Pub).toBe(offer.daemonEd25519Pub)
  })
})
