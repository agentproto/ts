import { describe, expect, it } from "vitest"
import { defineApp as oldDefineApp } from "@agentproto/app-kit"
import { defineApp as newDefineApp } from "@agentproto/app"

describe("@agentproto/app-kit shim", () => {
  it("re-exports the same defineApp as @agentproto/app", () => {
    expect(oldDefineApp).toBe(newDefineApp)
  })
})
