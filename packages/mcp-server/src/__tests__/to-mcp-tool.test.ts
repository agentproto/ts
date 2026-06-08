/**
 * toMcpTool — a TOOL contract becomes a callable MCP tool whose body is
 * `runTool`. Uses inline echo / len / mult contracts (the framework package
 * can't depend on a catalogue) to prove: object-input fields map straight to
 * MCP params, a non-object input falls back to a single `input` param, and the
 * injected context is produced by the registration-time factory.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { buildMcpTool } from "../to-mcp-tool.js"

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0]!.text)

describe("toMcpTool", () => {
  it("maps object-input fields to MCP params and runs through runTool", async () => {
    const echoTool = defineTool({
      id: "demo.echo",
      description: "Echo the message, uppercased by the driver.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ shout: z.string() }),
    })
    const echoDriver = defineDriver({
      id: "echo-builtin",
      name: "Echo",
      description: "Uppercases the message.",
      kind: "builtin",
      implements: [{ tool: "demo.echo", version: "0.1.0" }],
      implementations: [
        implementTool(echoTool, ({ input }) => ({
          shout: input.message.toUpperCase(),
        })),
      ],
    })

    const reg = buildMcpTool({ tool: echoTool, candidates: [echoDriver] })
    expect(reg.name).toBe("demo_echo")
    expect(Object.keys(reg.inputShape)).toEqual(["message"])

    const res = await reg.handler({ message: "bonjour" })
    expect(parse(res)).toEqual({ shout: "BONJOUR" })
  })

  it("wraps a non-object input under a single `input` param", async () => {
    const lenTool = defineTool({
      id: "demo.len",
      description: "Length of a string.",
      inputSchema: z.string(),
      outputSchema: z.object({ n: z.number() }),
    })
    const lenDriver = defineDriver({
      id: "len-builtin",
      name: "Len",
      description: "String length.",
      kind: "builtin",
      implements: [{ tool: "demo.len", version: "0.1.0" }],
      implementations: [
        implementTool(lenTool, ({ input }) => ({ n: input.length })),
      ],
    })

    const reg = buildMcpTool({ tool: lenTool, candidates: [lenDriver] })
    expect(Object.keys(reg.inputShape)).toEqual(["input"])

    const res = await reg.handler({ input: "abcd" })
    expect(parse(res)).toEqual({ n: 4 })
  })

  it("produces injected context from the registration-time factory", async () => {
    const multTool = defineTool({
      id: "demo.mult",
      description: "Multiply by the injected factor.",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      contextSchema: z.object({ mult: z.number() }).loose(),
    })
    const multDriver = defineDriver({
      id: "mult-builtin",
      name: "Mult",
      description: "Multiplies x by context.mult.",
      kind: "builtin",
      implements: [{ tool: "demo.mult", version: "0.1.0" }],
      implementations: [
        implementTool(multTool, ({ input, context }) => ({
          y: input.x * context.mult,
        })),
      ],
    })

    let factoryCalls = 0
    const reg = buildMcpTool({
      tool: multTool,
      candidates: [multDriver],
      context: () => {
        factoryCalls++
        return { mult: 3 }
      },
    })

    const res = await reg.handler({ x: 5 })
    expect(parse(res)).toEqual({ y: 15 })
    expect(factoryCalls).toBe(1)
  })
})
