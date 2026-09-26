import { describe, it, expect } from "vitest"
import {
  derivePairRoot,
  currentEpoch,
  deriveEpochRoutingToken,
  epochRoutingTokens,
  importPairRootKey,
} from "../derive.js"
import {
  startClientHandshake,
  respondToHandshake,
  type ClientHandshakeParams,
  type DaemonHandshakeParams,
} from "../handshake.js"
import { generateIdentity } from "../../identity/index.js"
import { nodeCryptoProvider } from "../../crypto/node.js"
import { webCryptoProvider } from "../../crypto/webcrypto.js"

const OFFER_TOKEN = "one-time-offer-token-xyz789"

/** Run a full handshake and return both derived sessions. */
async function handshake() {
  const identity = await generateIdentity()
  const clientParams: ClientHandshakeParams = {
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    offerToken: OFFER_TOKEN,
    clientName: "jeremy@laptop",
  }
  const daemonParams: DaemonHandshakeParams = {
    identity,
    verifyOfferToken: t => t === OFFER_TOKEN,
  }
  const client = await startClientHandshake(clientParams)
  const { reply, session: daemonSession } = await respondToHandshake(client.hello, daemonParams)
  const clientSession = await client.complete(reply)
  return { clientSession, daemonSession }
}

const MS_PER_DAY = 86_400_000

describe.each([
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
])("derivePairRoot (%s)", (_name, c) => {
  it("produces the identical pair root on both sides despite role-swapped keys", async () => {
    const { clientSession, daemonSession } = await handshake()
    const clientRoot = await derivePairRoot(clientSession, c)
    const daemonRoot = await derivePairRoot(daemonSession, c)
    expect(clientRoot).toBe(daemonRoot)
    // 32-byte root → 44 base64 chars.
    expect(Buffer.from(clientRoot, "base64")).toHaveLength(32)
  })

  it("differs across independent pairings", async () => {
    const a = await derivePairRoot((await handshake()).clientSession, c)
    const b = await derivePairRoot((await handshake()).clientSession, c)
    expect(a).not.toBe(b)
  })
})

describe.each([
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
])("epoch routing tokens (%s)", (_name, c) => {
  it("currentEpoch is the UTC day number", () => {
    expect(currentEpoch(0)).toBe(0)
    expect(currentEpoch(MS_PER_DAY)).toBe(1)
    expect(currentEpoch(MS_PER_DAY * 3 + 5)).toBe(3)
  })

  it("both sides derive the same token for the same epoch", async () => {
    const { clientSession, daemonSession } = await handshake()
    const cRoot = await derivePairRoot(clientSession, c)
    const dRoot = await derivePairRoot(daemonSession, c)
    const epoch = currentEpoch()
    expect(await deriveEpochRoutingToken(cRoot, epoch, c)).toBe(await deriveEpochRoutingToken(dRoot, epoch, c))
  })

  it("tokens rotate per epoch (unlinkable across days)", async () => {
    const root = await derivePairRoot((await handshake()).clientSession, c)
    const e = 20_000
    expect(await deriveEpochRoutingToken(root, e, c)).not.toBe(await deriveEpochRoutingToken(root, e + 1, c))
    expect(await deriveEpochRoutingToken(root, e, c)).not.toBe(await deriveEpochRoutingToken(root, e - 1, c))
  })

  it("token is base64url (drops into a ?t= param) and 16 bytes", async () => {
    const root = await derivePairRoot((await handshake()).clientSession, c)
    const tok = await deriveEpochRoutingToken(root, currentEpoch(), c)
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/)
    // 16 bytes → 22 base64url chars (unpadded).
    expect(tok).toHaveLength(22)
  })

  it("epochRoutingTokens returns current + previous, both accepted", async () => {
    const root = await derivePairRoot((await handshake()).clientSession, c)
    const now = MS_PER_DAY * 100 + 123
    const set = await epochRoutingTokens(root, now, c)
    expect(set).toHaveLength(2)
    expect(set[0]?.epoch).toBe(100)
    expect(set[1]?.epoch).toBe(99)
    expect(set[0]?.token).toBe(await deriveEpochRoutingToken(root, 100, c))
    expect(set[1]?.token).toBe(await deriveEpochRoutingToken(root, 99, c))
  })
})

describe("non-extractable pair-root CryptoKey", () => {
  it("derives the same epoch tokens as the base64 root, through either provider", async () => {
    const root = await derivePairRoot((await handshake()).clientSession, nodeCryptoProvider)
    const key = await importPairRootKey(root)
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe("HKDF")
    for (const epoch of [0, 20_000, currentEpoch()]) {
      const expected = await deriveEpochRoutingToken(root, epoch, nodeCryptoProvider)
      expect(await deriveEpochRoutingToken(key, epoch)).toBe(expected)
      expect(await deriveEpochRoutingToken(key, epoch, nodeCryptoProvider)).toBe(expected)
    }
    expect(await epochRoutingTokens(key, MS_PER_DAY * 7)).toEqual(
      await epochRoutingTokens(root, MS_PER_DAY * 7, nodeCryptoProvider),
    )
  })

  it("cannot be exported", async () => {
    const key = await importPairRootKey(await derivePairRoot((await handshake()).clientSession))
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toThrow()
  })
})
