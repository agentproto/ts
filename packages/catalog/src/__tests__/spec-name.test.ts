import { describe, expect, it } from "vitest"
import { CATALOG_FORMAT } from "../index.js"

describe("catalog format identity", () => {
  it("exposes the internal format id", () => {
    expect(CATALOG_FORMAT).toBe("agentproto.catalog/v1")
  })
})
