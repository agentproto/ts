import { describe, it, expect } from "vitest"
import { sealWithPassphrase, unsealWithPassphrase } from "../lib/settings-secrets.js"

describe("settings-secrets passphrase sealing", () => {
  it("round-trips a value under the correct passphrase", () => {
    const envelope = sealWithPassphrase("sk-super-secret-token", "correct horse battery staple")
    expect(unsealWithPassphrase(envelope, "correct horse battery staple")).toBe(
      "sk-super-secret-token",
    )
  })

  it("never carries the plaintext anywhere in the envelope", () => {
    const secret = "sk-super-secret-token"
    const envelope = sealWithPassphrase(secret, "a passphrase")
    expect(JSON.stringify(envelope)).not.toContain(secret)
  })

  it("fails closed on the wrong passphrase", () => {
    const envelope = sealWithPassphrase("sk-super-secret-token", "right passphrase")
    expect(() => unsealWithPassphrase(envelope, "wrong passphrase")).toThrow()
  })

  it("fails closed on a tampered ciphertext", () => {
    const envelope = sealWithPassphrase("sk-super-secret-token", "a passphrase")
    const tampered = { ...envelope, ciphertext: Buffer.from("not the real ciphertext").toString("base64") }
    expect(() => unsealWithPassphrase(tampered, "a passphrase")).toThrow()
  })

  it("produces a fresh salt and IV on every call", () => {
    const a = sealWithPassphrase("same value", "same passphrase")
    const b = sealWithPassphrase("same value", "same passphrase")
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it("rejects an envelope with an unsupported method/kdf", () => {
    const envelope = sealWithPassphrase("v", "p")
    expect(() =>
      unsealWithPassphrase({ ...envelope, kdf: "pbkdf2" as never }, "p"),
    ).toThrow(/unsupported seal envelope/)
  })
})
