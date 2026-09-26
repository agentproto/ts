import { describe, it, expect } from "vitest"
import { randomBytes as nodeRandom } from "node:crypto"
import { nodeCryptoProvider as node } from "../node.js"
import { webCryptoProvider as web } from "../webcrypto.js"
import {
  base64DecodePortable,
  base64EncodePortable,
  compareBytes,
  timingSafeEqualBytes,
  toHex,
  utf8Encode,
} from "../bytes.js"

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"))

// Known-answer + cross tests: for fixed inputs the two providers must produce
// identical bytes, and anything one produces the other must accept.
describe("CryptoProvider parity: node:crypto vs WebCrypto", () => {
  it("sha256 / hmac-sha256 / hkdf-sha256 agree (RFC 5869 case 1 as KAT)", async () => {
    const data = nodeRandom(1000)
    expect(toHex(await web.sha256(data))).toBe(toHex(await node.sha256(data)))
    expect(toHex(await web.sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )

    const key = nodeRandom(32)
    expect(toHex(await web.hmacSha256(key, data))).toBe(toHex(await node.hmacSha256(key, data)))

    // RFC 5869 A.1
    const ikm = hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
    const salt = hex("000102030405060708090a0b0c")
    const info = hex("f0f1f2f3f4f5f6f7f8f9")
    const okm =
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    expect(toHex(await node.hkdfSha256(ikm, salt, info, 42))).toBe(okm)
    expect(toHex(await web.hkdfSha256(ikm, salt, info, 42))).toBe(okm)
  })

  it("AES-256-GCM: identical ciphertext‖tag, cross-decrypt, and tamper rejection", async () => {
    const key = nodeRandom(32)
    const iv = nodeRandom(12)
    const aad = nodeRandom(8)
    for (const pt of [new Uint8Array(), utf8Encode("hello"), nodeRandom(70_000)]) {
      const a = await node.aesGcmEncrypt(key, iv, pt, aad)
      const b = await web.aesGcmEncrypt(key, iv, pt, aad)
      expect(toHex(a)).toBe(toHex(b))
      expect(toHex(await web.aesGcmDecrypt(key, iv, a, aad))).toBe(toHex(pt))
      expect(toHex(await node.aesGcmDecrypt(key, iv, b, aad))).toBe(toHex(pt))

      const flipped = Uint8Array.from(a)
      flipped[flipped.length - 1]! ^= 1
      await expect(node.aesGcmDecrypt(key, iv, flipped, aad)).rejects.toThrow()
      await expect(web.aesGcmDecrypt(key, iv, flipped, aad)).rejects.toThrow()
      // AAD is bound: a different counter fails.
      await expect(web.aesGcmDecrypt(key, iv, a, new Uint8Array(8))).rejects.toThrow()
    }
    // Without AAD too (the seal box).
    const pt = utf8Encode("no aad")
    expect(toHex(await web.aesGcmEncrypt(key, iv, pt))).toBe(toHex(await node.aesGcmEncrypt(key, iv, pt)))
  })

  it("X25519: keys minted by either side are interchangeable DER; ECDH agrees", async () => {
    const a = await node.x25519GenerateKeyPair()
    const b = await web.x25519GenerateKeyPair()
    // Same DER shapes: 44-byte SPKI, 48-byte PKCS#8.
    expect(a.publicKey.length).toBe(44)
    expect(b.publicKey.length).toBe(44)
    expect(b.privateKey.length).toBe(a.privateKey.length)

    const s1 = await node.x25519(a.privateKey, b.publicKey)
    const s2 = await web.x25519(b.privateKey, a.publicKey)
    const s3 = await web.x25519(a.privateKey, b.publicKey)
    const s4 = await node.x25519(b.privateKey, a.publicKey)
    expect(toHex(s1)).toBe(toHex(s2))
    expect(toHex(s1)).toBe(toHex(s3))
    expect(toHex(s1)).toBe(toHex(s4))

    for (const kp of [a, b]) {
      expect(toHex(await node.x25519PublicKeyFromPrivate(kp.privateKey))).toBe(toHex(kp.publicKey))
      expect(toHex(await web.x25519PublicKeyFromPrivate(kp.privateKey))).toBe(toHex(kp.publicKey))
    }
  })

  it("Ed25519: deterministic signatures match; each verifies the other's", async () => {
    const msg = nodeRandom(64)
    for (const kp of [await node.ed25519GenerateKeyPair(), await web.ed25519GenerateKeyPair()]) {
      const s1 = await node.ed25519Sign(kp.privateKey, msg)
      const s2 = await web.ed25519Sign(kp.privateKey, msg)
      expect(toHex(s1)).toBe(toHex(s2))
      expect(await web.ed25519Verify(kp.publicKey, msg, s1)).toBe(true)
      expect(await node.ed25519Verify(kp.publicKey, msg, s2)).toBe(true)
      const bad = Uint8Array.from(s1)
      bad[0]! ^= 1
      expect(await node.ed25519Verify(kp.publicKey, msg, bad)).toBe(false)
      expect(await web.ed25519Verify(kp.publicKey, msg, bad)).toBe(false)
      expect(await web.ed25519Verify(kp.publicKey, msg, bad.subarray(0, 10))).toBe(false)
    }
  })

  it("both reject malformed / wrong-algorithm keys the same way", async () => {
    const x = await node.x25519GenerateKeyPair()
    const ed = await node.ed25519GenerateKeyPair()
    for (const p of [node, web]) {
      await expect(p.x25519ValidatePublicKey(new Uint8Array([1, 2, 3]))).rejects.toThrow()
      await expect(p.x25519ValidatePublicKey(ed.publicKey)).rejects.toThrow()
      await expect(p.ed25519ValidatePublicKey(x.publicKey)).rejects.toThrow()
      await expect(p.x25519(x.privateKey, ed.publicKey)).rejects.toThrow()
      await expect(p.ed25519Sign(x.privateKey, new Uint8Array(1))).rejects.toThrow()
      await p.x25519ValidatePublicKey(x.publicKey)
      await p.ed25519ValidatePublicKey(ed.publicKey)
    }
  })

  it("randomBytes returns the requested length (incl. > 64 KiB for WebCrypto)", () => {
    expect(web.randomBytes(12)).toHaveLength(12)
    expect(web.randomBytes(100_000)).toHaveLength(100_000)
    expect(node.randomBytes(12)).toHaveLength(12)
  })
})

describe("portable byte helpers match Buffer", () => {
  it("base64 encode matches Buffer for every length 0..300", () => {
    for (let n = 0; n <= 300; n++) {
      const bytes = nodeRandom(n)
      expect(base64EncodePortable(bytes)).toBe(Buffer.from(bytes).toString("base64"))
    }
  })

  it("base64 decode matches Buffer's lenient decode, including hostile input", () => {
    const cases = [
      "", "Q", "QQ", "QQ=", "QQ==", "QUJD", "QUJDRA", "QUI=x", "QQ==QQ==", "Q=Q=",
      "QU JD", "QU\nJD", "!!!!QUJD", "-_-_", "+/+/", "é€QUJD", "QUJD====", "=QUJD",
    ]
    for (let n = 0; n < 200; n++) {
      const raw = nodeRandom(n)
      cases.push(Buffer.from(raw).toString("base64"), Buffer.from(raw).toString("base64url"))
    }
    // Random soup over the full alphabet plus junk.
    const soup = "ABCxyz019+/-_= \n!~é"
    for (let n = 0; n < 300; n++) {
      let s = ""
      for (let i = 0; i < n % 37; i++) s += soup[nodeRandom(1)[0]! % soup.length]
      cases.push(s)
    }
    for (const s of cases) {
      expect(toHex(base64DecodePortable(s)), JSON.stringify(s)).toBe(Buffer.from(s, "base64").toString("hex"))
    }
  })

  it("compareBytes orders like Buffer.compare; timingSafeEqualBytes is exact", () => {
    for (let i = 0; i < 200; i++) {
      const a = nodeRandom(i % 5)
      const b = nodeRandom(i % 3)
      expect(compareBytes(a, b)).toBe(Buffer.compare(a, b))
    }
    const a = nodeRandom(32)
    expect(timingSafeEqualBytes(a, Uint8Array.from(a))).toBe(true)
    expect(timingSafeEqualBytes(a, a.subarray(0, 31))).toBe(false)
    const b = Uint8Array.from(a)
    b[31]! ^= 1
    expect(timingSafeEqualBytes(a, b)).toBe(false)
  })
})
