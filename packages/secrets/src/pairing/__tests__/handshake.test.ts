import { describe, it, expect } from "vitest"
import {
  startClientHandshake,
  respondToHandshake,
  encodePairingMessage,
  decodePairingHello,
  decodePairingReply,
  PairingError,
  type PairingErrorCode,
  type ClientHandshakeParams,
  type DaemonHandshakeParams,
  type PairingHello,
} from "../handshake.js"
import { generateIdentity, identityFingerprint } from "../../identity/index.js"

const OFFER_TOKEN = "one-time-offer-token-abc123"

function setup() {
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
  return { identity, clientParams, daemonParams }
}

/** Assert `fn` throws a `PairingError` with exactly `code` — no `as` casts. */
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

/** Deterministically corrupt a sealed-envelope string by flipping a byte of
 *  its inner ciphertext — guarantees the AEAD tag fails on unseal. */
function tamperSeal(ct0: string): string {
  const env: unknown = JSON.parse(Buffer.from(ct0, "base64").toString("utf8"))
  if (typeof env !== "object" || env === null || !("ct" in env) || typeof env.ct !== "string") {
    throw new Error("test setup: unexpected seal envelope shape")
  }
  const ctBuf = Buffer.from(env.ct, "base64")
  ctBuf.writeUInt8(ctBuf.readUInt8(0) ^ 0xff, 0)
  const mutated = { ...env, ct: ctBuf.toString("base64") }
  return Buffer.from(JSON.stringify(mutated), "utf8").toString("base64")
}

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b))

describe("@agentproto/secrets/pairing — pair/v1 handshake", () => {
  it("happy path derives matching, direction-crossed keys on both sides", () => {
    const { clientParams, daemonParams, identity } = setup()
    const client = startClientHandshake(clientParams)
    const { reply, session: daemonSession } = respondToHandshake(client.hello, daemonParams)
    const clientSession = client.complete(reply)

    // Direction keys cross: what the client sends, the daemon receives.
    expect(eq(clientSession.sendKey, daemonSession.recvKey)).toBe(true)
    expect(eq(clientSession.recvKey, daemonSession.sendKey)).toBe(true)
    // But the two directions use DIFFERENT keys.
    expect(eq(clientSession.sendKey, clientSession.recvKey)).toBe(false)
    // Both keys are AES-256 sized.
    expect(clientSession.sendKey).toHaveLength(32)
    expect(clientSession.recvKey).toHaveLength(32)

    // Both sides bound to the same transcript.
    expect(eq(clientSession.transcriptHash, daemonSession.transcriptHash)).toBe(true)

    // Fingerprints: the client pins the daemon's static identity; the daemon
    // (in P1) sees the client's ephemeral key.
    expect(clientSession.peerFingerprint).toBe(identityFingerprint(identity.x25519.pub))
    expect(daemonSession.peerFingerprint).toBe(identityFingerprint(client.hello.ePub))
  })

  it("hello and reply survive an encode → decode round-trip", () => {
    const { clientParams, daemonParams } = setup()
    const client = startClientHandshake(clientParams)
    const decodedHello = decodePairingHello(encodePairingMessage(client.hello))
    expect(decodedHello).toEqual(client.hello)

    const { reply } = respondToHandshake(decodedHello, daemonParams)
    const decodedReply = decodePairingReply(encodePairingMessage(reply))
    expect(decodedReply).toEqual(reply)
    // And the full path still completes off the round-tripped messages.
    expect(() => client.complete(decodedReply)).not.toThrow()
  })

  it("daemon rejects a tampered ct₀ (unseal_failed), no reply, no session", () => {
    const { clientParams, daemonParams } = setup()
    const client = startClientHandshake(clientParams)
    const tampered: PairingHello = { ...client.hello, ct0: tamperSeal(client.hello.ct0) }
    expectPairingError(() => respondToHandshake(tampered, daemonParams), "unseal_failed")
  })

  it("daemon rejects a swapped ephemeral key (ephemeral_mismatch)", () => {
    const { clientParams, daemonParams } = setup()
    const client = startClientHandshake(clientParams)
    // A broker relays the intact (opaque) seal but substitutes a different
    // cleartext ephemeral key.
    const attacker = startClientHandshake(clientParams)
    const swapped: PairingHello = { ...client.hello, ePub: attacker.hello.ePub }
    expectPairingError(() => respondToHandshake(swapped, daemonParams), "ephemeral_mismatch")
  })

  it("daemon rejects a stale / unknown offer token (offer_rejected)", () => {
    const { clientParams, identity } = setup()
    const client = startClientHandshake(clientParams)
    const strictDaemon: DaemonHandshakeParams = {
      identity,
      verifyOfferToken: () => false, // token unknown/expired/spent
    }
    expectPairingError(() => respondToHandshake(client.hello, strictDaemon), "offer_rejected")
  })

  it("a single-use token is accepted once, then a replay is rejected", () => {
    const { clientParams, identity } = setup()
    let spent = false
    const singleUse: DaemonHandshakeParams = {
      identity,
      verifyOfferToken: t => {
        if (spent || t !== OFFER_TOKEN) return false
        spent = true
        return true
      },
    }
    // First pairing consumes the token.
    expect(() => respondToHandshake(startClientHandshake(clientParams).hello, singleUse)).not.toThrow()
    // A replay of a fresh hello carrying the same (now spent) token is refused.
    expectPairingError(
      () => respondToHandshake(startClientHandshake(clientParams).hello, singleUse),
      "offer_rejected"
    )
  })

  it("client rejects a reply signed by the wrong daemon key (bad_signature)", () => {
    const { clientParams, daemonParams } = setup()
    // The client pins a DIFFERENT Ed25519 key than the daemon actually holds —
    // models an evil rendezvous re-signing with its own key.
    const wrongKeyParams: ClientHandshakeParams = {
      ...clientParams,
      daemonEd25519Pub: generateIdentity().ed25519.pub,
    }
    const client = startClientHandshake(wrongKeyParams)
    const { reply } = respondToHandshake(client.hello, daemonParams)
    expectPairingError(() => client.complete(reply), "bad_signature")
  })

  it("client rejects a reply whose daemon ephemeral was flipped in flight", () => {
    const { clientParams, daemonParams } = setup()
    const client = startClientHandshake(clientParams)
    const { reply } = respondToHandshake(client.hello, daemonParams)
    // A broker swaps the daemon ephemeral — the transcript no longer matches
    // the one the signature covers.
    const attacker = respondToHandshake(startClientHandshake(clientParams).hello, daemonParams)
    const forged = { ...reply, dePub: attacker.reply.dePub }
    expectPairingError(() => client.complete(forged), "bad_signature")
  })

  it("daemon with the wrong static key cannot open the hello (unseal_failed)", () => {
    const { clientParams } = setup()
    const client = startClientHandshake(clientParams)
    const otherDaemon: DaemonHandshakeParams = {
      identity: generateIdentity(), // different x25519 → cannot unseal
      verifyOfferToken: () => true,
    }
    expectPairingError(() => respondToHandshake(client.hello, otherDaemon), "unseal_failed")
  })

  it("rejects truncated / malformed handshake messages", () => {
    const { clientParams, daemonParams } = setup()
    const client = startClientHandshake(clientParams)
    const helloBytes = encodePairingMessage(client.hello)

    // Truncated hello → not valid JSON.
    expectPairingError(
      () => decodePairingHello(helloBytes.subarray(0, helloBytes.length - 10)),
      "malformed_hello"
    )

    // A reply decoded as a hello (missing fields) → malformed_hello.
    const { reply } = respondToHandshake(client.hello, daemonParams)
    const replyBytes = encodePairingMessage(reply)
    expectPairingError(() => decodePairingHello(replyBytes), "malformed_hello")

    // Truncated reply → malformed_reply.
    expectPairingError(() => decodePairingReply(replyBytes.subarray(0, 5)), "malformed_reply")
  })

  it("decode rejects an unsupported protocol version at the wire boundary", () => {
    const { clientParams } = setup()
    const client = startClientHandshake(clientParams)
    // Untyped bytes on the wire claim a future version — the decode boundary
    // is where this is caught (the typed API can't express a bad version).
    const wrongVersion = Buffer.from(
      JSON.stringify({ v: 999, ePub: client.hello.ePub, ct0: client.hello.ct0 }),
      "utf8"
    )
    expectPairingError(() => decodePairingHello(wrongVersion), "malformed_hello")
  })

  it("the sealed hello leaks neither the offer token nor the client name", () => {
    const { clientParams } = setup()
    const client = startClientHandshake(clientParams)
    const wire = JSON.stringify(client.hello)
    expect(wire).not.toContain(OFFER_TOKEN)
    expect(wire).not.toContain("jeremy@laptop")
  })
})
