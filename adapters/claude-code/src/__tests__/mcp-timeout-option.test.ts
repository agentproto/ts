import { describe, expect, it } from "vitest"
import { claudeCode } from "../index.js"

describe("claude-code `mcp_timeout` option", () => {
  const opt = claudeCode.options?.find(o => o.id === "mcp_timeout")

  it("is a positive integer option", () => {
    expect(opt).toBeDefined()
    expect(opt?.type).toBe("integer")
    expect((opt as { min?: number }).min).toBe(1)
  })

  it("sets MCP_TIMEOUT in the claude process env", () => {
    expect(opt?.env).toEqual({ MCP_TIMEOUT: "{value}" })
  })
})
