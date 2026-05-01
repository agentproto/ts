import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool, ToolError } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"
import { toMastraTool } from "../index.js"

describe("toMastraTool — basic projection", () => {
  it("preserves id, description, schemas from the contract", () => {
    const handle = defineTool({
      id: "echo",
      description: "Returns its input.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
    })
    const impl = implementTool(handle, async ({ input }) => ({
      echo: input.message,
    }))
    const mt = toMastraTool(impl, { source: { context: {} } })
    expect(mt.id).toBe("echo")
    expect(mt.description).toBe("Returns its input.")
    expect(mt.inputSchema).toBe(handle.inputSchema)
    expect(mt.outputSchema).toBe(handle.outputSchema)
  })

  it("execute runs the typed body and returns its output", async () => {
    const handle = defineTool({
      id: "uppercase",
      description: "Uppercases.",
      inputSchema: z.object({ s: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    })
    const impl = implementTool(handle, async ({ input }) => ({
      result: input.s.toUpperCase(),
    }))
    const mt = toMastraTool(impl, { source: { context: {} } })
    const out = await mt.execute!({ s: "hi" }, {} as never)
    expect(out).toEqual({ result: "HI" })
  })

  it("propagates ToolError unchanged", async () => {
    const handle = defineTool({
      id: "guard",
      description: "Throws on empty.",
      inputSchema: z.object({ s: z.string() }),
      outputSchema: z.object({}),
    })
    const impl = implementTool(handle, async ({ input }) => {
      if (!input.s) {
        throw new ToolError({ code: "input_invalid", message: "empty" })
      }
      return {}
    })
    const mt = toMastraTool(impl, { source: { context: {} } })
    await expect(mt.execute!({ s: "" }, {} as never)).rejects.toMatchObject({
      code: "input_invalid",
      message: "empty",
    })
  })
})

describe("toMastraTool — context binding", () => {
  it("static binding: closes over context once at adapter time", async () => {
    type Locale = "en" | "fr"
    let seenLocale: Locale | null = null
    const handle = defineTool({
      id: "ctx-spy",
      description: "Captures context.",
      inputSchema: z.object({}),
      outputSchema: z.object({ greeting: z.string() }),
      contextSchema: z.object({ locale: z.enum(["en", "fr"]) }),
    })
    const impl = implementTool(handle, async ({ context }) => {
      seenLocale = context.locale
      return { greeting: context.locale === "fr" ? "Bonjour" : "Hello" }
    })
    const mt = toMastraTool(impl, {
      source: { context: { locale: "fr" satisfies Locale } },
    })

    const out = await mt.execute!({}, {} as never)
    expect(seenLocale).toBe("fr")
    expect(out).toEqual({ greeting: "Bonjour" })
  })

  it("dynamic binding: resolves context from mastraContext per call", async () => {
    const handle = defineTool({
      id: "tenant-aware",
      description: "Reads tenant from per-request mastra context.",
      inputSchema: z.object({}),
      outputSchema: z.object({ tenantId: z.string() }),
      contextSchema: z.object({ tenantId: z.string() }),
    })
    const impl = implementTool(handle, async ({ context }) => ({
      tenantId: context.tenantId,
    }))
    const mt = toMastraTool(impl, {
      source: {
        fromMastraContext: mastraCtx => ({
          tenantId: (mastraCtx as { tenantId: string }).tenantId,
        }),
      },
    })

    const a = await mt.execute!({}, { tenantId: "tenant-a" } as never)
    const b = await mt.execute!({}, { tenantId: "tenant-b" } as never)
    expect(a).toEqual({ tenantId: "tenant-a" })
    expect(b).toEqual({ tenantId: "tenant-b" })
  })
})
