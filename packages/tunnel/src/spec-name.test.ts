import { describe, expect, it } from "vitest"
import { SPEC_NAME } from "./index.js"

describe("tunnel spec identity", () => {
  it("names the AIP-73 spec id the names registry records", () => {
    expect(SPEC_NAME).toBe("tunnel/v1")
  })
})
