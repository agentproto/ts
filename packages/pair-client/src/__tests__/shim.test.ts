import { describe, expect, it } from "vitest"
import { inspectOffer as oldInspectOffer } from "@agentproto/pair-client"
import { inspectOffer as newInspectOffer } from "@agentproto/pairing"

describe("@agentproto/pair-client shim", () => {
  it("re-exports the same named export object as @agentproto/pairing", () => {
    expect(oldInspectOffer).toBe(newInspectOffer)
  })
})
