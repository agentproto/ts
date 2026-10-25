import { describe, expect, it } from "vitest"
import { AGENCIES_FORMAT, SPEC_NAME } from "../index.js"

describe("agencies format identity", () => {
  it("exposes the internal format id", () => {
    expect(AGENCIES_FORMAT).toBe("agentagencies/v1")
  })

  it("keeps the legacy SPEC_NAME for compatibility", () => {
    expect(SPEC_NAME).toBe("agentagencies/v1")
    expect(SPEC_NAME).toBe(AGENCIES_FORMAT)
  })
})
