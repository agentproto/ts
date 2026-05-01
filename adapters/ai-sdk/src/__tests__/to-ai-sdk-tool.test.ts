/**
 * Tests for `toAiSdkTool` — the AI SDK v5 adapter.
 *
 * Covers the same surface as `@agentproto/adapter-mastra`'s tests —
 * the two adapters share an API shape (`(impl, options)`) so tools
 * authored once with `implementTool` drop into either runtime.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"
import { toAiSdkTool } from "../index.js"

const greetTool = defineTool({
  id: "greet",
  description: "Greets a name in the bound locale.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  contextSchema: z.object({ locale: z.enum(["en", "fr"]) }),
})

type Locale = "en" | "fr"

describe("toAiSdkTool — basic projection", () => {
  it("preserves description + inputSchema from the contract", () => {
    const impl = implementTool(greetTool, async ({ input, context }) => ({
      greeting:
        context.locale === "fr"
          ? `Bonjour ${input.name}`
          : `Hello ${input.name}`,
    }))

    const adapted = toAiSdkTool(impl, {
      context: { locale: "en" satisfies Locale },
    })

    expect(adapted.description).toBe(greetTool.description)
    expect(adapted.inputSchema).toBe(greetTool.inputSchema)
    expect(adapted.type).toBe("dynamic")
    expect(typeof adapted.execute).toBe("function")
  })
})

describe("toAiSdkTool — context binding", () => {
  it("dispatches the body with the bound context at call time", async () => {
    const impl = implementTool(greetTool, async ({ input, context }) => ({
      greeting:
        context.locale === "fr"
          ? `Bonjour ${input.name}`
          : `Hello ${input.name}`,
    }))

    const enTool = toAiSdkTool(impl, {
      context: { locale: "en" satisfies Locale },
    })
    const frTool = toAiSdkTool(impl, {
      context: { locale: "fr" satisfies Locale },
    })

    const enResult = await enTool.execute!(
      { name: "Atlas" },
      { toolCallId: "t1", messages: [] }
    )
    const frResult = await frTool.execute!(
      { name: "Atlas" },
      { toolCallId: "t2", messages: [] }
    )

    expect(enResult).toEqual({ greeting: "Hello Atlas" })
    expect(frResult).toEqual({ greeting: "Bonjour Atlas" })
  })

  it("propagates abortSignal from AI SDK options into the body's signal arg", async () => {
    const sleepTool = defineTool({
      id: "sleep",
      description: "Sleeps until aborted.",
      inputSchema: z.object({}),
      outputSchema: z.object({ aborted: z.boolean() }),
    })
    const sleepImpl = implementTool(sleepTool, async ({ signal }) => {
      return new Promise<{ aborted: boolean }>(resolve => {
        signal.addEventListener("abort", () => resolve({ aborted: true }), {
          once: true,
        })
      })
    })

    const ac = new AbortController()
    const adapted = toAiSdkTool(sleepImpl, { context: {} })
    const promise = adapted.execute!(
      {},
      { toolCallId: "t3", messages: [], abortSignal: ac.signal }
    )
    ac.abort()
    await expect(promise).resolves.toEqual({ aborted: true })
  })
})
