import { describe, expect, it } from "vitest"

import { hashJson } from "../fetched-at.mjs"

describe("hashJson", () => {
  it("does not depend on object key order, at any depth", () => {
    const a = { unit: "per_token", priceUsd: 0.00004, nested: { x: 1, y: [{ b: 2, a: 1 }] } }
    const b = { nested: { y: [{ a: 1, b: 2 }], x: 1 }, priceUsd: 0.00004, unit: "per_token" }
    expect(hashJson(a)).toBe(hashJson(b))
  })

  it("still changes when a value or array order changes", () => {
    expect(hashJson({ priceUsd: 1 })).not.toBe(hashJson({ priceUsd: 2 }))
    expect(hashJson({ l: [1, 2] })).not.toBe(hashJson({ l: [2, 1] }))
  })
})
