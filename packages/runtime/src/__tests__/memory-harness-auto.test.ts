import { describe, expect, it } from "vitest"
import { shouldDisableNativeMemory } from "../memory-stores.js"

describe("shouldDisableNativeMemory", () => {
  it("never switches auto memory off for a session that has a projection", async () => {
    expect(await shouldDisableNativeMemory(true)).toBe(false)
  })
})
