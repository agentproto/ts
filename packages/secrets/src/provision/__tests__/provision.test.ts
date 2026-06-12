import { describe, it, expect } from "vitest"
import {
  provisionSealed,
  httpTarget,
  resolveCredential,
  type SealedInstallTarget,
} from "../index.js"
import { generateSealKeyPair, unseal } from "../../seal/index.js"

describe("@agentproto/secrets/provision", () => {
  it("provisionSealed seals the credential to the target's key (server unseals it)", async () => {
    const kp = generateSealKeyPair()
    const keyId = "test-key-1"
    let received: { value: string; keyId: string; provider: string } | null =
      null

    const target: SealedInstallTarget = {
      async fetchSealKey() {
        return { keyId, alg: "x25519-hkdf-sha256-aes256gcm", publicKey: kp.publicKey }
      },
      async installSealed(input) {
        received = { value: input.value, keyId: input.keyId, provider: input.provider }
        return { secretId: "sec_123" }
      },
    }

    const secret = "sk-ant-oat01-EXAMPLE"
    const out = await provisionSealed({
      target,
      provider: "claude-code-oauth",
      methodId: "subscription-token",
      credential: secret,
    })

    expect(out.secretId).toBe("sec_123")
    expect(out.keyId).toBe(keyId)
    expect(received).not.toBeNull()
    // The installed value is ciphertext, not the plaintext…
    expect(received!.value).not.toContain(secret)
    // …and it unseals back to the original with the target's private key.
    expect(unseal(received!.value, kp.privateKey)).toBe(secret)
    expect(received!.provider).toBe("claude-code-oauth")
  })

  it("httpTarget fetches the seal-key and POSTs sealed:true", async () => {
    const kp = generateSealKeyPair()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith("/seal-key")) {
        return new Response(
          JSON.stringify({ keyId: "k1", alg: "a", publicKey: kp.publicKey }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ secretId: "sec_9" }), { status: 201 })
    }) as typeof fetch

    const target = httpTarget({
      sealKeyUrl: "https://x.test/seal-key",
      installUrl: "https://x.test/install",
      headers: { Authorization: "Bearer t" },
      fetchImpl: fakeFetch,
    })
    const out = await provisionSealed({
      target,
      provider: "p",
      methodId: "m",
      credential: "secret-value",
    })

    expect(out.secretId).toBe("sec_9")
    const installCall = calls.find(c => c.url.endsWith("/install"))!
    const body = JSON.parse(installCall.init!.body as string)
    expect(body.sealed).toBe(true)
    expect(body.keyId).toBe("k1")
    expect(body.value).not.toContain("secret-value")
    // unseal proves the sealed blob carries the original
    expect(unseal(body.value, kp.privateKey)).toBe("secret-value")
  })

  it("httpTarget surfaces a 404 seal-key as 'no sealing key configured'", async () => {
    const fakeFetch = (async () =>
      new Response("", { status: 404 })) as typeof fetch
    const target = httpTarget({
      sealKeyUrl: "https://x.test/seal-key",
      installUrl: "https://x.test/install",
      fetchImpl: fakeFetch,
    })
    await expect(target.fetchSealKey()).rejects.toThrow(/no sealing key/)
  })

  it("resolveCredential reads an env var", async () => {
    process.env.__PROVISION_TEST = "the-token"
    expect(await resolveCredential({ fromEnv: "__PROVISION_TEST" })).toBe(
      "the-token"
    )
    delete process.env.__PROVISION_TEST
  })

  it("resolveCredential throws on an empty env var", async () => {
    await expect(
      resolveCredential({ fromEnv: "__PROVISION_MISSING" })
    ).rejects.toThrow(/empty/)
  })
})
