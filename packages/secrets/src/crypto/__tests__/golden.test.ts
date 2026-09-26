import { describe, it, expect } from "vitest"
import { nodeCryptoProvider } from "../node.js"
import { webCryptoProvider } from "../webcrypto.js"
import { base64Decode, toHex, utf8Decode } from "../bytes.js"
import type { CryptoProvider, KeyPairDer } from "../types.js"
import {
  startClientHandshake,
  respondToHandshake,
  encodePairingMessage,
} from "../../pairing/handshake.js"
import {
  startTunnelHandshake,
  respondToTunnelHandshake,
  encodeTunnelMessage,
} from "../../pairing/tunnel-handshake.js"
import { derivePairRoot, deriveEpochRoutingToken } from "../../pairing/derive.js"
import { encodeOfferUrl, parseOfferUrl } from "../../pairing/offer-url.js"
import { seal, unseal } from "../../seal/core.js"
import { identityFingerprint } from "../../identity/core.js"
import type { DaemonIdentity } from "../../identity/core.js"
import { GOLDEN, KEYS } from "./golden-vectors.js"

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
  it("pair/v1: hello, reply, session keys, transcript, fingerprints", async () => {
    // Same call order as the golden run: client eph, seal eph, daemon eph.
    const c = pinned(base, ["clientEph", "sealEph", "daemonEph"])
    const started = await startClientHandshake(
      {
        daemonX25519Pub: KEYS.daemonX.pub,
        daemonEd25519Pub: KEYS.daemonEd.pub,
        offerToken: "AAAABBBBCCCCDDDDEEEEFF",
        clientName: "golden@client",
      },
      c,
    )
    expect(utf8Decode(encodePairingMessage(started.hello))).toBe(GOLDEN.helloWire)

    const { reply, session: ds } = await respondToHandshake(
      started.hello,
      { identity, verifyOfferToken: () => true },
      c,
    )
    expect(utf8Decode(encodePairingMessage(reply))).toBe(GOLDEN.replyWire)

    const cs = await started.complete(reply)
    expect(toHex(cs.sendKey)).toBe(GOLDEN.clientSendKey)
    expect(toHex(cs.recvKey)).toBe(GOLDEN.clientRecvKey)
    expect(toHex(ds.sendKey)).toBe(GOLDEN.daemonSendKey)
    expect(toHex(ds.recvKey)).toBe(GOLDEN.daemonRecvKey)
    expect(toHex(cs.transcriptHash)).toBe(GOLDEN.transcriptHash)
    expect(toHex(ds.transcriptHash)).toBe(GOLDEN.transcriptHash)
    expect(cs.peerFingerprint).toBe(GOLDEN.clientPeerFingerprint)
    expect(ds.peerFingerprint).toBe(GOLDEN.daemonPeerFingerprint)

    const root = await derivePairRoot(cs, c)
    expect(root).toBe(GOLDEN.pairRoot)
    expect(await derivePairRoot(ds, c)).toBe(GOLDEN.pairRoot)
    expect(await deriveEpochRoutingToken(root, 20000, c)).toBe(GOLDEN.epochToken20000)
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
      v: 1 as const,
      rendezvousUrl: "wss://rdv.example/v1",
      fingerprint: await identityFingerprint(KEYS.daemonX.pub, base),
      daemonX25519Pub: KEYS.daemonX.pub,
      daemonEd25519Pub: KEYS.daemonEd.pub,
      token: "AAAABBBBCCCCDDDDEEEEFF",
      exp: 1900000000,
    }
    expect(encodeOfferUrl(offer)).toBe(GOLDEN.offerUrl)
    expect(await parseOfferUrl(GOLDEN.offerUrl, {}, base)).toEqual(offer)
  })
})
