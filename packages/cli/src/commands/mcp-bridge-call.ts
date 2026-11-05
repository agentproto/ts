import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import { bridgeCallerUrl, stampOrigin } from "./mcp-bridge.logic.js"

/** Use a request-local connection for a host-attested chat. Reusing the root
 * client (or mutating its URL) loses identity or races concurrent chats. The
 * daemon is stateless; the external inbox is keyed by the stable chat id. */
export async function forwardBridgeTool(
  rootClient: Client,
  baseUrl: string,
  params: CallToolRequest["params"],
  hostName?: string,
) {
  const stamped = stampOrigin(params, hostName)
  const callerUrl = bridgeCallerUrl(baseUrl, params._meta, hostName)
  if (callerUrl === baseUrl) return rootClient.callTool(stamped)
  const caller = new Client({ name: "agentproto-mcp-bridge", version: "0.1.0" })
  try {
    await caller.connect(new StreamableHTTPClientTransport(new URL(callerUrl)))
    return await caller.callTool(stamped)
  } finally {
    await caller.close()
  }
}
