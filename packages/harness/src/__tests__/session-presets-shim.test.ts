import { describe, expect, it } from "vitest"
import * as oldPackage from "@agentproto/harness"
import * as neuPackage from "@agentproto/session-presets"

describe("@agentproto/harness shim", () => {
  it("re-exports the session presets unchanged", () => {
    expect(oldPackage.connectHarness).toBe(neuPackage.connectHarness)
    expect(oldPackage.createCoderHarness).toBe(neuPackage.createCoderHarness)
  })
})
