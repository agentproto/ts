import { describe, expect, it } from "vitest"

import { SPEC_NAME, createClerkPassRunner, createClerkTurnEndController } from "@agentproto/clerk"
import * as runtime from "../index.js"

describe("@agentproto/runtime clerk re-exports", () => {
  it("comes from the AIP-68 package", () => {
    expect(SPEC_NAME).toBe("clerk/v1")
  })

  it("keeps runtime's public clerk surface", () => {
    expect(runtime.createClerkTurnEndController).toBe(createClerkTurnEndController)
    expect(runtime.createClerkPassRunner).toBe(createClerkPassRunner)
  })
})
