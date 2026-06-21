/**
 * Tests for `jsonTolerant` — the preprocess wrapper that lets MCP clients
 * which stringify union/object/array params (the cowork client) still pass
 * the daemon's strict zod validation.
 *
 * The schemas below mirror the REAL fields they protect:
 *   - `orchestrator` on start_agent_session: z.union([boolean, object])
 *   - `gate` on attach_policy: z.object({...})
 * so the tests prove the actual wire-shapes are accepted, not a toy schema.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"

import { jsonTolerant, tryParseJson } from "../json-tolerant.js"

// Mirrors start_agent_session.orchestrator (union boolean | object).
const orchestratorSchema = jsonTolerant(
  z.union([
    z.boolean(),
    z.object({
      tools: z.array(z.string()).optional(),
      maxDepth: z.number().int().min(1).max(8).optional(),
    }),
  ]),
)

// Mirrors attach_policy.gate (object).
const gateSchema = jsonTolerant(
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }),
)

describe("tryParseJson", () => {
  it("parses valid JSON", () => {
    expect(tryParseJson("true")).toBe(true)
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("returns the original string when JSON is invalid", () => {
    expect(tryParseJson("not json")).toBe("not json")
    expect(tryParseJson("{unquoted}")).toBe("{unquoted}")
  })
})

describe("jsonTolerant — orchestrator union", () => {
  it("(a) coerces stringified boolean 'true' → true", () => {
    const r = orchestratorSchema.safeParse("true")
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe(true)
  })

  it("(b) coerces stringified object → parsed object", () => {
    const r = orchestratorSchema.safeParse('{"tools":["x"]}')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ tools: ["x"] })
  })

  it("(c) leaves a real boolean untouched (semantics unchanged)", () => {
    const r = orchestratorSchema.safeParse(true)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe(true)
  })

  it("leaves a real object untouched", () => {
    const r = orchestratorSchema.safeParse({ tools: ["a", "b"], maxDepth: 2 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ tools: ["a", "b"], maxDepth: 2 })
  })

  it("(d) a non-JSON string fails with a readable validation error (no crash)", () => {
    const r = orchestratorSchema.safeParse("definitely-not-json")
    expect(r.success).toBe(false)
    if (!r.success) {
      // The string flows through untouched → the union reports the real
      // type mismatch, not an opaque parse crash.
      expect(r.error.issues.length).toBeGreaterThan(0)
      expect(r.error.issues[0]?.code).toBe("invalid_union")
    }
  })

  it("a string that parses to the WRONG type still fails the inner schema", () => {
    // "42" → 42 (number), which is neither boolean nor the object shape.
    const r = orchestratorSchema.safeParse("42")
    expect(r.success).toBe(false)
  })
})

describe("jsonTolerant — gate object", () => {
  it("coerces a stringified gate object", () => {
    const r = gateSchema.safeParse('{"command":"pnpm","args":["test"]}')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ command: "pnpm", args: ["test"] })
  })

  it("leaves a real gate object untouched", () => {
    const r = gateSchema.safeParse({ command: "pnpm" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ command: "pnpm" })
  })

  it("a stringified object that violates the inner schema fails readably", () => {
    // Empty command violates .min(1) — the parsed object reaches the inner
    // schema and produces the normal field-level error.
    const r = gateSchema.safeParse('{"command":""}')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(
        r.error.issues.some((i: z.core.$ZodIssue) => i.path.includes("command")),
      ).toBe(true)
    }
  })
})
