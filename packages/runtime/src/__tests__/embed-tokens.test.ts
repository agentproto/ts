import { describe, expect, it } from "vitest"
import { isValidAppEmbedToken, mintAppEmbedToken } from "../embed-tokens.js"

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
