import { describe, it, expect } from "vitest"
import { jsonSchemaToZod } from "../json-schema-to-zod.js"

describe("jsonSchemaToZod", () => {
  it("converts object/string/number/boolean/array/required", () => {
    const zodType = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    })
    expect(zodType.safeParse({ name: "a", tags: ["x"] }).success).toBe(true)
    expect(zodType.safeParse({ age: 1 }).success).toBe(false) // missing required `name`
    expect(zodType.safeParse({ name: "a", age: "not a number" }).success).toBe(false)
  })

  it("converts a string-only top-level enum", () => {
    const zodType = jsonSchemaToZod({ enum: ["formal", "casual"] })
    expect(zodType.safeParse("formal").success).toBe(true)
    expect(zodType.safeParse("sarcastic").success).toBe(false)
  })

  it("preserves unknown/extra object keys instead of stripping them (loose, not strict)", () => {
    const zodType = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } } })
    const result = zodType.safeParse({ a: "x", extra: 123 })
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({ a: "x", extra: 123 })
  })

  it("falls back to z.any() for unsupported shapes (oneOf/anyOf/$ref/mixed enum) and non-objects", () => {
    expect(jsonSchemaToZod({ oneOf: [{ type: "string" }, { type: "number" }] }).safeParse(42).success).toBe(true)
    expect(jsonSchemaToZod({ enum: ["a", 1] }).safeParse("anything").success).toBe(true)
    expect(jsonSchemaToZod(undefined).safeParse("anything").success).toBe(true)
    expect(jsonSchemaToZod(null).safeParse("anything").success).toBe(true)
  })

  it("integer and number both map to z.number()", () => {
    expect(jsonSchemaToZod({ type: "integer" }).safeParse(3).success).toBe(true)
    expect(jsonSchemaToZod({ type: "number" }).safeParse(3.5).success).toBe(true)
  })
})
