import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION } from "./constants.js"

/** Loose on purpose: the legacy server owns result validation; custom methods (events/*) have no SDK schema. */
const looseResult = z.object({}).passthrough()

export interface Bridge {
  capabilities: Record<string, unknown>
  serverInfo: { name: string; version: string }
  instructions: string | undefined
  /** Forward one already-validated modern request. `params` must have the handshake `_meta` keys stripped. */
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  close(): Promise<void>
}

/** Remove the three per-request handshake keys from `params._meta`; keep every other `_meta` key (progressToken, traceparent...). */
export function forwardParams(params: Record<string, unknown>): Record<string, unknown> {
  const { _meta, ...rest } = params
  if (typeof _meta !== "object" || _meta === null || Array.isArray(_meta)) return rest
  const handshake = new Set([META_PROTOCOL_VERSION, META_CLIENT_INFO, META_CLIENT_CAPABILITIES])
  const kept = Object.fromEntries(Object.entries(_meta).filter(([key]) => !handshake.has(key)))
  return Object.keys(kept).length > 0 ? { ...rest, _meta: kept } : rest
}

/**
 * Connect an in-process SDK client to a FRESH legacy server (the same factory the legacy /mcp path uses). The
 * in-process `initialize` yields the real capabilities, server info and instructions, so `server/discover` is built
 * from data, not from private SDK fields. Closes both ends if the handshake fails.
 */
export async function openBridge(server: McpServer): Promise<Bridge> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "agentproto-modern-bridge", version: "0.0.1" }, { capabilities: {} })
  const close = async (): Promise<void> => {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
  try {
    await server.connect(serverSide)
    await client.connect(clientSide)
  } catch (error) {
    await close()
    throw error
  }
  const info = client.getServerVersion()
  return {
    capabilities: { ...(client.getServerCapabilities() ?? {}) } as Record<string, unknown>,
    serverInfo: { name: info?.name ?? "agentproto", version: info?.version ?? "0" },
    instructions: client.getInstructions(),
    async request(method, params, signal) {
      const result = await client.request({ method, params }, looseResult, signal ? { signal } : undefined)
      return result as Record<string, unknown>
    },
    close,
  }
}
