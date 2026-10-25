import { describe, expect, it } from "vitest"

import { SPEC_NAME, decide } from "@agentproto/decision"
import * as runtime from "../index.js"

describe("@agentproto/runtime decision re-exports", () => {
  it("comes from the AIP-65 package", () => {
    expect(SPEC_NAME).toBe("decision/v1")
  })

  it("keeps runtime's public decision surface", () => {
    expect(runtime.decide).toBe(decide)
  })
})
