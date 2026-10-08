import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION } from "./constants.js"

/** Legacy handshake version used ONLY for the in-process `initialize` (never sent on the wire). */
const HANDSHAKE_VERSION = "2025-11-25"

/** A JSON-RPC error answered by the in-process server, unchanged (code, message, data). */
export class BridgeError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export interface Bridge {
  /** Capabilities exactly as the legacy server announced them (raw: nothing is stripped, `events` survives). */
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

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(error: unknown): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Connect a FRESH legacy server (the same factory the legacy /mcp path uses) to a raw in-memory JSON-RPC peer. The
 * in-process `initialize` yields the real capabilities, server info and instructions, so `server/discover` is built
 * from data, not from private SDK fields. No SDK `Client` is used: its schemas would strip unknown capability keys
 * (`events`) and wrap error messages a second time. Closes everything if the handshake fails.
 */
export async function openBridge(server: McpServer): Promise<Bridge> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const pending = new Map<number, Pending>()
  let nextId = 1

  clientSide.onmessage = (message: JSONRPCMessage) => {
    if (!("id" in message) || typeof message.id !== "number") return // server-initiated traffic is ignored
    const entry = pending.get(message.id)
    if (!entry) return
    if ("error" in message) {
      pending.delete(message.id)
      entry.reject(new BridgeError(message.error.code, message.error.message, message.error.data))
    } else if ("result" in message) {
      pending.delete(message.id)
      entry.resolve(isRecord(message.result) ? message.result : {})
    }
  }

  const close = async (): Promise<void> => {
    for (const entry of pending.values()) entry.reject(new Error("bridge closed"))
    pending.clear()
    await clientSide.close().catch(() => {})
    await server.close().catch(() => {})
  }

  const call = (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"))
        return
      }
      const id = nextId++
      const onAbort = (): void => {
        pending.delete(id)
        void clientSide
          .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "client disconnected" } })
          .catch(() => {})
        reject(signal?.reason ?? new Error("aborted"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      pending.set(id, {
        resolve: value => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: error => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      clientSide.send({ jsonrpc: "2.0", id, method, params }).catch(error => {
        pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        reject(error)
      })
    })

  try {
    await server.connect(serverSide)
    await clientSide.start()
    const init = await call("initialize", {
      protocolVersion: HANDSHAKE_VERSION,
      capabilities: {},
      clientInfo: { name: "agentproto-modern-bridge", version: "0.0.1" },
    })
    await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    const info = isRecord(init.serverInfo) ? init.serverInfo : {}
    return {
      capabilities: isRecord(init.capabilities) ? { ...init.capabilities } : {},
      serverInfo: {
        name: typeof info.name === "string" ? info.name : "agentproto",
        version: typeof info.version === "string" ? info.version : "0",
      },
      instructions: typeof init.instructions === "string" ? init.instructions : undefined,
      request: call,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
