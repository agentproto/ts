import { describe, expect, it } from "vitest"
import { EVAL_FORMAT, SPEC_NAME } from "../index.js"

describe("eval format identity", () => {
  it("keeps the legacy SPEC_NAME for compatibility", () => {
    expect(SPEC_NAME).toBe("agenteval/v1")
  })

  it("exposes the internal format id", () => {
    expect(EVAL_FORMAT).toBe("agentproto.eval/v1")
  })
})
