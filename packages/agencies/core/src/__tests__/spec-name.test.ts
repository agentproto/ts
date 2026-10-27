import { describe, expect, it } from "vitest"
import { AGENCIES_FORMAT } from "../index.js"

describe("agencies format identity", () => {
  it("exposes the internal format id", () => {
    expect(AGENCIES_FORMAT).toBe("agentagencies/v1")
  })
})
