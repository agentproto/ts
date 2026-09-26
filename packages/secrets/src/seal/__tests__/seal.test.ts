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
import { nodeCryptoProvider } from "../../crypto/node.js"
import { webCryptoProvider } from "../../crypto/webcrypto.js"

describe.each([
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
])("@agentproto/secrets/seal (%s)", (_name, c) => {
  it("round-trips a secret through seal → unseal", async () => {
    const { publicKey, privateKey } = await generateSealKeyPair(c)
    const secret = "sk-ant-oat01-EXAMPLE-token-value"
    const sealed = await seal(secret, publicKey, c)
    expect(await unseal(sealed, privateKey, c)).toBe(secret)
  })

  it("round-trips unicode + long payloads", async () => {
    const { publicKey, privateKey } = await generateSealKeyPair(c)
    const secret = "🔐 café — " + "x".repeat(10_000)
    expect(await unseal(await seal(secret, publicKey, c), privateKey, c)).toBe(secret)
  })

  it("the sender needs only the public key (ciphertext leaks no plaintext)", async () => {
    const { publicKey } = await generateSealKeyPair(c)
    const secret = "top-secret-token"
    const sealed = await seal(secret, publicKey, c)
    // The opaque blob must not contain the plaintext anywhere.
    expect(sealed).not.toContain(secret)
    expect(Buffer.from(sealed, "base64").toString("utf8")).not.toContain(secret)
  })

  it("produces a fresh envelope each time (ephemeral key + iv)", async () => {
    const { publicKey, privateKey } = await generateSealKeyPair(c)
    const a = await seal("same", publicKey, c)
    const b = await seal("same", publicKey, c)
    expect(a).not.toBe(b)
    expect(await unseal(a, privateKey, c)).toBe("same")
    expect(await unseal(b, privateKey, c)).toBe("same")
  })

  it("the wrong private key cannot open the envelope", async () => {
    const recipient = await generateSealKeyPair(c)
    const attacker = await generateSealKeyPair(c)
    const sealed = await seal("secret", recipient.publicKey, c)
    await expect(unseal(sealed, attacker.privateKey, c)).rejects.toThrow(SealError)
  })

  it("tampering with the ciphertext fails closed", async () => {
    const { publicKey, privateKey } = await generateSealKeyPair(c)
    const sealed = await seal("secret", publicKey, c)
    const env = JSON.parse(Buffer.from(sealed, "base64").toString("utf8"))
    const ct = Buffer.from(env.ct, "base64")
    ct[0] = ct[0]! ^ 0xff // flip a byte
    env.ct = ct.toString("base64")
    const tampered = Buffer.from(JSON.stringify(env), "utf8").toString("base64")
    await expect(unseal(tampered, privateKey, c)).rejects.toThrow(SealError)
  })

  it("rejects a malformed envelope and unsupported versions", async () => {
    const { privateKey } = await generateSealKeyPair(c)
    await expect(unseal("not-base64-json!!", privateKey, c)).rejects.toThrow(SealError)
    const bad = Buffer.from(
      JSON.stringify({ v: 999, alg: "nope", epk: "", iv: "", ct: "", tag: "" }),
      "utf8"
    ).toString("base64")
    await expect(unseal(bad, privateKey, c)).rejects.toThrow(/unsupported/)
  })

  it("rejects an invalid recipient public key at seal time", async () => {
    await expect(seal("x", "not-a-real-key", c)).rejects.toThrow(SealError)
  })

  it("derives the public key from the private key (seal against it works)", async () => {
    const { publicKey, privateKey } = await generateSealKeyPair(c)
    const derived = await sealingPublicKey(privateKey, c)
    expect(derived).toBe(publicKey)
    // A sender holding only the derived key can seal; the holder unseals.
    expect(await unseal(await seal("v", derived, c), privateKey, c)).toBe("v")
  })

  it("sealKeyId is stable per public key and changes across keys", async () => {
    const a = await generateSealKeyPair(c)
    const b = await generateSealKeyPair(c)
    expect(await sealKeyId(a.publicKey, c)).toBe(await sealKeyId(a.publicKey, c))
    expect(await sealKeyId(a.publicKey, c)).not.toBe(await sealKeyId(b.publicKey, c))
    expect(await sealKeyId(a.publicKey, c)).toHaveLength(16)
  })

  it("stamps the versioned algorithm tag", async () => {
    const { publicKey } = await generateSealKeyPair(c)
    const env = JSON.parse(
      Buffer.from(await seal("x", publicKey, c), "base64").toString("utf8")
    )
    expect(env.alg).toBe(SEAL_ALG)
    expect(env.v).toBe(SEAL_VERSION)
  })
})
