import { describe, expect, it } from "vitest"
import { chainRedactors as oldChainRedactors } from "@agentproto/redaction"
import { chainRedactors as newChainRedactors } from "@agentproto/processor"

describe("@agentproto/redaction shim", () => {
  it("re-exports the same named export object as @agentproto/processor", () => {
    expect(oldChainRedactors).toBe(newChainRedactors)
  })
})
