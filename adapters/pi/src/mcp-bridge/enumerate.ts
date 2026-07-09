/**
 * Adapter-side tool enumeration. At `connect()`, for each injected MCP server we
 * open a short-lived probe connection, `tools/list`, and close it — then build
 * the `BridgeConfig` the extension registers from. Doing enumeration here (not in
 * the extension) surfaces connect/list errors early on the host and keeps the
 * extension's registration fully synchronous. The live tool calls run later from
 * inside pi via its own fresh connections.
 */

import {
  buildBridgeConfig,
  DEFAULT_TOOL_PREFIX,
  toBridgeServerSpec,
  type RemoteTool,
} from "./config.js"
import { connectMcpClient, listMcpTools } from "./mcp-client.js"
import type { BridgeConfig } from "./types.js"
import type { AcpMcpServer } from "./acp-types.js"

export interface EnumerationResult {
  config: BridgeConfig
  /** Per-server error messages (server unreachable / list failed). */
  errors: Array<{ server: string; message: string }>
}

/**
 * Probe each server and assemble the bridge config. A server that fails to
 * connect or list is recorded in `errors` and contributes no tools (the rest
 * still bridge) — the adapter logs the summary.
 */
export async function enumerateMcpTools(
  servers: readonly AcpMcpServer[],
  prefix: string = DEFAULT_TOOL_PREFIX,
): Promise<EnumerationResult> {
  const toolsByServer = new Map<string, RemoteTool[]>()
  const errors: Array<{ server: string; message: string }> = []

  for (const server of servers) {
    const spec = toBridgeServerSpec(server)
    try {
      const client = await connectMcpClient(spec)
      try {
        toolsByServer.set(server.name, await listMcpTools(client))
      } finally {
        await client.close()
      }
    } catch (err) {
      errors.push({ server: server.name, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { config: buildBridgeConfig(servers, toolsByServer, prefix), errors }
}
