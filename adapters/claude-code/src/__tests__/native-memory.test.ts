import { describe, expect, it } from "vitest"
import { claudeCode } from "../index.js"

describe("claude-code AIP-72 memory capability", () => {
  it("declares native-dir inject and native-dir-diff capture", () => {
    expect(claudeCode.capabilities?.memory).toEqual({ inject: "native-dir", capture: "native-dir-diff" })
  })
  it("keeps a system-prompt channel for the fallback digest", () => {
    expect(claudeCode.systemPrompt?.via).toBe("acp-meta")
  })
})
