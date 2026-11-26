import { describe, it, expect } from "vitest"
import { z } from "zod"
import { toolSpec, toolVerbs } from "../spec.js"
import { parseToolManifest } from "../manifest/index.js"
import type { ToolDefinition } from "../types.js"

// `createVerbs.load` flows a parsed manifest through `toolSpec.parse` →
// `toolSpec.define`. These tests pin the snake_case → camelCase surfacing so
// authored `risk_level` / `cost_class` / `timeout_ms` reach the handle instead
// of silently falling back to `defineTool`'s defaults.

const defineFromSource = (src: string) =>
  toolSpec.define(
    toolSpec.parse(src).frontmatter as unknown as ToolDefinition<
      unknown,
      unknown
    >,
  )

const FULL_MD = `---
schema: agentproto/tool/v1
id: url-summarize
name: URL Summarize
description: Fetches a public URL and returns a concise summary of its content.
version: 1.0.0
risk_level: 2
cost_class: metered
timeout_ms: 15000
mutates: []
approval: auto
idempotent: true
tags: [web, example]
inputs:
  type: object
  required: [url]
  properties:
    url:
      type: string
      format: uri
outputs:
  type: object
  required: [summary]
  properties:
    summary:
      type: string
---

# URL Summarize
`

const MINIMAL_MD = `---
schema: agentproto/tool/v1
id: bare
name: Bare
description: Minimal tool with no optional metadata declared.
version: 1.0.0
---

# Bare
`

describe("toolSpec.parse → define round-trip", () => {
  it("surfaces snake_case meta fields into the camelCase handle", () => {
    const handle = defineFromSource(FULL_MD)
    expect(handle.riskLevel).toBe(2)
    expect(handle.costClass).toBe("metered")
    expect(handle.timeoutMs).toBe(15000)
    // single-word fields already worked — guard against regression
    expect(handle.approval).toBe("auto")
    expect(handle.idempotent).toBe(true)
    expect(handle.tags).toEqual(["web", "example"])
  })

  it("carries AIP-16 inputs/outputs JSON Schema onto the handle", () => {
    const handle = defineFromSource(FULL_MD)
    expect(handle.inputs).toEqual({
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", format: "uri" } },
    })
    expect(handle.outputs).toEqual({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    })
  })

  it("leaves inputs/outputs undefined when the manifest omits them", () => {
    const handle = defineFromSource(MINIMAL_MD)
    expect(handle.inputs).toBeUndefined()
    expect(handle.outputs).toBeUndefined()
  })

  it("falls back to defaults when optional meta is absent", () => {
    const handle = defineFromSource(MINIMAL_MD)
    expect(handle.riskLevel).toBe(0)
    expect(handle.costClass).toBe("trivial")
    expect(handle.timeoutMs).toBe(30_000)
  })
})

describe("toolSpec.toFrontmatter / toolVerbs round-trip", () => {
  it("writes snake_case keys so riskLevel, costClass and timeoutMs survive create -> parse -> define", async () => {
    const created = await toolVerbs.create(
      {
        id: "metrics.fetch",
        name: "Metrics Fetch",
        description: "Reads raw metric entries from a remote source.",
        version: "1.2.0",
        riskLevel: 2,
        costClass: "metered",
        timeoutMs: 12_000,
        mutates: [],
        approval: "auto",
        idempotent: true,
        requires: { network: ["api.example.com"], secrets: ["API_KEY"] },
        tags: ["metrics", "read"],
        metadata: { category: "analytics" },
        inputs: {
          type: "object",
          required: ["start"],
          properties: { start: { type: "integer" } },
        },
        outputs: {
          type: "array",
          items: { type: "object", properties: { amount: { type: "number" } } },
        },
      },
      { dir: ".", dryRun: true },
    )

    expect(created.rendered).toContain("risk_level: 2")
    expect(created.rendered).toContain("cost_class: metered")
    expect(created.rendered).toContain("timeout_ms: 12000")
    expect(created.rendered).not.toContain("riskLevel:")
    expect(created.rendered).not.toContain("costClass:")
    expect(created.rendered).not.toContain("timeoutMs:")

    const parsed = parseToolManifest(created.rendered)
    expect(parsed.frontmatter.risk_level).toBe(2)
    expect(parsed.frontmatter.cost_class).toBe("metered")
    expect(parsed.frontmatter.timeout_ms).toBe(12_000)

    const reloaded = defineFromSource(created.rendered)
    expect(reloaded.riskLevel).toBe(2)
    expect(reloaded.costClass).toBe("metered")
    expect(reloaded.timeoutMs).toBe(12_000)
    expect(reloaded.requires).toEqual({
      network: ["api.example.com"],
      secrets: ["API_KEY"],
      tools: [],
    })
    expect(reloaded.inputs).toEqual({
      type: "object",
      required: ["start"],
      properties: { start: { type: "integer" } },
    })
  })

  it("serializes Zod inputSchema/outputSchema to inline JSON Schema when raw inputs/outputs are omitted", async () => {
    const created = await toolVerbs.create(
      {
        id: "zod.roundtrip",
        name: "Zod Roundtrip",
        description: "Preserves Zod IO schemas into TOOL.md JSON Schema.",
        version: "1.0.0",
        inputSchema: z.object({ since: z.number().int() }),
        outputSchema: z.object({ total: z.number() }),
      },
      { dir: ".", dryRun: true },
    )

    const parsed = parseToolManifest(created.rendered)
    expect(parsed.frontmatter.inputs).toMatchObject({
      type: "object",
      required: ["since"],
    })
    expect(parsed.frontmatter.outputs).toMatchObject({
      type: "object",
      required: ["total"],
    })
  })
})
