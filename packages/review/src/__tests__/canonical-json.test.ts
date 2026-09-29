import { describe, it, expect } from "vitest"
import { canonicalJson } from "../canonical-json.js"

describe("canonicalJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it("sorts keys recursively, at every nesting depth", () => {
    const x = { z: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] }
    const y = { a: [{ x: 2, y: 1 }], z: { c: 2, d: 1 } }
    expect(canonicalJson(x)).toBe(canonicalJson(y))
    expect(canonicalJson(x)).toBe('{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}')
  })

  it("keeps array order — arrays are never sorted", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]))
  })

  it("drops `undefined` object properties, same as JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it("turns an `undefined` array element into null, same as JSON.stringify", () => {
    expect(canonicalJson([1, undefined, 2])).toBe(JSON.stringify([1, undefined, 2]))
  })

  it("is stable for unicode content", () => {
    const value = { emoji: "🎉", accented: "café", cjk: "日本語" }
    const bytes = canonicalJson(value)
    expect(canonicalJson(JSON.parse(bytes))).toBe(bytes)
    expect(JSON.parse(bytes)).toEqual(value)
  })

  it("produces no whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).not.toMatch(/\s/)
  })

  it("round-trips through JSON.parse to an equal value", () => {
    const value = { z: 1, a: [1, { c: 3, b: 2 }], n: null, s: "x\"y" }
    expect(JSON.parse(canonicalJson(value))).toEqual(value)
  })
})
