/**
 * registerBuiltinTool — one-call registration for the daemon's
 * single-implementation builtin tools. Proves the collapsed
 * defineTool + implementTool + defineDriver + toMcpTool sequence:
 * schema wiring, handler dispatch through runTool, transformer
 * composition, and the hardcoded `agentproto-runtime-builtin`
 * driver convention.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerBuiltinTool } from "../register-builtin-tool.js"

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0]!.text)

/** Capture-only fake: record what the caller registered on `server`. */
function fakeServer(): {
  server: McpServer
  calls: Array<{
    name: string
    description: string
    inputShape: Record<string, unknown>
    handler: (args: Record<string, unknown>) => Promise<unknown>
  }>
} {
  const calls: Array<{
    name: string
    description: string
    inputShape: Record<string, unknown>
    handler: (args: Record<string, unknown>) => Promise<unknown>
  }> = []
  const server = {
    tool: (
      name: string,
      description: string,
      inputShape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => calls.push({ name, description, inputShape, handler }),
  } as unknown as McpServer
  return { server, calls }
}

describe("registerBuiltinTool", () => {
  it("registers the tool under its mcpName with the schema fields as params", async () => {
    const { server, calls } = fakeServer()
    registerBuiltinTool(server, {
      id: "demo.shout",
      description: "Echo the message, uppercased.",
      inputSchema: z.object({ message: z.string() }),
      handler: (input: { message: string }) => ({
        shout: input.message.toUpperCase(),
      }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("demo_shout")
    expect(calls[0]!.description).toBe("Echo the message, uppercased.")
    expect(Object.keys(calls[0]!.inputShape)).toEqual(["message"])

    const res = await calls[0]!.handler({ message: "bonjour" })
    expect(parse(res as { content: Array<{ text: string }> })).toEqual({
      shout: "BONJOUR",
    })
  })

  it("dispatches through runTool: input is validated against the schema", async () => {
    const { server, calls } = fakeServer()
    registerBuiltinTool(server, {
      id: "demo.shout",
      description: "Echo the message, uppercased.",
      inputSchema: z.object({ message: z.string() }),
      handler: (input: { message: string }) => ({
        shout: input.message.toUpperCase(),
      }),
    })

    await expect(calls[0]!.handler({ message: 42 })).rejects.toThrow()
  })

  it("leaves handler throws untouched when no transformers are given", async () => {
    const { server, calls } = fakeServer()
    registerBuiltinTool(server, {
      id: "demo.boom",
      description: "Always throws.",
      inputSchema: z.object({}),
      handler: () => {
        throw new Error("boom")
      },
    })

    await expect(calls[0]!.handler({})).rejects.toThrow("boom")
  })

  it("accepts sync handlers", async () => {
    const { server, calls } = fakeServer()
    registerBuiltinTool(server, {
      id: "demo.shout",
      description: "Echo the message, uppercased.",
      inputSchema: z.object({ message: z.string() }),
      handler: (input: { message: string }) => ({
        shout: input.message.toUpperCase(),
      }),
    })

    const res = await calls[0]!.handler({ message: "hi" })
    expect(parse(res as { content: Array<{ text: string }> })).toEqual({
      shout: "HI",
    })
  })

  it("composes transformers left-to-right", async () => {
    const { server, calls } = fakeServer()
    registerBuiltinTool(server, {
      id: "demo.list",
      description: "Return the fixed demo rows.",
      inputSchema: z.object({}),
      handler: () => [{ id: "a" }, { id: "b" }],
      transformers: [
        (await import("@agentproto/tool")).paginated({
          project: (i: { id: string }) => ({ id: i.id }),
        }),
      ],
    })

    // paginated() extends the shape with page params and paginates output.
    expect(Object.keys(calls[0]!.inputShape).sort()).toEqual(
      ["compact", "cursor", "fields", "full", "limit"].sort(),
    )
    const res = await calls[0]!.handler({})
    expect(parse(res as { content: Array<{ text: string }> })).toEqual({
      rows: undefined,
      items: [{ id: "a" }, { id: "b" }],
    })
  })
})
