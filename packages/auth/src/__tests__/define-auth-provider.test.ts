import { describe, it, expect } from "vitest"
import { defineAuthProvider } from "../define-auth-provider.js"
import type { AuthProviderDefinition } from "../types.js"

const valid: AuthProviderDefinition = {
  id: "acme",
  description: "ACME API.",
  apiBase: "https://api.acme.example",
  auth: { flow: "pat", tokenStore: { keychain: "acme-cli" } },
}

describe("defineAuthProvider", () => {
  it("returns a handle for a valid definition", () => {
    const h = defineAuthProvider(valid)
    expect(h.id).toBe("acme")
    expect(h.auth.flow).toBe("pat")
  })

  it("freezes the handle and nested auth/install", () => {
    const h = defineAuthProvider({
      ...valid,
      install: { sealKey: "/seal", secretBacked: "/sb" },
    })
    expect(Object.isFrozen(h)).toBe(true)
    expect(Object.isFrozen(h.auth)).toBe(true)
    expect(Object.isFrozen(h.install)).toBe(true)
  })

  it("throws with the AIP-50 prefix on an invalid id", () => {
    expect(() => defineAuthProvider({ ...valid, id: "Bad Id!" })).toThrow(
      /defineAuthProvider \(AIP-50\)/,
    )
  })

  it("throws on a malformed auth config", () => {
    expect(() =>
      defineAuthProvider({
        ...valid,
        // missing tokenStore
        auth: { flow: "pat" } as AuthProviderDefinition["auth"],
      }),
    ).toThrow(/AIP-50/)
  })

  it("leaves install undefined when omitted", () => {
    const h = defineAuthProvider(valid)
    expect(h.install).toBeUndefined()
  })
})
