import { describe, expect, it } from "vitest"
import { SPEC_NAME } from "../src/index.js"

describe("AIP-70 spec name", () => {
  it("matches the registry", () => {
    expect(SPEC_NAME).toBe("pack/v1")
  })
})
