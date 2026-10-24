import { describe, expect, it } from "vitest"
import { CATALOG_FORMAT, SPEC_NAME } from "../index.js"

describe("catalog format identity", () => {
  it("keeps the legacy SPEC_NAME for compatibility", () => {
    expect(SPEC_NAME).toBe("agentcatalog/v1")
  })

  it("exposes the internal format id", () => {
    expect(CATALOG_FORMAT).toBe("agentproto.catalog/v1")
  })
})
