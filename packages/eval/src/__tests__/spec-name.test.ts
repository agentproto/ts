import { describe, expect, it } from "vitest"
import { EVAL_FORMAT } from "../index.js"

describe("eval format identity", () => {
  it("exposes the internal format id", () => {
    expect(EVAL_FORMAT).toBe("agentproto.eval/v1")
  })
})
