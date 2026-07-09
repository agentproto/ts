/**
 * Pure builders for the bridge config JSON: `AcpMcpServer[]` +
 * enumerated remote tools → `BridgeConfig`. No I/O, no SDK — unit-testable.
 */

import type { AcpMcpServer } from "./acp-types.js"
import type { BridgeConfig, BridgeServerSpec, BridgeToolSpec, JsonObject } from "./types.js"

/** Default namespace for bridged tools: `mcp__<server>__<tool>`. */
export const DEFAULT_TOOL_PREFIX = "mcp__"

/** Anthropic/most providers cap tool names at 64 chars, `[a-zA-Z0-9_-]`. */
const MAX_TOOL_NAME_LEN = 64

/** A tool discovered on a remote MCP server (from `tools/list`). */
export interface RemoteTool {
  name: string
  description?: string
  inputSchema: JsonObject
}

/**
 * Flatten one `AcpMcpServer` into a `BridgeServerSpec`. Mirrors the ACP arm's
 * `toAcpMcpServer` transport→field mapping: `stdio` → `command` (from `ref`),
 * `http`/`sse` → `url` (from `ref`) + static `headers`. Brokered `credentialRef`
 * is NOT resolved here — only static `headers` are honored (see MCP-BRIDGE.md).
 */
export function toBridgeServerSpec(server: AcpMcpServer): BridgeServerSpec {
  if (server.transport === "stdio") {
    return { name: server.name, transport: "stdio", command: server.ref ?? "" }
  }
  return {
    name: server.name,
    transport: server.transport,
    url: server.ref ?? "",
    ...(server.headers ? { headers: server.headers } : {}),
  }
}

/** Replace any char outside `[a-zA-Z0-9_-]` with `_`. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Build the pi-facing tool name `mcp__<server>__<tool>`, sanitized to
 * `[a-zA-Z0-9_-]` and capped at 64 chars. `used` tracks already-emitted names
 * so collisions (after sanitizing/truncation) get a `_2`, `_3`, … suffix.
 */
export function bridgedToolName(
  prefix: string,
  serverName: string,
  remoteName: string,
  used: Set<string>,
): string {
  const base = `${prefix}${sanitizeSegment(serverName)}__${sanitizeSegment(remoteName)}`
  let candidate = base.slice(0, MAX_TOOL_NAME_LEN)
  let counter = 2
  while (used.has(candidate)) {
    const suffix = `_${counter}`
    candidate = `${base.slice(0, MAX_TOOL_NAME_LEN - suffix.length)}${suffix}`
    counter += 1
  }
  used.add(candidate)
  return candidate
}

/**
 * Assemble the full `BridgeConfig` from the injected servers and the tools
 * enumerated from each. `toolsByServer` is keyed by `AcpMcpServer.name`; servers
 * with no discovered tools still appear in `servers` (harmless) but contribute
 * no `tools` entries.
 */
export function buildBridgeConfig(
  servers: readonly AcpMcpServer[],
  toolsByServer: ReadonlyMap<string, readonly RemoteTool[]>,
  prefix: string = DEFAULT_TOOL_PREFIX,
): BridgeConfig {
  const serverSpecs = servers.map(toBridgeServerSpec)
  const used = new Set<string>()
  const tools: BridgeToolSpec[] = []
  for (const server of servers) {
    const remoteTools = toolsByServer.get(server.name) ?? []
    for (const remote of remoteTools) {
      tools.push({
        toolName: bridgedToolName(prefix, server.name, remote.name, used),
        server: server.name,
        remoteName: remote.name,
        description: remote.description ?? `Bridged MCP tool ${remote.name} on ${server.name}.`,
        inputSchema: remote.inputSchema,
      })
    }
  }
  return { servers: serverSpecs, tools }
}
