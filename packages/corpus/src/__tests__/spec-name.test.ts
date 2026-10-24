import { describe, expect, it } from "vitest"
import { CORPUS_FORMAT, SPEC_NAME } from "../index.js"

describe("corpus format identity", () => {
  it("keeps the legacy SPEC_NAME for compatibility", () => {
    expect(SPEC_NAME).toBe("agentcorpus/v1")
  })

  it("exposes the internal format id", () => {
    expect(CORPUS_FORMAT).toBe("agentproto.corpus/v1")
  })
})
