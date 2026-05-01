import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool, ToolError } from "@agentproto/tool"
import { defineDriver } from "../define-provider.js"
import { runTool, applyMapping } from "../run-tool.js"

describe("runTool — happy path", () => {
  it("dispatches through the resolver and returns validated output", async () => {
    const tool = defineTool({
      id: "uppercase",
      description: "Uppercases.",
      inputSchema: z.object({ s: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    })
    const provider = defineDriver({
      id: "in-process",
      name: "in-process",
      description: "desc",
      kind: "sdk",
      implements: [{ tool: "./tools/uppercase/TOOL.md", version: "^1" }],
      execute: {
        uppercase: ({ input }) => {
          const i = input as { s: string }
          return { result: i.s.toUpperCase() }
        },
      },
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { s: "hi" },
    })
    expect(out).toEqual({ result: "HI" })
  })

  it("validates input against contract before dispatch", async () => {
    const tool = defineTool({
      id: "echo",
      description: "Echo.",
      inputSchema: z.object({ s: z.string() }),
      outputSchema: z.object({ s: z.string() }),
    })
    const provider = defineDriver({
      id: "prov",
      name: "prov",
      description: "desc",
      kind: "sdk",
      implements: [{ tool: "./tools/echo/TOOL.md", version: "^1" }],
      execute: { echo: ({ input }) => input as { s: string } },
    })
    await expect(
      runTool({
        tool,
        candidates: [provider],
        input: { s: 42 } as unknown,
      })
    ).rejects.toMatchObject({ code: "input_invalid" })
  })

  it("validates output against contract after dispatch", async () => {
    const tool = defineTool({
      id: "broken",
      description: "Returns wrong shape.",
      inputSchema: z.object({}),
      outputSchema: z.object({ s: z.string() }),
    })
    const provider = defineDriver({
      id: "prov",
      name: "prov",
      description: "desc",
      kind: "sdk",
      implements: [{ tool: "./tools/broken/TOOL.md", version: "^1" }],
      execute: { broken: () => ({ s: 42 }) },
    })
    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toMatchObject({ code: "output_invalid" })
  })

  it("respects timeout from contract or provider override", async () => {
    const tool = defineTool({
      id: "slow",
      description: "Slow.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      timeoutMs: 50,
    })
    const provider = defineDriver({
      id: "prov",
      name: "prov",
      description: "desc",
      kind: "sdk",
      implements: [{ tool: "./tools/slow/TOOL.md", version: "^1" }],
      execute: {
        slow: ({ signal }) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve({}), 1000)
            signal.addEventListener("abort", () => {
              clearTimeout(t)
              reject(new ToolError({ code: "cancelled", message: "aborted" }))
            })
          }),
      },
    })
    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toBeDefined()
  })
})

describe("applyMapping", () => {
  it("returns input verbatim when no mapping declared", () => {
    expect(applyMapping({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 })
  })

  it("applies identity mapping (rename a key)", () => {
    expect(applyMapping({ prompt: "hi" }, { prompt: "prompt" })).toEqual({
      prompt: "hi",
    })
  })

  it("renames keys", () => {
    expect(applyMapping({ aspect: "16:9" }, { aspect_ratio: "aspect" })).toEqual(
      { aspect_ratio: "16:9" }
    )
  })

  it("supports {from, transform} reference (transform is a hint)", () => {
    expect(
      applyMapping({ aspect: "16:9" }, {
        size: { from: "aspect", transform: "aspect_to_size" },
      })
    ).toEqual({ size: "16:9" })
  })

  it("preserves unmapped keys verbatim", () => {
    expect(
      applyMapping({ prompt: "hi", style: "real", extra: "x" }, {
        artistic_style: "style",
      })
    ).toEqual({ prompt: "hi", artistic_style: "real", extra: "x" })
  })
})
