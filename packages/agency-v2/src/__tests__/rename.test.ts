import { describe, expect, it } from "vitest"
import { defineAgencyV2 } from "@agentproto/agency-v2"
import { defineAgency } from "@agentproto/agency"

describe("@agentproto/agency-v2 shim", () => {
  it("re-exports defineAgencyV2 as the same function as defineAgency", () => {
    expect(defineAgencyV2).toBe(defineAgency)
  })
})
