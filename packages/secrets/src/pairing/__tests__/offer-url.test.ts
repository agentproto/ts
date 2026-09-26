import { describe, it, expect } from "vitest"
import {
  encodeOfferUrl,
  encodeOfferWebUrl,
  parseOfferUrl,
  PAIR_WEB_URL,
  PAIR_WEB_URL_TEMPLATE_CLOUD,
  resolvePairPageUrl,
  expectedPairHost,
  type PairingOffer,
} from "../offer-url.js"
import { PairingError, type PairingErrorCode } from "../handshake.js"
import { generateIdentity, identityFingerprint } from "../../identity/index.js"

async function makeOffer(overrides: Partial<PairingOffer> = {}): Promise<PairingOffer> {
  const identity = await generateIdentity()
  return {
    v: 2,
    rendezvousUrl: "wss://rendezvous.example/v1",
    fingerprint: await identityFingerprint(identity.x25519.pub),
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    secret: "AAAABBBBCCCCDDDDEEEEFF",
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
    const stripped = url.replace(/&s=[^&]+/, "")
    await expectPairingError(() => parseOfferUrl(stripped), "malformed_offer")
  })

  it("rejects a wrong scheme", async () => {
    const url = encodeOfferUrl(await makeOffer()).replace("agentproto://", "https://")
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("rejects an unknown version", async () => {
    const url = encodeOfferUrl(await makeOffer()).replace("v=2", "v=3")
    await expectPairingError(() => parseOfferUrl(url), "malformed_offer")
  })

  it("refuses a pair/v1 offer with an actionable re-pair error", async () => {
    const url = encodeOfferUrl(await makeOffer())
      .replace("v=2", "v=1")
      .replace("&s=", "&t=")
    await expectPairingError(() => parseOfferUrl(url), "pairing_protocol_outdated")
    await expect(parseOfferUrl(url)).rejects.toThrow(/agentproto pair offer/)
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

  it("wraps the offer in the fragment of the web pair page, and parses it back", async () => {
    const offer = await makeOffer()
    const url = encodeOfferUrl(offer)
    const web = encodeOfferWebUrl(url)
    expect(web.startsWith(`${PAIR_WEB_URL}#v=2&`)).toBe(true)
    expect(new URLSearchParams(web.slice(web.indexOf("#") + 1)).get("s")).toBe(offer.secret)
    // Nothing of the offer is in the part a browser sends to the server.
    const asUrl = new URL(web)
    expect(asUrl.search).toBe("")
    expect(`${asUrl.origin}${asUrl.pathname}`).toBe(PAIR_WEB_URL)
    expect(asUrl.hash.slice(1)).toBe(url.slice(url.indexOf("?") + 1))
    expect(await parseOfferUrl(web)).toEqual(offer)
    // A custom page (self-hosted / dev) round-trips too.
    expect(await parseOfferUrl(encodeOfferWebUrl(url, "http://localhost:3000/pair"))).toEqual(offer)
  })

  it("validates the web form exactly like the agentproto:// form", async () => {
    const offer = await makeOffer()
    const other = await generateIdentity()
    const tampered = encodeOfferWebUrl(encodeOfferUrl({ ...offer, daemonX25519Pub: other.x25519.pub }))
    await expectPairingError(() => parseOfferUrl(tampered), "malformed_offer")
    await expectPairingError(() => parseOfferUrl(`${PAIR_WEB_URL}`), "malformed_offer")
    await expectPairingError(() => parseOfferUrl(`${PAIR_WEB_URL}#`), "malformed_offer")
    // A pre-v2 offer in the fragment is refused as outdated, like the plain form.
    const v1 = encodeOfferWebUrl(encodeOfferUrl(offer).replace("v=2", "v=1").replace("&s=", "&t="))
    await expectPairingError(() => parseOfferUrl(v1), "pairing_protocol_outdated")
    const expired = encodeOfferWebUrl(encodeOfferUrl({ ...offer, exp: 10 }))
    await expectPairingError(() => parseOfferUrl(expired, { now: Date.now() }), "offer_expired")
  })

  it("encodeOfferWebUrl refuses a non-offer URL or a page with a fragment", async () => {
    const url = encodeOfferUrl(await makeOffer())
    await expectPairingError(() => encodeOfferWebUrl("https://example.com/?v=1"), "malformed_offer")
    await expectPairingError(() => encodeOfferWebUrl(url, "https://x.example/pair#a"), "malformed_offer")
    await expectPairingError(() => encodeOfferWebUrl(url, "ftp://x.example/pair"), "malformed_offer")
  })

  describe("per-daemon pair page templates ({fp} in the hostname)", () => {
    const FP = "a1b2c3d4e5f60718"

    it("substitutes the daemon fingerprint into the host", async () => {
      expect(resolvePairPageUrl("https://{fp}.agentproto.cloud/pair", FP)).toBe(
        `https://${FP}.agentproto.cloud/pair`,
      )
      expect(resolvePairPageUrl("http://{fp}.localhost:3000/pair", FP.toUpperCase())).toBe(
        `http://${FP}.localhost:3000/pair`,
      )
      expect(expectedPairHost(PAIR_WEB_URL_TEMPLATE_CLOUD, FP)).toBe(`${FP}.agentproto.cloud`)
      expect(expectedPairHost("http://{fp}.localhost:3000/pair", FP)).toBe(`${FP}.localhost:3000`)

      // encodeOfferWebUrl fills it from the offer's own `id`.
      const offer = await makeOffer()
      const url = encodeOfferUrl(offer)
      const web = encodeOfferWebUrl(url, PAIR_WEB_URL_TEMPLATE_CLOUD)
      expect(web).toBe(`https://${offer.fingerprint}.agentproto.cloud/pair#${url.slice(url.indexOf("?") + 1)}`)
      expect(new URL(web).host).toBe(expectedPairHost(PAIR_WEB_URL_TEMPLATE_CLOUD, offer.fingerprint))
      expect(await parseOfferUrl(web)).toEqual(offer)
    })

    it("leaves a plain URL unchanged, and the default is still cli.agentproto.sh", async () => {
      expect(PAIR_WEB_URL).toBe("https://cli.agentproto.sh/pair")
      expect(resolvePairPageUrl("https://pair.example.com/p/pair", FP)).toBe("https://pair.example.com/p/pair")
      expect(expectedPairHost(PAIR_WEB_URL, FP)).toBe("cli.agentproto.sh")
      const url = encodeOfferUrl(await makeOffer())
      expect(encodeOfferWebUrl(url).startsWith(`${PAIR_WEB_URL}#v=2&`)).toBe(true)
    })

    it("rejects {fp} outside the hostname, stray placeholders, bad fingerprints and non-web URLs", async () => {
      const bad = [
        "https://agentproto.cloud/{fp}/pair", // path
        "https://agentproto.cloud/pair?d={fp}", // query
        "https://agentproto.cloud/pair#{fp}", // fragment
        "https://{fp}@agentproto.cloud/pair", // userinfo
        "https://agentproto.cloud:{fp}/pair", // port
        "https://{fp}.agentproto.cloud/{fp}", // host + path
        "https://{FP}.agentproto.cloud/pair", // unknown placeholder
        "https://{daemon}.agentproto.cloud/pair",
        "ftp://{fp}.agentproto.cloud/pair",
        "{fp}.agentproto.cloud/pair",
        "https://{fp}.agentproto.cloud/pair#",
      ]
      for (const t of bad) {
        let thrown: unknown
        try {
          resolvePairPageUrl(t, FP)
        } catch (err) {
          thrown = err
        }
        expect(thrown, t).toBeInstanceOf(PairingError)
      }
      for (const fp of ["", "-abc", "abc-", "a".repeat(64), "not.hex", "zzzz", "a1b2/c3"]) {
        expect(() => resolvePairPageUrl(PAIR_WEB_URL_TEMPLATE_CLOUD, fp), fp).toThrow(PairingError)
      }
      await expectPairingError(
        () => encodeOfferWebUrl("agentproto://pair?v=2&s=x", PAIR_WEB_URL_TEMPLATE_CLOUD),
        "malformed_offer",
      )
    })
  })
})
