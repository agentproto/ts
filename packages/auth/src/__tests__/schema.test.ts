import { describe, it, expect } from "vitest"
import {
  authProviderFrontmatterSchema,
  authConfigSchema,
  tokenStoreSpecSchema,
} from "../schema.js"

describe("authProviderFrontmatterSchema", () => {
  const base = {
    id: "acme",
    description: "ACME API.",
    apiBase: "https://api.acme.example",
    auth: { flow: "pat", tokenStore: { keychain: "acme-cli" } },
  }

  it("accepts a minimal pat provider", () => {
    const r = authProviderFrontmatterSchema.safeParse(base)
    expect(r.success).toBe(true)
  })

  it("accepts a service-auth provider with optional install", () => {
    const r = authProviderFrontmatterSchema.safeParse({
      ...base,
      auth: {
        flow: "service-auth",
        clientId: "agentproto-cli",
        loginHint: "me@acme.example",
        tokenStore: { keychain: "acme", account: "{server}" },
      },
      install: { sealKey: "/seal", secretBacked: "/guilds/{guildId}/sb" },
    })
    expect(r.success).toBe(true)
  })

  it("rejects an unknown auth flow", () => {
    const r = authProviderFrontmatterSchema.safeParse({
      ...base,
      auth: { flow: "magic", tokenStore: { keychain: "x" } },
    })
    expect(r.success).toBe(false)
  })

  it("rejects unknown top-level keys (strict)", () => {
    const r = authProviderFrontmatterSchema.safeParse({ ...base, extra: 1 })
    expect(r.success).toBe(false)
  })

  it("rejects unknown keys inside tokenStore (strict)", () => {
    const r = tokenStoreSpecSchema.safeParse({ keychain: "x", nope: true })
    expect(r.success).toBe(false)
  })

  it("rejects a non-URL apiBase", () => {
    const r = authProviderFrontmatterSchema.safeParse({
      ...base,
      apiBase: "not-a-url",
    })
    expect(r.success).toBe(false)
  })

  it("rejects a too-short id", () => {
    const r = authProviderFrontmatterSchema.safeParse({ ...base, id: "a" })
    expect(r.success).toBe(false)
  })

  it("rejects an empty description", () => {
    const r = authProviderFrontmatterSchema.safeParse({ ...base, description: "" })
    expect(r.success).toBe(false)
  })

  it("rejects a description over 2000 chars", () => {
    const r = authProviderFrontmatterSchema.safeParse({
      ...base,
      description: "x".repeat(2001),
    })
    expect(r.success).toBe(false)
  })
})

describe("authConfigSchema discriminated union", () => {
  it("discriminates pat vs service-auth on `flow`", () => {
    expect(
      authConfigSchema.safeParse({ flow: "pat", tokenStore: { keychain: "k" } })
        .success,
    ).toBe(true)
    expect(
      authConfigSchema.safeParse({
        flow: "service-auth",
        tokenStore: { keychain: "k" },
      }).success,
    ).toBe(true)
  })

  it("requires tokenStore on both flows", () => {
    expect(authConfigSchema.safeParse({ flow: "pat" }).success).toBe(false)
    expect(
      authConfigSchema.safeParse({ flow: "service-auth" }).success,
    ).toBe(false)
  })
})
