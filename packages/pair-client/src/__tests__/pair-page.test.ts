/**
 * The per-daemon pair page, as a page consumes it through the public entry:
 * the QR link resolves `{fp}` to the daemon's own origin, the page can check it
 * is that origin (`expectedPairHost` vs `location.host`), and the default is
 * still the shared `cli.agentproto.sh` page.
 */

import { describe, it, expect } from "vitest"
import { encodeOfferUrl } from "@agentproto/secrets/pairing"
import { generateIdentity, identityFingerprint } from "@agentproto/secrets/identity"
import {
  encodeOfferWebUrl,
  expectedPairHost,
  inspectOffer,
  PAIR_WEB_URL,
  PAIR_WEB_URL_TEMPLATE_CLOUD,
} from "../index.js"

async function offerUrl(): Promise<{ url: string; fingerprint: string }> {
  const id = await generateIdentity()
  const fingerprint = await identityFingerprint(id.x25519.pub)
  const url = encodeOfferUrl({
    v: 2,
    rendezvousUrl: "wss://rdv.example/v1",
    fingerprint,
    daemonX25519Pub: id.x25519.pub,
    daemonEd25519Pub: id.ed25519.pub,
    secret: "AAAABBBBCCCCDDDDEEEEFF",
    exp: Math.floor(Date.now() / 1000) + 600,
  })
  return { url, fingerprint }
}

describe("per-daemon pair page", () => {
  it("a {fp} template yields the daemon's own origin, which the page can verify", async () => {
    const { url, fingerprint } = await offerUrl()
    const link = encodeOfferWebUrl(url, PAIR_WEB_URL_TEMPLATE_CLOUD)
    const page = new URL(link)
    expect(page.host).toBe(`${fingerprint}.agentproto.cloud`)

    // What the page does on load: parse the fragment, then check its origin.
    const info = await inspectOffer(link)
    expect(info.fingerprint).toBe(fingerprint)
    expect(expectedPairHost(PAIR_WEB_URL_TEMPLATE_CLOUD, info.fingerprint)).toBe(page.host)
    // Another daemon's offer opened on this origin doesn't match it.
    const other = await offerUrl()
    expect(expectedPairHost(PAIR_WEB_URL_TEMPLATE_CLOUD, other.fingerprint)).not.toBe(page.host)
  })

  it("the default stays the shared cli.agentproto.sh page", async () => {
    const { url, fingerprint } = await offerUrl()
    expect(PAIR_WEB_URL).toBe("https://cli.agentproto.sh/pair")
    expect(new URL(encodeOfferWebUrl(url)).host).toBe("cli.agentproto.sh")
    expect(expectedPairHost(PAIR_WEB_URL, fingerprint)).toBe("cli.agentproto.sh")
  })
})
