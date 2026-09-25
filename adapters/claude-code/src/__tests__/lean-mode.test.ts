import { describe, expect, it } from "vitest"
import { claudeCode } from "../index.js"

describe("claude-code `lean` context mode", () => {
  const lean = claudeCode.modes?.find(m => m.id === "lean")

  it("exists as a context-kind mode", () => {
    expect(lean).toBeDefined()
    expect(lean?.kind).toBe("context")
  })

  it("drops bundled skills AND turns on Claude Code's own native MCP tool-search", () => {
    // Both env-only — see the module doc for why ENABLE_TOOL_SEARCH is safe
    // to set unconditionally (worst case: an unrecognized env var an older
    // claude binary already ignores).
    expect(lean?.env).toEqual({
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
      ENABLE_TOOL_SEARCH: "1",
    })
  })
})
