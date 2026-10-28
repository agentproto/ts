import { describe, expect, it } from "vitest"
import type { AgentDefinition, MemoryConfig } from "../types.js"

describe("MemoryConfig (AIP-42 memory block)", () => {
  it("types the AIP-72 binding next to the conversation-history knobs", () => {
    const memory: MemoryConfig = {
      enabled: true,
      store: "./memory",
      anchors: ["global", "project:acme"],
      scope: "per-thread",
    }
    const def: Pick<AgentDefinition, "memory"> = { memory }
    expect(def.memory?.enabled).toBe(true)
    expect(def.memory?.anchors).toEqual(["global", "project:acme"])
  })
})
