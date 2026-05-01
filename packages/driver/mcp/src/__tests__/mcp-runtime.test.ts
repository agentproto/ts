import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { defineMcpDriver, type McpClient } from "../index.js"

describe("defineMcpDriver — end-to-end via runTool", () => {
  it("dispatches via the supplied mcpClientFactory and applies argumentMapping + resultExtract", async () => {
    const tool = defineTool({
      id: "fs-read",
      description: "Read a workspace file.",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ contents: z.string() }),
    })

    const fakeClient: McpClient = {
      async callTool({ name, arguments: args }) {
        expect(name).toBe("read_file")
        expect(args).toEqual({ path: "/notes/x.md" })
        return {
          structuredContent: {
            contents: "Hello",
            mime_type: "text/markdown",
          },
        }
      },
      async close() {},
    }

    const provider = defineMcpDriver({
      id: "filesystem-mcp",
      name: "Filesystem MCP",
      description: "x",
      kind: "mcp",
      server: { kind: "npm", package: "@modelcontextprotocol/server-filesystem", args: ["/workspace"] },
      transport: "stdio",
      mcpClientFactory: async () => fakeClient,
      implements: [
        {
          tool: "./tools/fs-read/TOOL.md",
          version: "^1",
          metadata: {
            mcp: {
              toolName: "read_file",
              argumentMapping: { path: "path" },
            },
          },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { path: "/notes/x.md" },
    })
    expect(out).toMatchObject({ contents: "Hello" })
  })

  it("surfaces upstream_error when the MCP server returns isError", async () => {
    const tool = defineTool({
      id: "fs-read",
      description: "x",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.unknown(),
    })

    const provider = defineMcpDriver({
      id: "broken-mcp",
      name: "broken",
      description: "x",
      kind: "mcp",
      server: { kind: "npm", package: "broken" },
      transport: "stdio",
      mcpClientFactory: async () => ({
        async callTool() {
          return { content: "boom", isError: true }
        },
        async close() {},
      }),
      implements: [
        {
          tool: "./tools/fs-read/TOOL.md",
          version: "^1",
          metadata: { mcp: { toolName: "read_file" } },
        },
      ],
    })

    await expect(
      runTool({ tool, candidates: [provider], input: { path: "/x" } })
    ).rejects.toMatchObject({ code: "upstream_error" })
  })
})
