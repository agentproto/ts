import { describe, it, expect } from "vitest"
import {
  derivePairRoot,
  currentEpoch,
  deriveEpochRoutingToken,
  epochRoutingTokens,
} from "../derive.js"
import {
  startClientHandshake,
  respondToHandshake,
  type ClientHandshakeParams,
  type DaemonHandshakeParams,
} from "../handshake.js"
import { generateIdentity } from "../../identity/index.js"

const OFFER_TOKEN = "one-time-offer-token-xyz789"

/** Run a full handshake and return both derived sessions. */
function handshake() {
  const identity = generateIdentity()
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
  const client = startClientHandshake(clientParams)
  const { reply, session: daemonSession } = respondToHandshake(client.hello, daemonParams)
  const clientSession = client.complete(reply)
  return { clientSession, daemonSession }
}

const MS_PER_DAY = 86_400_000

describe("derivePairRoot", () => {
  it("produces the identical pair root on both sides despite role-swapped keys", () => {
    const { clientSession, daemonSession } = handshake()
    const clientRoot = derivePairRoot(clientSession)
    const daemonRoot = derivePairRoot(daemonSession)
    expect(clientRoot).toBe(daemonRoot)
    // 32-byte root → 44 base64 chars.
    expect(Buffer.from(clientRoot, "base64")).toHaveLength(32)
  })

  it("differs across independent pairings", () => {
    const a = derivePairRoot(handshake().clientSession)
    const b = derivePairRoot(handshake().clientSession)
    expect(a).not.toBe(b)
  })
})

describe("epoch routing tokens", () => {
  it("currentEpoch is the UTC day number", () => {
    expect(currentEpoch(0)).toBe(0)
    expect(currentEpoch(MS_PER_DAY)).toBe(1)
    expect(currentEpoch(MS_PER_DAY * 3 + 5)).toBe(3)
  })

  it("both sides derive the same token for the same epoch", () => {
    const { clientSession, daemonSession } = handshake()
    const cRoot = derivePairRoot(clientSession)
    const dRoot = derivePairRoot(daemonSession)
    const epoch = currentEpoch()
    expect(deriveEpochRoutingToken(cRoot, epoch)).toBe(deriveEpochRoutingToken(dRoot, epoch))
  })

  it("tokens rotate per epoch (unlinkable across days)", () => {
    const root = derivePairRoot(handshake().clientSession)
    const e = 20_000
    expect(deriveEpochRoutingToken(root, e)).not.toBe(deriveEpochRoutingToken(root, e + 1))
    expect(deriveEpochRoutingToken(root, e)).not.toBe(deriveEpochRoutingToken(root, e - 1))
  })

  it("token is base64url (drops into a ?t= param) and 16 bytes", () => {
    const root = derivePairRoot(handshake().clientSession)
    const tok = deriveEpochRoutingToken(root, currentEpoch())
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/)
    // 16 bytes → 22 base64url chars (unpadded).
    expect(tok).toHaveLength(22)
  })

  it("epochRoutingTokens returns current + previous, both accepted", () => {
    const root = derivePairRoot(handshake().clientSession)
    const now = MS_PER_DAY * 100 + 123
    const set = epochRoutingTokens(root, now)
    expect(set).toHaveLength(2)
    expect(set[0]?.epoch).toBe(100)
    expect(set[1]?.epoch).toBe(99)
    expect(set[0]?.token).toBe(deriveEpochRoutingToken(root, 100))
    expect(set[1]?.token).toBe(deriveEpochRoutingToken(root, 99))
  })
})
