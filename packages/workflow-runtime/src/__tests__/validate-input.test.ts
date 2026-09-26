/**
 * AIP-16 says a workflow's `inputs` block is JSON Schema, but most existing
 * WORKFLOW.md authors write the shorthand flat map instead (`inputs: { url:
 * { type, description, default } }` — see `youtube-transcriber`'s
 * `transcribe/WORKFLOW.md`). These tests pin the normalization rule: a
 * shorthand property only becomes required when it explicitly opts in
 * (`required: true`) AND declares no `default` — so normalizing an
 * existing manifest that never used the marker never newly breaks it.
 */

import { describe, expect, it } from "vitest"
import { normalizeWorkflowInputsSchema, validateWorkflowInput } from "../validate-input.js"

describe("normalizeWorkflowInputsSchema", () => {
  it("passes an already-canonical JSON Schema object through unchanged", () => {
    const schema = {
      type: "object",
      properties: { productUrl: { type: "string", format: "uri" } },
      required: ["productUrl"],
    }
    expect(normalizeWorkflowInputsSchema(schema)).toBe(schema)
  })

  it("lifts a shorthand property with required:true and no default into required[]", () => {
    const normalized = normalizeWorkflowInputsSchema({
      url: { type: "string", description: "YouTube video URL", required: true },
    })
    expect(normalized).toEqual({
      type: "object",
      properties: { url: { type: "string", description: "YouTube video URL" } },
      required: ["url"],
    })
  })

  it("does NOT require a shorthand property with required:true that also has a default", () => {
    const normalized = normalizeWorkflowInputsSchema({
      language: { type: "string", default: "en", required: true },
    })
    expect(normalized).toEqual({
      type: "object",
      properties: { language: { type: "string", default: "en" } },
    })
  })

  it("leaves a shorthand property with no 'required' marker optional (no regression for existing manifests)", () => {
    // Same shape as youtube-transcriber's transcribe/WORKFLOW.md: none of
    // its shorthand properties set `required` today.
    const normalized = normalizeWorkflowInputsSchema({
      url: { type: "string", description: "YouTube video URL" },
      language: { type: "string", default: "en" },
      exportPdf: { type: "boolean", default: false },
    })
    expect(normalized["required"]).toBeUndefined()
  })

  it("treats a missing/non-object inputs field as an empty object schema", () => {
    expect(normalizeWorkflowInputsSchema(undefined)).toEqual({ type: "object", properties: {} })
  })
})

describe("validateWorkflowInput", () => {
  it("accepts input satisfying a canonical JSON Schema", () => {
    const schema = {
      type: "object",
      properties: { productUrl: { type: "string" } },
      required: ["productUrl"],
    }
    const result = validateWorkflowInput(schema, { productUrl: "https://example.com" })
    expect(result.valid).toBe(true)
  })

  it("rejects missing required input with code invalid-input, naming the field", () => {
    const schema = {
      type: "object",
      properties: { productUrl: { type: "string", format: "uri" } },
      required: ["productUrl"],
    }
    const result = validateWorkflowInput(schema, {})
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.code).toBe("invalid-input")
    expect(result.fields).toEqual(["productUrl"])
    expect(result.message).toContain("productUrl")
  })

  it("names every missing/invalid field when more than one fails", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    }
    const result = validateWorkflowInput(schema, {})
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect([...result.fields].sort()).toEqual(["a", "b"])
  })

  it("does not require a shorthand property that never opted into required (backward-compat)", () => {
    // youtube-transcriber-shaped shorthand: an empty input still validates,
    // preserving today's behaviour for manifests that never set `required`.
    const shorthand = {
      url: { type: "string", description: "YouTube video URL" },
      language: { type: "string", default: "en" },
    }
    const result = validateWorkflowInput(shorthand, {})
    expect(result.valid).toBe(true)
  })

  it("rejects via the shorthand path once a property opts into required:true", () => {
    const shorthand = {
      url: { type: "string", required: true },
    }
    const result = validateWorkflowInput(shorthand, {})
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.fields).toEqual(["url"])
  })
})
