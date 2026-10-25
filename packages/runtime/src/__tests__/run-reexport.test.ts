import { describe, expect, it } from "vitest"

import { SPEC_NAME, createFileStepCache } from "@agentproto/run"
import * as runtime from "../index.js"

describe("@agentproto/runtime run re-exports", () => {
  it("comes from the AIP-58 package", () => {
    expect(SPEC_NAME).toBe("run/v1")
  })

  it("keeps runtime's public run surface", () => {
    expect(runtime.createFileStepCache).toBe(createFileStepCache)
  })
})
