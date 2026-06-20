import { describe, it, expect } from "vitest"
import { z } from "zod"
import { parseToolManifest, toolFromManifest, toolFromManifestOnly } from "../manifest/index.js"
import { validateInput, validateOutput } from "../define-tool.js"
import { ToolError } from "../errors.js"

const SAMPLE_MD = `---
schema: agentproto/tool/v1
name: Echo
id: echo
description: Returns its input verbatim.
version: 1.0.0
mutates: ["fs:read"]
approval: on-mutate
risk_level: 1
cost_class: trivial
timeout_ms: 5000
idempotent: true
tags: [example, fs]
metadata:
  vendor.namespace: anything
---

# Echo
Body content here.
`

describe("toolFromManifest", () => {
  it("produces a typed handle from manifest + caller-supplied schemas", () => {
    const manifest = parseToolManifest(SAMPLE_MD)
    const tool = toolFromManifest({
      manifest,
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ msg: z.string() }),
    })

    // Identity / metadata flow from the .md.
    expect(tool.id).toBe("echo")
    expect(tool.name).toBe("Echo")
    expect(tool.description).toBe("Returns its input verbatim.")
    expect(tool.version).toBe("1.0.0")
    expect(tool.mutates).toEqual(["fs:read"])
    expect(tool.approval).toBe("on-mutate")
    expect(tool.riskLevel).toBe(1)
    expect(tool.costClass).toBe("trivial")
    expect(tool.timeoutMs).toBe(5000)
    expect(tool.idempotent).toBe(true)
    expect(tool.tags).toEqual(["example", "fs"])
    expect(tool.metadata).toEqual({ "vendor.namespace": "anything" })

    // Schemas come from the TS module.
    expect(tool.inputSchema!.parse({ msg: "hi" })).toEqual({ msg: "hi" })
    expect(() => tool.inputSchema!.parse({ msg: 7 })).toThrow()
  })

  it("freezes the handle (defineTool invariants apply)", () => {
    const manifest = parseToolManifest(SAMPLE_MD)
    const tool = toolFromManifest({
      manifest,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
    expect(Object.isFrozen(tool)).toBe(true)
  })

  it("accepts an optional contextSchema and surfaces it on the handle", () => {
    const manifest = parseToolManifest(SAMPLE_MD)
    const ctx = z.object({ userId: z.string() })
    const tool = toolFromManifest({
      manifest,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      contextSchema: ctx,
    })
    expect(tool.contextSchema).toBe(ctx)
  })

  it("propagates AIP-16 inputs/outputs onto the handle when declared in the manifest", () => {
    const md = `---
schema: agentproto/tool/v1
name: Calc
id: calc
description: Adds two numbers.
version: 1.0.0
inputs:
  type: object
  properties:
    a: { type: number }
    b: { type: number }
  required: [a, b]
outputs:
  type: object
  properties:
    sum: { type: number }
  required: [sum]
---
`
    const manifest = parseToolManifest(md)
    const tool = toolFromManifest({
      manifest,
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
    })
    expect(tool.inputs).toBeDefined()
    expect((tool.inputs as Record<string, unknown>)["type"]).toBe("object")
    expect(tool.outputs).toBeDefined()
  })

  it("propagates AIP-14 invariants — invalid id (e.g. caps) is rejected by parser, never reaches defineTool", () => {
    const bad = `---
name: Bad
id: HAS_CAPS
description: x
version: 1.0.0
---
`
    expect(() => parseToolManifest(bad)).toThrow(/id/)
  })
})

describe("toolFromManifestOnly", () => {
  const MANIFEST_ONLY_MD = `---
schema: agentproto/tool/v1
name: Calc
id: calc
description: Adds two numbers via JSON Schema IO (no TS module).
version: 1.0.0
inputs:
  type: object
  properties:
    a: { type: number }
    b: { type: number }
  required: [a, b]
outputs:
  type: object
  properties:
    sum: { type: number }
  required: [sum]
---
`

  it("creates a handle without zod schemas, preserving JSON Schema IO", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)

    expect(tool.id).toBe("calc")
    expect(tool.name).toBe("Calc")
    expect(tool.inputSchema).toBeUndefined()
    expect(tool.outputSchema).toBeUndefined()
    expect(tool.inputs).toBeDefined()
    expect(tool.outputs).toBeDefined()
  })

  it("validateInput falls back to JSON Schema and accepts valid input", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)
    const result = validateInput(tool, { a: 1, b: 2 })
    expect(result.ok).toBe(true)
  })

  it("validateInput rejects input that violates the JSON Schema", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)
    const result = validateInput(tool, { a: "not-a-number", b: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("input_invalid")
  })

  it("validateOutput falls back to JSON Schema and accepts valid output", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)
    expect(() => validateOutput(tool, { sum: 3 })).not.toThrow()
  })

  it("validateOutput rejects output that violates the JSON Schema", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)
    let err: unknown
    try {
      validateOutput(tool, { sum: "wrong" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe("output_invalid")
  })

  it("handle is frozen (defineTool invariants apply)", () => {
    const manifest = parseToolManifest(MANIFEST_ONLY_MD)
    const tool = toolFromManifestOnly(manifest)
    expect(Object.isFrozen(tool)).toBe(true)
  })
})
