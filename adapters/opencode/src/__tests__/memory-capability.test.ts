import { describe, expect, it } from "vitest"
import { opencode } from "../index.js"

// AIP-72 section 9: an adapter that declares no memory capability reads as
// `inject: "none"` and gets no digest, so this one declares the
// system-prompt path its channel can carry.
describe("opencode AIP-72 memory capability", () => {
  it("declares system-prompt inject and no capture", () => {
    expect(opencode.capabilities?.memory).toEqual({ inject: "system-prompt", capture: "none" })
  })
  it("has the system-prompt channel the digest rides", () => {
    expect(opencode.systemPrompt?.via).toBe("inline-config")
  })
})
