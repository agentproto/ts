import { describe, expect, it } from "vitest"
import { buildMastraAgent as oldBuildMastraAgent } from "@agentproto/mastra"
import { buildMastraAgent as newBuildMastraAgent } from "@agentproto/bridge"

describe("@agentproto/mastra shim", () => {
  it("re-exports the same buildMastraAgent as @agentproto/bridge", () => {
    expect(oldBuildMastraAgent).toBe(newBuildMastraAgent)
  })
})
