import { describe, it, expect } from "vitest"
import { formatTokens } from "../llm/tokens.js"

describe("formatTokens", () => {
  it("renders millions, thousands, and raw values readably", () => {
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(200_000)).toBe("200k")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(1_000)).toBe("1k")
    expect(formatTokens(448)).toBe("448")
    // 2^20 exactly — the decimal form keeps a decimal digit (1.0M, not 1M)
    expect(formatTokens(1_048_576)).toBe("1.0M")
    expect(formatTokens(131_072)).toBe("131.1k")
  })

  it("returns null for undefined/zero/negative so output omits rather than fabricates", () => {
    expect(formatTokens(undefined)).toBeNull()
    expect(formatTokens(0)).toBeNull()
    expect(formatTokens(-5)).toBeNull()
  })
})
