import { describe, expect, it } from "vitest"
import {
  BatchValidationError,
  assertUniqueCustomIds,
  expiredCustomIds,
  validateBatchRequests,
  validateForBatch,
  type BatchRequest,
  type BatchResult,
  type MessagesBody,
} from "../types.js"

function request(overrides: Partial<MessagesBody> = {}, customId = "r1"): BatchRequest {
  return {
    customId,
    body: {
      model: "claude-sonnet-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      ...overrides,
    },
  }
}

describe("validateForBatch", () => {
  it("accepts a plain valid request", () => {
    expect(() => validateForBatch(request())).not.toThrow()
  })

  it("rejects stream, naming the custom_id", () => {
    expect(() => validateForBatch(request({ stream: true }, "custom-1"))).toThrow(
      BatchValidationError,
    )
    expect(() => validateForBatch(request({ stream: true }, "custom-1"))).toThrow(/"custom-1"/)
  })

  it("rejects speed", () => {
    expect(() => validateForBatch(request({ speed: "fast" }))).toThrow(/speed/)
  })

  it("rejects fallbacks", () => {
    expect(() => validateForBatch(request({ fallbacks: ["m2"] }))).toThrow(/fallbacks/)
  })

  it("rejects max_tokens < 1", () => {
    expect(() => validateForBatch(request({ max_tokens: 0 }))).toThrow(/max_tokens/)
  })

  it("rejects a forced tool_choice of any or tool", () => {
    expect(() => validateForBatch(request({ tool_choice: { type: "any" } }))).toThrow(
      /tool_choice/,
    )
    expect(() => validateForBatch(request({ tool_choice: { type: "tool" } }))).toThrow(
      /tool_choice/,
    )
  })

  it("allows tool_choice auto", () => {
    expect(() => validateForBatch(request({ tool_choice: { type: "auto" } }))).not.toThrow()
  })
})

describe("assertUniqueCustomIds / validateBatchRequests", () => {
  it("rejects duplicate customIds", () => {
    const requests = [request({}, "dup"), request({}, "dup")]
    expect(() => assertUniqueCustomIds(requests)).toThrow(/duplicate customId "dup"/)
    expect(() => validateBatchRequests(requests)).toThrow(/duplicate customId/)
  })

  it("passes through unique, batch-valid requests", () => {
    const requests = [request({}, "a"), request({}, "b")]
    expect(() => validateBatchRequests(requests)).not.toThrow()
  })

  it("still catches a per-request violation once uniqueness passes", () => {
    const requests = [request({}, "a"), request({ stream: true }, "b")]
    expect(() => validateBatchRequests(requests)).toThrow(/"b"/)
  })
})

describe("expiredCustomIds", () => {
  it("returns only expired outcomes, in order", () => {
    const results: BatchResult[] = [
      { customId: "a", outcome: "succeeded" },
      { customId: "b", outcome: "expired" },
      { customId: "c", outcome: "expired" },
      { customId: "d", outcome: "errored" },
    ]
    expect(expiredCustomIds(results)).toEqual(["b", "c"])
  })

  it("returns an empty array when nothing expired", () => {
    expect(expiredCustomIds([{ customId: "a", outcome: "succeeded" }])).toEqual([])
  })
})
