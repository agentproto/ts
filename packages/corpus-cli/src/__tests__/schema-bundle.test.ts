import { CorpusValidator } from "@agentproto/corpus"
import { describe, expect, it } from "vitest"
import { loadAipSchemaBundle } from "../commands/_shared.js"

describe("loadAipSchemaBundle", () => {
  it("registers every schema the vendored doctypes $ref, so the validator compiles", () => {
    expect(() => new CorpusValidator({ bundle: loadAipSchemaBundle() })).not.toThrow()
  })
})
