import { describe, it, expect } from "vitest"
import { z } from "zod"
import { parseToolManifest, toolFromManifest } from "../manifest/index.js"

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
