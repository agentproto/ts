import { describe, it, expect } from "vitest"
import {
  registerAuthProvider,
  getAuthProvider,
  listAuthProviders,
  listAuthProviderIds,
} from "../registry.js"
import { defineAuthProvider } from "../define-auth-provider.js"

describe("auth-provider registry", () => {
  it("is pre-seeded with the guilde builtin", () => {
    expect(listAuthProviderIds()).toContain("guilde")
    expect(getAuthProvider("guilde")?.auth.flow).toBe("service-auth")
  })

  it("returns undefined for an unknown id", () => {
    expect(getAuthProvider("does-not-exist")).toBeUndefined()
  })

  it("registers a new provider and looks it up", () => {
    const acme = defineAuthProvider({
      id: "acme-reg",
      description: "ACME.",
      apiBase: "https://api.acme.example",
      auth: { flow: "pat", tokenStore: { keychain: "acme" } },
    })
    registerAuthProvider(acme)
    expect(getAuthProvider("acme-reg")).toBe(acme)
    expect(listAuthProviders().map((p) => p.id)).toContain("acme-reg")
  })

  it("last write wins — a re-registered id is shadowed", () => {
    const v1 = defineAuthProvider({
      id: "shadow",
      description: "v1.",
      apiBase: "https://v1.example",
      auth: { flow: "pat", tokenStore: { keychain: "k" } },
    })
    const v2 = defineAuthProvider({
      id: "shadow",
      description: "v2.",
      apiBase: "https://v2.example",
      auth: { flow: "pat", tokenStore: { keychain: "k" } },
    })
    registerAuthProvider(v1)
    registerAuthProvider(v2)
    expect(getAuthProvider("shadow")).toBe(v2)
  })
})
