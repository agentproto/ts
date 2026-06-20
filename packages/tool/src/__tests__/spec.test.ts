import { describe, it, expect } from "vitest"
import { toolSpec } from "../spec.js"
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
