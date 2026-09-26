import { describe, expect, it } from "vitest"
import {
  isValidAppEmbedToken,
  mintAppEmbedToken,
  stableAppEmbedToken,
} from "../embed-tokens.js"

describe("per-boot widget embed tokens", () => {
  it("a minted token validates; anything else does not", () => {
    const token = mintAppEmbedToken("@agentik/session-chat")
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(isValidAppEmbedToken(token)).toBe(true)
    expect(isValidAppEmbedToken("nope")).toBe(false)
    expect(isValidAppEmbedToken(null)).toBe(false)
    expect(isValidAppEmbedToken(undefined)).toBe(false)
  })

  it("two mints are distinct", () => {
    expect(mintAppEmbedToken("a")).not.toBe(mintAppEmbedToken("b"))
  })
})

describe("stableAppEmbedToken (the tool-result refresh token)", () => {
  it("is memoized per app id, so repeated tool calls don't grow the registry", () => {
    const first = stableAppEmbedToken("agentproto_session_chat")
    expect(stableAppEmbedToken("agentproto_session_chat")).toBe(first)
    expect(stableAppEmbedToken("agentproto_session_chat")).toBe(first)
  })

  it("validates like any minted token", () => {
    expect(isValidAppEmbedToken(stableAppEmbedToken("app_a"))).toBe(true)
  })

  it("is distinct per app id", () => {
    expect(stableAppEmbedToken("app_b")).not.toBe(stableAppEmbedToken("app_c"))
  })
})
