import { describe, expect, it } from "vitest"
import { start as oldStart } from "@agentproto/llm-endpoint"
import { start as newStart } from "@agentproto/inference-endpoint"

describe("@agentproto/llm-endpoint shim", () => {
  it("re-exports the same start function as @agentproto/inference-endpoint", () => {
    expect(oldStart).toBe(newStart)
  })
})
