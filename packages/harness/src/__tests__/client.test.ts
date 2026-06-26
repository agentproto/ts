import { describe, it, expect } from "vitest"

describe("isError guard logic", () => {
  it("throws before JSON.parse when isError is true", () => {
    // Inline the guard logic from #call for isolated testing
    function callGuard(res: {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }) {
      const text = res.content[0]?.text
      if (!text) throw new Error("Empty response")
      if (res.isError) throw new Error(`Tool returned error: ${text}`)
      return JSON.parse(text)
    }

    expect(() =>
      callGuard({
        isError: true,
        content: [{ type: "text", text: "session not found" }],
      }),
    ).toThrow("Tool returned error: session not found")

    expect(() =>
      callGuard({
        isError: false,
        content: [{ type: "text", text: '{"id":"sess_1"}' }],
      }),
    ).not.toThrow()

    expect(
      callGuard({
        content: [{ type: "text", text: '{"id":"sess_1"}' }],
      }),
    ).toEqual({ id: "sess_1" })
  })

  it("throws on empty content", () => {
    function callGuard(res: {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }) {
      const text = res.content[0]?.text
      if (!text) throw new Error("Empty response")
      if (res.isError) throw new Error(`Tool returned error: ${text}`)
      return JSON.parse(text)
    }

    expect(() =>
      callGuard({
        content: [{ type: "text", text: "" }],
      }),
    ).toThrow("Empty response")
  })
})