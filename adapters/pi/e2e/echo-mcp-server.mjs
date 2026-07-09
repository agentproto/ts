#!/usr/bin/env node
/**
 * Trivial stdio MCP server exposing one `echo` tool, for the pi↔MCP bridge
 * live e2e. Low-level `Server` API (no zod authoring). Executable via shebang so
 * an `AcpMcpServer` can point at it with `ref` = this file, `args` = [].
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "echo-mcp", version: "0.0.1" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the provided text back verbatim.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo back" } },
        required: ["text"],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {}
  const text = typeof args.text === "string" ? args.text : String(args.text ?? "")
  return { content: [{ type: "text", text }] }
})

await server.connect(new StdioServerTransport())
