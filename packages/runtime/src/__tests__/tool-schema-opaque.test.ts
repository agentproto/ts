/**
 * Unit tests for `opaqueSchema` — the `tools/list` slimming wrapper that keeps
 * a nested field's real validation AND its real parsed output (see
 * tool-schema-opaque.ts). The bug this guards: an opaque wrapper that
 * advertised correctly but passed the RAW value through, so transforms
 * (`browser: true` → "headless"), defaults and unknown-key stripping silently
 * stopped applying.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"

import { opaqueSchema } from "../tool-schema-opaque.js"
import { agentStartInputSchema } from "../agent-start-schema.js"

describe("opaqueSchema", () => {
  it("returns the real schema's parsed output (preprocess applied)", () => {
    const real = z.preprocess(
      v => (v === true || v === "true" ? "headless" : v === "false" ? false : v),
      z.union([z.literal("headless"), z.literal(false)]),
    )
    const schema = opaqueSchema(real)
    expect(schema.parse(true)).toBe("headless")
    expect(schema.parse("true")).toBe("headless")
    expect(schema.parse(false)).toBe(false)
    expect(schema.parse("false")).toBe(false)
  })

  it("strips keys the real object schema does not declare", () => {
    const schema = opaqueSchema(z.object({ a: z.string() }))
    expect(schema.parse({ a: "x", b: "y" })).toEqual({ a: "x" })
  })

  it("forwards the real schema's issue path and message on failure", () => {
    const schema = opaqueSchema(z.object({ profileRef: z.string().min(1) }))
    const result = schema.safeParse({ profileRef: "" })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("unreachable")
    expect(result.error.issues[0]?.path).toEqual(["profileRef"])
    expect(result.error.issues[0]?.message.length).toBeGreaterThan(0)
  })

  it("still advertises as an opaque value (no sub-fields) in JSON Schema", () => {
    const json = z.toJSONSchema(
      z.object({ opt: opaqueSchema(z.object({ a: z.string() })) }),
      { io: "input" },
    )
    const opt = (json.properties as Record<string, Record<string, unknown>>).opt
    expect(opt).not.toHaveProperty("properties")
    expect(opt).not.toHaveProperty("anyOf")
  })
})

describe("agent_start browser opaque field", () => {
  it("normalizes true to the only mode through the whole input schema", () => {
    expect(agentStartInputSchema.parse({ browser: true }).browser).toBe("headless")
  })

  it("leaves false as false and rejects other values", () => {
    expect(agentStartInputSchema.parse({ browser: false }).browser).toBe(false)
    expect(agentStartInputSchema.safeParse({ browser: "chromium" }).success).toBe(false)
  })
})
