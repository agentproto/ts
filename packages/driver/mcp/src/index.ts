/**
 * @agentproto/mcp — AIP-32 MCP provider specialisation.
 *
 * Wraps a Model Context Protocol server as a conformant provider.
 * v0.1 ships the manifest shape, server-config types, argument
 * mapping, and result extraction. The actual MCP client connection
 * (stdio / SSE / HTTP transport, tools/list discovery, tools/call
 * dispatch) integrates with `@modelcontextprotocol/sdk` and is
 * provided through a host-supplied `mcpClient` factory in v0.1 —
 * v0.2 will bundle the SDK directly.
 *
 * Spec: https://agentproto.sh/docs/aip-32
 */

import {
  defineDriver,
  type ExecuteFn,
  type ImplementsEntry,
  type DriverDefinition,
  type DriverHandle,
} from "@agentproto/driver"

export type McpServerConfig =
  | { kind: "binary"; path: string; args?: readonly string[]; env?: Record<string, string> }
  | { kind: "npm"; package: string; args?: readonly string[]; env?: Record<string, string> }
  | { kind: "docker"; image: string; args?: readonly string[]; env?: Record<string, string> }
  | { kind: "remote"; url: string }

export type McpTransport = "stdio" | "sse" | "http"

/**
 * Minimal client surface the MCP runtime expects. Hosts supply this
 * via `mcpClientFactory`. Wraps `@modelcontextprotocol/sdk` typically.
 */
export interface McpClient {
  callTool(args: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>
  close(): Promise<void>
}

export interface McpDriverDefinition
  extends Omit<DriverDefinition, "kind" | "execute"> {
  kind?: "mcp"
  server: McpServerConfig
  transport: McpTransport
  protocolVersion?: string
  /**
   * Factory that returns a connected MCP client. Hosts implement this
   * with `@modelcontextprotocol/sdk`'s `Client` and the matching
   * transport. v0.1 keeps this injection-shaped so the runtime
   * doesn't take a hard dep on the upstream SDK.
   */
  mcpClientFactory: (args: {
    server: McpServerConfig
    transport: McpTransport
    protocolVersion?: string
    secrets: Record<string, string>
    signal: AbortSignal
  }) => Promise<McpClient>
}

/**
 * Define an MCP provider — sugar over defineDriver with kind: mcp
 * and an auto-synthesised execute map.
 */
export function defineMcpDriver(definition: McpDriverDefinition): DriverHandle {
  // Lazy client per provider. v0.1 connects on first invocation;
  // host MAY pre-warm via `connectMcp(handle)` (see exports below).
  let clientPromise: Promise<McpClient> | undefined
  const getClient = async (secrets: Record<string, string>, signal: AbortSignal) => {
    if (!clientPromise) {
      clientPromise = definition.mcpClientFactory({
        server: definition.server,
        transport: definition.transport,
        protocolVersion: definition.protocolVersion,
        secrets,
        signal,
      })
    }
    return clientPromise
  }

  const execute: Record<string, ExecuteFn> = {}
  for (const entry of definition.implements) {
    const toolId = normalizeToolId(entry.tool)
    execute[toolId] = createExecuteFn({ toolId, entry, getClient })
  }

  return defineDriver({
    ...definition,
    kind: "mcp",
    execute,
    metadata: {
      ...(definition.metadata ?? {}),
      mcp: {
        server: definition.server,
        transport: definition.transport,
        protocolVersion: definition.protocolVersion,
      },
    },
  })
}

function createExecuteFn(args: {
  toolId: string
  entry: ImplementsEntry
  getClient: (
    secrets: Record<string, string>,
    signal: AbortSignal
  ) => Promise<McpClient>
}): ExecuteFn {
  const meta = (args.entry.metadata ?? {}) as { mcp?: PerToolMcp }
  const mcpMeta = meta.mcp ?? { toolName: args.toolId }
  const mcpToolName = mcpMeta.toolName ?? args.toolId

  return async ({ input, driverCtx, signal }) => {
    const provCtx = driverCtx as { secrets: Record<string, string>; [k: string]: unknown }
    const inputObj = (input ?? {}) as Record<string, unknown>

    const mappedArgs = applyArgumentMapping(inputObj, mcpMeta.argumentMapping)
    const client = await args.getClient(provCtx.secrets ?? {}, signal)
    const response = await client.callTool({
      name: mcpToolName,
      arguments: mappedArgs,
    })

    if (response.isError) {
      const msg =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content)
      throw new McpDriverError("upstream_error", msg)
    }

    const payload = response.structuredContent ?? response.content
    return mcpMeta.resultExtract && mcpMeta.resultExtract !== "$"
      ? extractPath(payload, mcpMeta.resultExtract)
      : payload
  }
}

interface PerToolMcp {
  toolName?: string
  argumentMapping?: Record<string, string>
  resultExtract?: string
}

class McpDriverError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "McpDriverError"
    this.code = code
  }
}

function applyArgumentMapping(
  input: Record<string, unknown>,
  mapping: Record<string, string> | undefined
): Record<string, unknown> {
  if (!mapping) return input
  const out: Record<string, unknown> = { ...input }
  for (const [contractKey, mcpKey] of Object.entries(mapping)) {
    if (contractKey in input) {
      out[mcpKey] = input[contractKey]
      if (contractKey !== mcpKey) delete out[contractKey]
    }
  }
  return out
}

function extractPath(value: unknown, path: string): unknown {
  if (path === "$") return value
  let s = path.replace(/^\$/, "")
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g
  let current: unknown = value
  let match: RegExpExecArray | null
  while ((match = re.exec(s)) !== null) {
    if (current == null) return undefined
    if (match[1]) current = (current as Record<string, unknown>)[match[1]]
    else if (match[2]) current = (current as unknown[])[Number.parseInt(match[2], 10)]
  }
  return current
}

function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.startsWith("./")) s = s.slice(2)
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  if (s.startsWith("tools/")) s = s.slice("tools/".length)
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? s : s.slice(lastSlash + 1)
}

export { McpDriverError }
