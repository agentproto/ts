import { describe, expect, it } from "vitest"

import {
  credentialSourceChoices,
  loginCommandFor,
} from "./authProfileConnect.logic.js"

describe("loginCommandFor", () => {
  it("offers `claude setup-token` for an Anthropic subscription", () => {
    const login = loginCommandFor("anthropic", "oauth-bearer")
    expect(login).not.toBeNull()
    expect(login?.command).toBe("claude")
    expect(login?.commandLine).toBe("claude setup-token")
    expect(login?.instruction).toMatch(/paste it below/i)
  })

  it("returns null for an api-key method (no login for a raw key)", () => {
    expect(loginCommandFor("anthropic", "api-key")).toBeNull()
    expect(loginCommandFor("openrouter", "api-key")).toBeNull()
  })

  it("returns null for an oauth endpoint with no first-class login", () => {
    expect(loginCommandFor("openrouter", "oauth-bearer")).toBeNull()
    expect(loginCommandFor("custom-gateway", "oauth-bearer")).toBeNull()
  })
})

describe("credentialSourceChoices", () => {
  const login = loginCommandFor("anthropic", "oauth-bearer")!

  it("offers login first, then paste", () => {
    const choices = credentialSourceChoices(login)
    expect(choices.map(c => c.source)).toEqual(["login", "paste"])
  })

  it("surfaces the exact command line as the login row description", () => {
    const [loginRow] = credentialSourceChoices(login)
    expect(loginRow?.description).toBe("claude setup-token")
  })

  it("every row carries a non-empty user-facing label and detail", () => {
    for (const c of credentialSourceChoices(login)) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.detail.length).toBeGreaterThan(0)
    }
  })
})
