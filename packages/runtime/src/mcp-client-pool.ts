/**
 * mcp-client-pool — the daemon as an MCP *client* to any resolved server
 * config, not just an `imported-mcps.json` entry.
 *
 * `McpProxyRegistry` (mcp-proxy.ts) keys its clients on import ids; the MCP
 * Apps host (mcp-apps-host.ts) instead resolves a harness's server alias
 * per session (session config → project → user → imports), and two sessions
 * in different projects may resolve the same alias to different servers.
 * So this pool keys clients on a stable hash of the resolved connection
 * config: sessions that resolve to the same config share one connection.
 *
 * Both paths open transports through `openMcpClient` below, so stdio / http
 * / sse behave the same whichever registry asked.
 */

import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js"
import type {
  CallToolResult,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server"
import type { DiscoveredMcp } from "./mcp-discovery.js"

/** The connection-relevant slice of a server config — what a transport
 *  needs, nothing about where it was found. `DiscoveredMcp` (and so an
 *  import's `snapshot`) is structurally one. */
export interface McpConnectionConfig {
  type: DiscoveredMcp["type"]
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface OpenMcpClientOptions {
  /** Prefix for config errors, e.g. `import "chrome-devtools"`. */
  label: string
  /** Advertised client capabilities. Default `{}`. */
  capabilities?: ClientCapabilities
  /** Expand `${VAR}` / `${VAR:-default}` in http/sse header values, the
   *  way claude-code expands them in `.mcp.json`. Env values are always
   *  expanded. Default false. */
  expandHeaders?: boolean
}

/**
 * Replace `${VAR}` and `${VAR:-default}` placeholders in env values
 * with the corresponding `process.env` entry (or default), the same
 * way claude-code / cursor expand mcp-server env. When the variable
 * is unset and no default is given, the placeholder is dropped — the
 * upstream then sees the env var as absent rather than as the
 * literal `${MISSING_VAR}`, which it usually treats as "use default
 * config" rather than "explicit empty token".
 */
export function expandEnvPlaceholders(
  raw: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const expanded = v.replace(
      /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi,
      (_match, name: string, fallback: string | undefined) => {
        const fromEnv = process.env[name]
        if (fromEnv !== undefined) return fromEnv
        if (fallback !== undefined) return fallback
        return ""
      }
    )
    // Drop the var entirely if it expanded to empty — keeps the
    // upstream from receiving an empty-string token + treating it as
    // a real (but invalid) credential.
    if (expanded.length === 0) continue
    out[k] = expanded
  }
  return out
}

export async function safeClose(client: Client | null): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch {
    // best-effort
  }
}

/**
 * Open a transport for a server config. stdio spawns the command;
 * http/sse open over the network. Returns a connected `Client` on
 * success; throws with a useful message on failure.
 */
export async function openMcpClient(
  config: McpConnectionConfig,
  opts: OpenMcpClientOptions
): Promise<Client> {
  const client = new Client(
    { name: "agentproto-daemon-proxy", version: "0.1.0" },
    { capabilities: opts.capabilities ?? {} }
  )
  if (config.type === "stdio") {
    if (!config.command) {
      throw new Error(`${opts.label} is stdio but has no command field`)
    }
    // claude-code / cursor / vscode all support `${VAR}` placeholders
    // in the env map (and the more permissive `${VAR:-default}`
    // form). Our scanner stores the snapshot verbatim — expand at
    // spawn time so live env changes work without a re-import, and
    // tokens like REPLICATE_API_TOKEN don't end up forwarded as the
    // literal string `${REPLICATE_API_TOKEN}`.
    const expandedEnv = expandEnvPlaceholders(config.env ?? {})
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...expandedEnv } as Record<string, string>,
      // Pipe stderr so we can include it in the error message instead of
      // surfacing the opaque "Connection closed" MCP error code.
      stderr: "pipe",
    })
    const stderrBuf: string[] = []
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      if (stderrBuf.length > 40) stderrBuf.shift()
    })
    try {
      await client.connect(transport)
    } catch (err) {
      const stderrText = stderrBuf.join("").trim()
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(stderrText ? `${msg}\nstderr: ${stderrText.slice(-600)}` : msg)
    }
    return client
  }
  const headers = opts.expandHeaders
    ? expandEnvPlaceholders(config.headers ?? {})
    : (config.headers ?? {})
  if (config.type === "http") {
    if (!config.url) throw new Error(`${opts.label} has no url`)
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    })
    await client.connect(transport)
    return client
  }
  if (config.type === "sse") {
    if (!config.url) throw new Error(`${opts.label} has no url`)
    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit: { headers },
    })
    await client.connect(transport)
    return client
  }
  throw new Error(
    `${opts.label} has unsupported transport type "${config.type}"`
  )
}

/** Stable identity of a connection config: sha256 over a key-sorted JSON
 *  rendering, so `{a,b}` and `{b,a}` (or a re-read of the same file) hash
 *  alike. Undefined fields are dropped by JSON itself. */
export function mcpConfigKey(config: McpConnectionConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** One UI-bearing tool of a server, per the MCP Apps spec. */
export interface McpUiToolEntry {
  name: string
  /** `ui://…`, from ext-apps `getToolUiResourceUri(tool)`. */
  resourceUri: string
  /** ext-apps `isToolVisibilityAppOnly(tool)`. */
  appOnly: boolean
}

/** Per-client UI index, built from the cached `tools/list`. */
export interface McpUiToolIndex {
  tools: McpUiToolEntry[]
  /** Every app-only tool, UI or not. */
  appOnlyTools: string[]
}

export function buildUiToolIndex(tools: readonly Tool[]): McpUiToolIndex {
  const ui: McpUiToolEntry[] = []
  const appOnlyTools: string[] = []
  for (const tool of tools) {
    const appOnly = isToolVisibilityAppOnly(tool)
    if (appOnly) appOnlyTools.push(tool.name)
    const resourceUri = getToolUiResourceUri(tool)
    if (resourceUri) ui.push({ name: tool.name, resourceUri, appOnly })
  }
  return { tools: ui, appOnlyTools }
}

/** The capability a host advertises so servers that gate their UI tools on
 *  client support (ext-apps `getUiCapability`) expose them to us. */
export const MCP_APPS_CLIENT_CAPABILITIES: ClientCapabilities = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
}

/** Opens a client for a config — injectable so tests can count connects. */
export type McpClientOpener = (
  config: McpConnectionConfig,
  label: string
) => Promise<Client>

const defaultOpener: McpClientOpener = (config, label) =>
  openMcpClient(config, {
    label,
    capabilities: MCP_APPS_CLIENT_CAPABILITIES,
    expandHeaders: true,
  })

/** Message shapes that mean the connection itself died mid-call — the
 *  same set `McpProxyRegistry.callTool` treats as "reconnect next time". */
const DEAD_CONNECTION_RE = /closed|disconnect|EPIPE|ECONNRESET/i

/**
 * A lazily-connected client for one config. Caches `tools/list` and the UI
 * index derived from it; both are dropped whenever the connection is, so a
 * reconnect always re-lists.
 */
export class PooledMcpClient {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  private tools: Tool[] | null = null
  private index: McpUiToolIndex | null = null

  constructor(
    readonly key: string,
    readonly config: McpConnectionConfig,
    private readonly label: string,
    private readonly opener: McpClientOpener
  ) {}

  /** Connect (once; concurrent callers share the attempt) and list tools.
   *  Throws the connect/list error — callers classify it. */
  private async connected(): Promise<Client> {
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = await this.opener(this.config, this.label)
        try {
          const listed = await client.listTools()
          this.tools = listed.tools
          this.index = null
          this.client = client
          return client
        } catch (err) {
          await safeClose(client)
          throw err
        }
      })().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  async listTools(): Promise<Tool[]> {
    await this.connected()
    return this.tools ?? []
  }

  async uiIndex(): Promise<McpUiToolIndex> {
    const tools = await this.listTools()
    this.index ??= buildUiToolIndex(tools)
    return this.index
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const client = await this.connected()
    try {
      return await client.readResource({ uri })
    } catch (err) {
      await this.dropIfDead(err)
      throw err
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const client = await this.connected()
    try {
      const result = await client.callTool({ name, arguments: args })
      // The SDK's return type also admits the legacy `{ toolResult }`
      // shape (protocol 2024-10-07); normalise it into content.
      if ("content" in result && Array.isArray(result.content)) {
        return result as CallToolResult
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.toolResult ?? null) }],
      }
    } catch (err) {
      await this.dropIfDead(err)
      throw err
    }
  }

  /** Forget the connection (and with it the tool list + index). */
  async reset(): Promise<void> {
    const client = this.client
    this.client = null
    this.tools = null
    this.index = null
    await safeClose(client)
  }

  private async dropIfDead(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err)
    if (DEAD_CONNECTION_RE.test(msg)) await this.reset()
  }
}

export class McpClientPool {
  private clients = new Map<string, PooledMcpClient>()

  constructor(private readonly opener: McpClientOpener = defaultOpener) {}

  /** The pooled client for `config`, created on first use. `label` only
   *  names the server in config errors. */
  get(config: McpConnectionConfig, label: string): PooledMcpClient {
    const key = mcpConfigKey(config)
    let pooled = this.clients.get(key)
    if (!pooled) {
      pooled = new PooledMcpClient(key, config, label, this.opener)
      this.clients.set(key, pooled)
    }
    return pooled
  }

  get size(): number {
    return this.clients.size
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map(c => c.reset()))
    this.clients.clear()
  }
}
