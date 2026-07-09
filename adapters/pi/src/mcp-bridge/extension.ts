/**
 * The generated pi **extension** — the runtime half of the MCP bridge.
 *
 * pi loads this file via `pi -e <dist>/mcp-bridge-extension.mjs` (the adapter
 * adds the flag when MCP servers are injected). At load, pi calls the default
 * export with its `ExtensionAPI`; we read the per-session config from
 * `PI_MCP_BRIDGE_CONFIG`, and register one pi tool per bridged MCP tool
 * SYNCHRONOUSLY (registration during extension load is valid in pi — see
 * MCP-BRIDGE.md). Each tool's async `execute` connects to its MCP server lazily
 * (memoized per server) and proxies the call over `@modelcontextprotocol/sdk`.
 *
 * This module imports NOTHING from `@earendil-works/*`: it uses pi's structural
 * runtime contract (a `registerTool` method; a plain JSON Schema as
 * `parameters`). The MCP SDK is bundled into this file at build time (pi's
 * process has no other way to load it); pi's own packages stay external and pi
 * resolves them itself at load.
 */

import { readFileSync } from "node:fs"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { callMcpTool, connectMcpClient } from "./mcp-client.js"
import { mapMcpResultToPiResult } from "./map-result.js"
import {
  type BridgeConfig,
  type BridgeServerSpec,
  type BridgeToolSpec,
  type JsonObject,
  type PiExtensionAPI,
  type PiToolResult,
} from "./types.js"
import { parseBridgeConfig } from "./parse-config.js"

const CONFIG_ENV = "PI_MCP_BRIDGE_CONFIG"

function loadConfig(): BridgeConfig {
  const path = process.env[CONFIG_ENV]
  if (!path) {
    throw new Error(`[adapter-pi mcp-bridge] ${CONFIG_ENV} is not set`)
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  return parseBridgeConfig(parsed, path)
}

/** Lazy, memoized MCP `Client` per server name (connect once, reuse). */
function createClientPool(servers: readonly BridgeServerSpec[]): (name: string) => Promise<Client> {
  const byName = new Map<string, BridgeServerSpec>()
  for (const spec of servers) byName.set(spec.name, spec)
  const clients = new Map<string, Promise<Client>>()
  return name => {
    const existing = clients.get(name)
    if (existing) return existing
    const spec = byName.get(name)
    if (!spec) {
      return Promise.reject(new Error(`[adapter-pi mcp-bridge] unknown server "${name}"`))
    }
    const pending = connectMcpClient(spec).catch((err: unknown) => {
      // Don't cache a failed connection — allow a later retry.
      clients.delete(name)
      throw err instanceof Error ? err : new Error(String(err))
    })
    clients.set(name, pending)
    return pending
  }
}

function buildExecute(
  getClient: (name: string) => Promise<Client>,
  spec: BridgeToolSpec,
): (id: string, params: JsonObject, signal: AbortSignal | undefined) => Promise<PiToolResult> {
  return async (_id, params, signal) => {
    try {
      const client = await getClient(spec.server)
      const raw = await callMcpTool(client, spec.remoteName, params, signal)
      return mapMcpResultToPiResult(raw, spec.server, spec.remoteName)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [
          { type: "text", text: `MCP bridge error (${spec.server}/${spec.remoteName}): ${message}` },
        ],
        details: { server: spec.server, tool: spec.remoteName, isError: true },
      }
    }
  }
}

/**
 * pi extension factory. Registers every bridged tool synchronously at load.
 * Exported for unit testing; the default export is what pi invokes.
 */
export function registerBridge(pi: PiExtensionAPI, config: BridgeConfig): number {
  const getClient = createClientPool(config.servers)
  for (const spec of config.tools) {
    pi.registerTool({
      name: spec.toolName,
      label: spec.remoteName,
      description: spec.description,
      promptSnippet: `Call the ${spec.remoteName} MCP tool (bridged from server "${spec.server}").`,
      promptGuidelines: [
        `${spec.toolName} proxies to the "${spec.remoteName}" tool on MCP server "${spec.server}". ` +
          `Use it exactly like a native tool; arguments follow its JSON Schema.`,
      ],
      parameters: spec.inputSchema,
      execute: buildExecute(getClient, spec),
    })
  }
  return config.tools.length
}

export default function mcpBridgeExtension(pi: PiExtensionAPI): void {
  registerBridge(pi, loadConfig())
}
