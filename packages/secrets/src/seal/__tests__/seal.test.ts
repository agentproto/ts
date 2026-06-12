import { describe, it, expect } from "vitest"
import {
  generateSealKeyPair,
  sealingPublicKey,
  sealKeyId,
  seal,
  unseal,
  SealError,
  SEAL_ALG,
  SEAL_VERSION,
} from "../index.js"

describe("@agentproto/secrets/seal", () => {
  it("round-trips a secret through seal → unseal", () => {
    const { publicKey, privateKey } = generateSealKeyPair()
    const secret = "sk-ant-oat01-EXAMPLE-token-value"
    const sealed = seal(secret, publicKey)
    expect(unseal(sealed, privateKey)).toBe(secret)
  })

  it("round-trips unicode + long payloads", () => {
    const { publicKey, privateKey } = generateSealKeyPair()
    const secret = "🔐 café — " + "x".repeat(10_000)
    expect(unseal(seal(secret, publicKey), privateKey)).toBe(secret)
  })

  it("the sender needs only the public key (ciphertext leaks no plaintext)", () => {
    const { publicKey } = generateSealKeyPair()
    const secret = "top-secret-token"
    const sealed = seal(secret, publicKey)
    // The opaque blob must not contain the plaintext anywhere.
    expect(sealed).not.toContain(secret)
    expect(Buffer.from(sealed, "base64").toString("utf8")).not.toContain(secret)
  })

  it("produces a fresh envelope each time (ephemeral key + iv)", () => {
    const { publicKey, privateKey } = generateSealKeyPair()
    const a = seal("same", publicKey)
    const b = seal("same", publicKey)
    expect(a).not.toBe(b)
    expect(unseal(a, privateKey)).toBe("same")
    expect(unseal(b, privateKey)).toBe("same")
  })

  it("the wrong private key cannot open the envelope", () => {
    const recipient = generateSealKeyPair()
    const attacker = generateSealKeyPair()
    const sealed = seal("secret", recipient.publicKey)
    expect(() => unseal(sealed, attacker.privateKey)).toThrow(SealError)
  })

  it("tampering with the ciphertext fails closed", () => {
    const { publicKey, privateKey } = generateSealKeyPair()
    const sealed = seal("secret", publicKey)
    const env = JSON.parse(Buffer.from(sealed, "base64").toString("utf8"))
    const ct = Buffer.from(env.ct, "base64")
    ct[0] = ct[0]! ^ 0xff // flip a byte
    env.ct = ct.toString("base64")
    const tampered = Buffer.from(JSON.stringify(env), "utf8").toString("base64")
    expect(() => unseal(tampered, privateKey)).toThrow(SealError)
  })

  it("rejects a malformed envelope and unsupported versions", () => {
    const { privateKey } = generateSealKeyPair()
    expect(() => unseal("not-base64-json!!", privateKey)).toThrow(SealError)
    const bad = Buffer.from(
      JSON.stringify({ v: 999, alg: "nope", epk: "", iv: "", ct: "", tag: "" }),
      "utf8"
    ).toString("base64")
    expect(() => unseal(bad, privateKey)).toThrow(/unsupported/)
  })

  it("rejects an invalid recipient public key at seal time", () => {
    expect(() => seal("x", "not-a-real-key")).toThrow(SealError)
  })

  it("derives the public key from the private key (seal against it works)", () => {
    const { publicKey, privateKey } = generateSealKeyPair()
    const derived = sealingPublicKey(privateKey)
    expect(derived).toBe(publicKey)
    // A sender holding only the derived key can seal; the holder unseals.
    expect(unseal(seal("v", derived), privateKey)).toBe("v")
  })

  it("sealKeyId is stable per public key and changes across keys", () => {
    const a = generateSealKeyPair()
    const b = generateSealKeyPair()
    expect(sealKeyId(a.publicKey)).toBe(sealKeyId(a.publicKey))
    expect(sealKeyId(a.publicKey)).not.toBe(sealKeyId(b.publicKey))
    expect(sealKeyId(a.publicKey)).toHaveLength(16)
  })

  it("stamps the versioned algorithm tag", () => {
    const { publicKey } = generateSealKeyPair()
    const env = JSON.parse(
      Buffer.from(seal("x", publicKey), "base64").toString("utf8")
    )
    expect(env.alg).toBe(SEAL_ALG)
    expect(env.v).toBe(SEAL_VERSION)
  })
})
