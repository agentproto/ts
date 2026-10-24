import { describe, expect, it } from "vitest"
import * as oldPkg from "@agentproto/define-doctype"
import * as neuPkg from "@agentproto/doctype"

describe("@agentproto/define-doctype shim", () => {
  it("re-exports createDoctype from @agentproto/doctype unchanged", () => {
    expect(oldPkg.createDoctype).toBe(neuPkg.createDoctype)
  })
})
