/**
 * Thin `@modelcontextprotocol/sdk` wrapper shared by the adapter (which
 * enumerates tools up-front in `connect()`) and the generated pi extension
 * (which connects lazily and calls tools). Keeps transport construction and the
 * `Client` lifecycle in one place so both sides agree on semantics.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { asJsonObject, type BridgeServerSpec, type JsonObject } from "./types.js"
import type { RemoteTool } from "./config.js"

const CLIENT_INFO = { name: "agentproto-adapter-pi-mcp-bridge", version: "0.1.0" }

/** Build the SDK transport for a server spec (stdio / streamable-http / sse). */
function createTransport(spec: BridgeServerSpec): Transport {
  if (spec.transport === "stdio") {
    if (!spec.command) {
      throw new Error(`MCP bridge: stdio server "${spec.name}" has no command`)
    }
    return new StdioClientTransport({
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    })
  }
  if (!spec.url) {
    throw new Error(`MCP bridge: ${spec.transport} server "${spec.name}" has no url`)
  }
  const url = new URL(spec.url)
  const options = spec.headers ? { requestInit: { headers: spec.headers } } : {}
  if (spec.transport === "sse") return new SSEClientTransport(url, options)
  return new StreamableHTTPClientTransport(url, options)
}

/** Connect a `Client` to a server. Caller owns closing it. */
export async function connectMcpClient(spec: BridgeServerSpec): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(createTransport(spec))
  return client
}

/** `tools/list` on a connected client, normalized to `RemoteTool[]`. */
export async function listMcpTools(client: Client): Promise<RemoteTool[]> {
  const listed = await client.listTools()
  return listed.tools.map(tool => ({
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: asJsonObject(tool.inputSchema),
  }))
}

/** `tools/call` on a connected client. Returns the raw result for mapping. */
export async function callMcpTool(
  client: Client,
  name: string,
  args: JsonObject,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return client.callTool(
    { name, arguments: args },
    undefined,
    signal ? { signal } : undefined,
  )
}
