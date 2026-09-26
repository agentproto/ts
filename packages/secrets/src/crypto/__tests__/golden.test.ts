import { describe, it, expect } from "vitest"
import { nodeCryptoProvider } from "../node.js"
import { webCryptoProvider } from "../webcrypto.js"
import { base64Decode, toHex, utf8Decode, utf8Encode } from "../bytes.js"
import type { CryptoProvider, KeyPairDer } from "../types.js"
import {
  startClientHandshake,
  respondToHandshake,
  respondToLegacyHandshake,
  encodePairingMessage,
} from "../../pairing/handshake.js"
import {
  startTunnelHandshake,
  respondToTunnelHandshake,
  encodeTunnelMessage,
} from "../../pairing/tunnel-handshake.js"
import {
  derivePairRoot,
  deriveEpochRoutingToken,
  deriveEpochAuthToken,
  deriveOfferTokens,
} from "../../pairing/derive.js"
import { encodeOfferUrl, parseOfferUrl } from "../../pairing/offer-url.js"
import { seal, unseal } from "../../seal/core.js"
import { identityFingerprint } from "../../identity/core.js"
import type { DaemonIdentity } from "../../identity/core.js"
import { GOLDEN, GOLDEN_V2, KEYS } from "./golden-vectors.js"

type KeyName = keyof typeof KEYS

/** `base` with its randomness pinned exactly as the golden run pinned
 *  `node:crypto`: X25519 keypairs come from `queue` in call order, and every
 *  random byte is 0x5a. Everything else is the real provider. */
function pinned(base: CryptoProvider, queue: KeyName[]): CryptoProvider {
  const pending = [...queue]
  return {
    ...base,
    randomBytes: n => new Uint8Array(n).fill(0x5a),
    x25519GenerateKeyPair: async (): Promise<KeyPairDer> => {
      const name = pending.shift()
      if (!name) throw new Error("golden test: X25519 key queue exhausted")
      return { publicKey: base64Decode(KEYS[name].pub), privateKey: base64Decode(KEYS[name].priv) }
    },
  }
}

const identity: DaemonIdentity = {
  v: 1,
  x25519: KEYS.daemonX,
  ed25519: KEYS.daemonEd,
  createdAt: "2026-01-01T00:00:00.000Z",
}

describe.each([
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
])("byte-identity with the pre-refactor node:crypto build (%s provider)", (_name, base) => {
  it("pair/v2: hello, reply, session keys, transcript, fingerprints", async () => {
    // Same call order as the golden run: client eph, seal eph, daemon eph.
    const c = pinned(base, ["clientEph", "sealEph", "daemonEph"])
    const started = await startClientHandshake(
      {
        daemonX25519Pub: KEYS.daemonX.pub,
        daemonEd25519Pub: KEYS.daemonEd.pub,
        authToken: GOLDEN_V2.offerAuth,
        clientName: "golden@client",
      },
      c,
    )
    expect(utf8Decode(encodePairingMessage(started.hello))).toBe(GOLDEN_V2.helloWire)

    const { reply, session: ds } = await respondToHandshake(
      started.hello,
      { identity, verifyAuthToken: t => t === GOLDEN_V2.offerAuth },
      c,
    )
    expect(utf8Decode(encodePairingMessage(reply))).toBe(GOLDEN_V2.replyWire)

    const cs = await started.complete(reply)
    expect(toHex(cs.sendKey)).toBe(GOLDEN_V2.clientSendKey)
    expect(toHex(cs.recvKey)).toBe(GOLDEN_V2.clientRecvKey)
    expect(toHex(ds.sendKey)).toBe(GOLDEN_V2.clientRecvKey)
    expect(toHex(ds.recvKey)).toBe(GOLDEN_V2.clientSendKey)
    expect(toHex(cs.transcriptHash)).toBe(GOLDEN_V2.transcriptHash)
    expect(cs.peerFingerprint).toBe(GOLDEN.clientPeerFingerprint)
    expect(await derivePairRoot(cs, c)).toBe(GOLDEN_V2.pairRoot)
    expect(await derivePairRoot(ds, c)).toBe(GOLDEN_V2.pairRoot)
  })

  it("pair/v2 route/auth derivations (KAT)", async () => {
    expect(await deriveOfferTokens("AAAABBBBCCCCDDDDEEEEFF", base)).toEqual({
      route: GOLDEN_V2.offerRoute,
      auth: GOLDEN_V2.offerAuth,
    })
    expect(await deriveEpochRoutingToken(GOLDEN.pairRoot, 20000, base)).toBe(GOLDEN_V2.epochRoute20000)
    expect(await deriveEpochAuthToken(GOLDEN.pairRoot, 20000, base)).toBe(GOLDEN_V2.epochAuth20000)
    // The reconnect route is v1's epoch token, unchanged — only the proof moved.
    expect(GOLDEN_V2.epochRoute20000).toBe(GOLDEN.epochToken20000)
  })

  it("pair/v1 legacy: a captured v1 hello gets the byte-identical v1 reply + keys", async () => {
    // GOLDEN.helloWire/replyWire were captured from the shipped v1 build. The
    // notice-only responder must answer a real v1 client exactly as a v1
    // daemon did, or that client couldn't read the re-pair notice.
    const c = pinned(base, ["daemonEph"])
    const { reply, keys } = await respondToLegacyHandshake(utf8Encode(GOLDEN.helloWire), identity, c)
    expect(utf8Decode(reply)).toBe(GOLDEN.replyWire)
    expect(toHex(keys.sendKey)).toBe(GOLDEN.daemonSendKey)
    expect(toHex(keys.recvKey)).toBe(GOLDEN.daemonRecvKey)
  })

  it("seal envelope", async () => {
    const c = pinned(base, ["sealEph"])
    const sealed = await seal("golden plaintext ✓", KEYS.daemonX.pub, c)
    expect(sealed).toBe(GOLDEN.sealed)
    expect(await unseal(GOLDEN.sealed, KEYS.daemonX.priv, base)).toBe("golden plaintext ✓")
  })

  it("tunnel-e2e/v1: offer, accept, session keys, transcript", async () => {
    const c = pinned(base, ["daemonEph", "clientEph"])
    const t = await startTunnelHandshake("apt_golden_token", c)
    expect(utf8Decode(encodeTunnelMessage(t.offer))).toBe(GOLDEN.tunnelOfferWire)
    const { accept, session: hs } = await respondToTunnelHandshake(t.offer, "apt_golden_token", c)
    expect(utf8Decode(encodeTunnelMessage(accept))).toBe(GOLDEN.tunnelAcceptWire)
    const ds = await t.complete(accept)
    expect(toHex(ds.sendKey)).toBe(GOLDEN.tunnelDaemonSendKey)
    expect(toHex(ds.recvKey)).toBe(GOLDEN.tunnelDaemonRecvKey)
    expect(toHex(hs.sendKey)).toBe(GOLDEN.tunnelHostSendKey)
    expect(toHex(ds.transcriptHash)).toBe(GOLDEN.tunnelTranscriptHash)
  })

  it("offer URL: encode matches, and parse accepts the golden URL", async () => {
    const offer = {
      v: 2 as const,
      rendezvousUrl: "wss://rdv.example/v1",
      fingerprint: await identityFingerprint(KEYS.daemonX.pub, base),
      daemonX25519Pub: KEYS.daemonX.pub,
      daemonEd25519Pub: KEYS.daemonEd.pub,
      secret: "AAAABBBBCCCCDDDDEEEEFF",
      exp: 1900000000,
    }
    expect(encodeOfferUrl(offer)).toBe(GOLDEN_V2.offerUrl)
    expect(await parseOfferUrl(GOLDEN_V2.offerUrl, {}, base)).toEqual(offer)
    // The captured v1 offer is refused with the actionable re-pair error.
    await expect(parseOfferUrl(GOLDEN.offerUrl, {}, base)).rejects.toMatchObject({
      code: "pairing_protocol_outdated",
    })
  })
})
