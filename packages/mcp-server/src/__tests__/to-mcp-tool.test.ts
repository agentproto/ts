/**
 * toMcpTool — a TOOL contract becomes a callable MCP tool whose body is
 * `runTool`. Uses inline echo / len / mult contracts (the framework package
 * can't depend on a catalogue) to prove: object-input fields map straight to
 * MCP params, a non-object input falls back to a single `input` param, and the
 * injected context is produced by the registration-time factory.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool, catchErrors, paginated, type ToolTransformer } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildMcpTool, toMcpTool } from "../to-mcp-tool.js"

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

describe("toMcpTool transformers", () => {
  const listTool = defineTool({
    id: "demo.list",
    description: "Return the fixed demo rows.",
    inputSchema: z.object({}),
    outputSchema: z.array(z.object({ id: z.string() })).optional(),
  })
  const listDriver = defineDriver({
    id: "list-builtin",
    name: "List",
    description: "Fixed rows.",
    kind: "builtin",
    implements: [{ tool: "demo.list", version: "0.1.0" }],
    implementations: [
      implementTool(listTool, () => [
        { id: "a", extra: 1 },
        { id: "b", extra: 2 },
      ]),
    ],
  })

  it("applies wrapShape and the paginated transformer end-to-end", async () => {
    const reg = buildMcpTool({
      tool: listTool,
      candidates: [listDriver],
      transformers: [
        paginated({ project: (i: { id: string }) => ({ id: i.id }) }),
      ],
    })
    // wrapShape extended the declared (empty) shape with the page params.
    expect(Object.keys(reg.inputShape).sort()).toEqual(
      ["compact", "cursor", "fields", "full", "limit"].sort(),
    )
    const page = JSON.parse((await reg.handler({ limit: 1 })).content[0]!.text) as {
      items: Array<Record<string, unknown>>
      total: number
      nextCursor?: string
    }
    expect(page.items).toEqual([{ id: "a" }])
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeDefined()
  })

  it("composes left-to-right: first declared transformer is the outermost wrapper", async () => {
    const mark =
      (name: string): ToolTransformer =>
      ({
        name,
        wrapHandler: handler => async input => ({
          marker: name,
          inner: await handler(input),
        }),
      }) as ToolTransformer
    const reg = buildMcpTool({
      tool: listTool,
      candidates: [listDriver],
      transformers: [mark("first"), mark("second")],
    })
    const parsed = parse(await reg.handler({})) as {
      marker: string
      inner: { marker: string }
    }
    expect(parsed.marker).toBe("first")
    expect(parsed.inner.marker).toBe("second")
  })

  it("catchErrors outermost turns a throwing body into the canonical error result", async () => {
    const boomTool = defineTool({
      id: "demo.boom",
      description: "Always throws.",
      inputSchema: z.object({}),
    })
    const boomDriver = defineDriver({
      id: "boom-builtin",
      name: "Boom",
      description: "Throws.",
      kind: "builtin",
      implements: [{ tool: "demo.boom", version: "0.1.0" }],
      implementations: [
        implementTool(boomTool, () => {
          throw new Error("kaput")
        }),
      ],
    })
    const reg = buildMcpTool({
      tool: boomTool,
      candidates: [boomDriver],
      transformers: [catchErrors()],
    })
    const res = await reg.handler({})
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toBe("kaput")
  })

  it("falls back to the contract's own tool.transformers when the option is absent", async () => {
    const handleTool = defineTool({
      id: "demo.handle",
      description: "Contract-carried transformers.",
      inputSchema: z.object({}),
      outputSchema: z.array(z.object({ id: z.string() })).optional(),
      transformers: [
        paginated({ project: (i: { id: string }) => ({ id: i.id }) }),
      ],
    })
    const handleDriver = defineDriver({
      id: "handle-builtin",
      name: "Handle",
      description: "Fixed rows.",
      kind: "builtin",
      implements: [{ tool: "demo.handle", version: "0.1.0" }],
      implementations: [
        implementTool(handleTool, () => [{ id: "a" }, { id: "b" }]),
      ],
    })
    const reg = buildMcpTool({ tool: handleTool, candidates: [handleDriver] })
    expect(Object.keys(reg.inputShape)).toContain("limit")
    const parsed = parse(await reg.handler({})) as { items?: unknown[] }
    expect(parsed.items).toHaveLength(2)
  })
})

describe("toMcpTool MCP Apps + structuredContent", () => {
  const echoTool = defineTool({
    id: "demo.echo",
    description: "Echo the message, uppercased by the driver.",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ shout: z.string() }),
    idempotent: true,
    requires: { network: ["api.example.com"] },
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

  async function connect(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0.0.0" })
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
    return client
  }

  it("without ui: same text output, plus structuredContent, no _meta", async () => {
    const reg = buildMcpTool({ tool: echoTool, candidates: [echoDriver] })
    expect(reg._meta).toBeUndefined()
    expect(reg.annotations).toBeUndefined()
    const res = await reg.handler({ message: "hi" })
    expect(res.content).toEqual([
      { type: "text", text: JSON.stringify({ shout: "HI" }, null, 2) },
    ])
    expect(res.structuredContent).toEqual({ shout: "HI" })
  })

  it("omits structuredContent for non-record outputs (arrays)", async () => {
    const rowsTool = defineTool({
      id: "demo.rows",
      description: "Rows.",
      inputSchema: z.object({}),
    })
    const rowsDriver = defineDriver({
      id: "rows-builtin",
      name: "Rows",
      description: "Rows.",
      kind: "builtin",
      implements: [{ tool: "demo.rows", version: "0.1.0" }],
      implementations: [implementTool(rowsTool, () => [1, 2])],
    })
    const res = await buildMcpTool({
      tool: rowsTool,
      candidates: [rowsDriver],
    }).handler({})
    expect(parse(res)).toEqual([1, 2])
    expect(res.structuredContent).toBeUndefined()
  })

  it("passes a transformer's pre-serialized result through unchanged", async () => {
    const preSerialized: ToolTransformer = {
      name: "pre",
      wrapHandler: () => async () => ({
        content: [{ type: "text", text: "done" }],
      }),
    } as ToolTransformer
    const res = await buildMcpTool({
      tool: echoTool,
      candidates: [echoDriver],
      transformers: [preSerialized],
    }).handler({ message: "x" })
    expect(res).toEqual({ content: [{ type: "text", text: "done" }] })
  })

  it("derives annotations from the contract only when asked", async () => {
    const derived = buildMcpTool({
      tool: echoTool,
      candidates: [echoDriver],
      annotations: true,
    })
    expect(derived.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    const overridden = buildMcpTool({
      tool: echoTool,
      candidates: [echoDriver],
      annotations: { openWorldHint: false, title: "Echo" },
    })
    expect(overridden.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
      title: "Echo",
    })
  })

  it("with ui: tools/list exposes _meta.ui and tools/call returns structuredContent", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    const reg = toMcpTool(server, {
      tool: echoTool,
      candidates: [echoDriver],
      ui: { resourceUri: "ui://demo-echo/view" },
      annotations: true,
    })
    expect(reg._meta).toEqual({
      ui: { resourceUri: "ui://demo-echo/view", visibility: ["model", "app"] },
    })
    const client = await connect(server)

    const { tools } = await client.listTools()
    const listed = tools.find((t) => t.name === "demo_echo")
    expect(listed?._meta).toEqual({
      ui: { resourceUri: "ui://demo-echo/view", visibility: ["model", "app"] },
    })
    expect(listed?.annotations?.readOnlyHint).toBe(true)

    const res = await client.callTool({
      name: "demo_echo",
      arguments: { message: "salut" },
    })
    expect(res.structuredContent).toEqual({ shout: "SALUT" })
    expect(res.content).toEqual([
      { type: "text", text: JSON.stringify({ shout: "SALUT" }, null, 2) },
    ])
    await client.close()
  })

  it("honours an explicit visibility and registers without ui unchanged", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" })
    toMcpTool(server, {
      tool: echoTool,
      candidates: [echoDriver],
      name: "app_only",
      ui: { resourceUri: "ui://x/view", visibility: ["app"] },
    })
    toMcpTool(server, { tool: echoTool, candidates: [echoDriver] })
    const client = await connect(server)
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === "app_only")?._meta).toEqual({
      ui: { resourceUri: "ui://x/view", visibility: ["app"] },
    })
    const plain = tools.find((t) => t.name === "demo_echo")
    expect(plain?._meta).toBeUndefined()
    expect(plain?.annotations).toBeUndefined()
    expect(Object.keys(plain?.inputSchema.properties ?? {})).toEqual([
      "message",
    ])
    await client.close()
  })
})
