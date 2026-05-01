import { describe, it, expect } from "vitest"
import { ToolError, toToolError, toToolResult } from "../errors.js"

describe("ToolError", () => {
  it("carries the structured payload", () => {
    const err = new ToolError({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    })
    expect(err.code).toBe("rate_limited")
    expect(err.retryable).toBe(true)
    expect(err.message).toBe("slow down")
    expect(err.toJSON()).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    })
  })

  it("defaults retryable to false", () => {
    const err = new ToolError({ code: "internal", message: "oops" })
    expect(err.retryable).toBe(false)
  })
})

describe("toToolError", () => {
  it("passes through ToolError", () => {
    const original = new ToolError({ code: "not_found", message: "no" })
    expect(toToolError(original)).toBe(original)
  })

  it("wraps a plain Error", () => {
    const wrapped = toToolError(new Error("boom"))
    expect(wrapped).toBeInstanceOf(ToolError)
    expect(wrapped.code).toBe("internal")
    expect(wrapped.message).toBe("boom")
  })

  it("wraps non-Error throws", () => {
    const wrapped = toToolError("string-thrown")
    expect(wrapped.code).toBe("internal")
    expect(wrapped.message).toBe("string-thrown")
  })
})

describe("toToolResult", () => {
  it("wraps success value", () => {
    expect(toToolResult({ foo: 1 }, undefined)).toEqual({
      ok: true,
      value: { foo: 1 },
    })
  })

  it("wraps thrown value into error envelope", () => {
    const err = new ToolError({ code: "timeout", message: "30s" })
    const result = toToolResult(undefined, err)
    expect(result).toEqual({
      ok: false,
      error: { code: "timeout", message: "30s", retryable: false },
    })
  })
})
