import { describe, expect, it } from "vitest"
import { CORPUS_FORMAT } from "../index.js"

describe("corpus format identity", () => {
  it("exposes the internal format id", () => {
    expect(CORPUS_FORMAT).toBe("agentproto.corpus/v1")
  })
})
