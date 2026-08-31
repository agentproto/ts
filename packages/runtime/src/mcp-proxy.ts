/**
 * mcp-proxy — connect the daemon as an MCP *client* to every server
 * the user imported via `~/.agentproto/imported-mcps.json`, and
 * surface their tools through dedicated MCP tools on the daemon's
 * own server. The chain looks like:
 *
 *   operator (cloud Guilde)  ──MCP──▶  agentproto-daemon (this proxy)
 *                                       │
 *                                       ├──stdio──▶ chrome-devtools-mcp
 *                                       └──http───▶ goose-bridge
 *
 * v1 design choice: instead of re-registering each upstream tool
 * under a namespaced name (which requires JSON-Schema↔Zod conversion
 * for every exotic shape — recursive refs, oneOf, etc.), the proxy
 * exposes two indirection tools:
 *   - `mcp_list_imported_tools(alias?)` lets the operator discover
 *     what's available
 *   - `mcp_call_imported(alias, toolName, args)` invokes a specific
 *     tool, forwarding the JSON args verbatim
 *
 * Trade-off: agents do a 2-step (list → call) instead of seeing the
 * imports directly in their tool palette. We keep tool inputs
 * unconstrained at the MCP layer; validation is the upstream
 * server's job. v2 can re-expose namespaced tools once we ship a
 * solid JSON-Schema → Zod converter.
 *
 * Lifecycle: clients are connected lazily on the first call that
 * touches them and held open until daemon shutdown. The registry
 * notices new/removed imports by stat'ing the imports file's mtime
 * before each call — cheap, avoids forcing the HTTP routes to push.
 */

import { promises as fs } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  loadImportedMcps,
  IMPORTED_MCPS_PATH,
  type ImportedMcpEntry,
} from "./mcp-imports.js"
import type { DiscoveredMcp } from "./mcp-discovery.js"

interface ProxyClient {
  entry: ImportedMcpEntry
  /** Live MCP client. Null while a connect is in-flight or after a
   *  connection error — the next call retries. */
  client: Client | null
  /** Tools list cached after the first successful fetch. Cleared on
   *  disconnect so stale tool names don't survive a reconnect. */
  tools: ProxyToolDescriptor[] | null
  /** Last connection error message, kept so listAliases can surface
   *  diagnostics to the operator without re-throwing on every list. */
  lastError: string | null
}

export interface ProxyToolDescriptor {
  name: string
  description?: string
  /** JSON Schema as published by the upstream server. Forwarded to
   *  the operator verbatim — they read it to figure out args. */
  inputSchema?: unknown
  /** Opaque metadata from the upstream tool listing. Carries client-side
   *  hints such as `x-client-resolve`. */
  _meta?: Record<string, unknown>
}

export interface ProxyAliasSummary {
  alias: string
  importId: string
  source: DiscoveredMcp["source"]
  type: DiscoveredMcp["type"]
  /** "connected" | "error" | "pending" — pending = never tried yet. */
  status: "connected" | "error" | "pending"
  toolCount: number
  lastError?: string
}

export interface CallResult {
  ok: true
  result: unknown
}
export interface CallError {
  ok: false
  error: string
}
export type ProxyCallOutcome = CallResult | CallError

export class McpProxyRegistry {
  private clients = new Map<string, ProxyClient>()
  private lastMtimeMs = 0
  /** Sentinel so we know whether the file has *ever* been read.
   *  Distinguishes "file missing on first call" (legit empty state)
   *  from "we've read it before and it's gone" (treat as empty too,
   *  but only after closing live clients). */
  private hasReadOnce = false

  /**
   * Reload the imports file when its mtime has advanced. Avoids
   * repeated parsing when nothing changed — most calls are no-ops.
   * Disconnects clients whose import was removed; connects the new
   * set lazily (the first call that touches them).
   */
  async ensureCurrent(): Promise<void> {
    let mtimeMs = 0
    try {
      const st = await fs.stat(IMPORTED_MCPS_PATH())
      mtimeMs = st.mtimeMs
    } catch {
      // ENOENT — empty imports state. If we'd previously loaded
      // some, close them.
      mtimeMs = 0
    }
    if (this.hasReadOnce && mtimeMs === this.lastMtimeMs) return

    const config = await loadImportedMcps().catch(() => ({
      version: 1 as const,
      imports: [] as ImportedMcpEntry[],
    }))
    const wantedIds = new Set(config.imports.map(e => e.id))

    // Drop clients for imports the user removed.
    for (const [id, c] of this.clients.entries()) {
      if (!wantedIds.has(id)) {
        await safeClose(c.client)
        this.clients.delete(id)
      }
    }
    // Add placeholders for new imports — connect lazily.
    for (const entry of config.imports) {
      const existing = this.clients.get(entry.id)
      if (existing) {
        // Snapshot may have changed (user re-imported same id with
        // different command). Detect by comparing serialised
        // snapshots; on mismatch, force reconnect.
        if (
          JSON.stringify(existing.entry.snapshot) !==
          JSON.stringify(entry.snapshot)
        ) {
          await safeClose(existing.client)
          this.clients.set(entry.id, freshPlaceholder(entry))
        } else {
          existing.entry = entry
        }
      } else {
        this.clients.set(entry.id, freshPlaceholder(entry))
      }
    }
    this.lastMtimeMs = mtimeMs
    this.hasReadOnce = true
  }

  /**
   * Lazy connect: the first call to `connectIfNeeded(alias)`
   * actually opens the transport + handshakes. Subsequent calls
   * reuse the live client.
   */
  private async connectIfNeeded(alias: string): Promise<ProxyClient | null> {
    await this.ensureCurrent()
    const handle = this.findByAlias(alias)
    if (!handle) return null
    if (handle.client) return handle
    try {
      const client = await openClient(handle.entry)
      handle.client = client
      handle.lastError = null
      // Eagerly fetch tools so listTools doesn't pay the round-trip
      // on next call. Cheap (single tools/list request).
      const t = await client.listTools()
      handle.tools = t.tools.map(toDescriptor)
      return handle
    } catch (err) {
      handle.client = null
      handle.tools = null
      handle.lastError = err instanceof Error ? err.message : String(err)
      return handle
    }
  }

  /** Find a client handle by alias *or* import id (defensive — agents
   *  sometimes pass the id from `mcp_imported_list`). */
  private findByAlias(aliasOrId: string): ProxyClient | undefined {
    for (const c of this.clients.values()) {
      if (c.entry.alias === aliasOrId) return c
      if (c.entry.id === aliasOrId) return c
    }
    return undefined
  }

  async listAliases(): Promise<ProxyAliasSummary[]> {
    await this.ensureCurrent()
    return Array.from(this.clients.values()).map(c => ({
      alias: c.entry.alias,
      importId: c.entry.id,
      source: c.entry.snapshot.source,
      type: c.entry.snapshot.type,
      status: c.client
        ? "connected"
        : c.lastError
          ? "error"
          : "pending",
      toolCount: c.tools?.length ?? 0,
      ...(c.lastError ? { lastError: c.lastError } : {}),
    }))
  }

  async listTools(
    alias: string
  ): Promise<{ ok: true; tools: ProxyToolDescriptor[] } | { ok: false; error: string }> {
    const handle = await this.connectIfNeeded(alias)
    if (!handle) return { ok: false, error: `unknown alias "${alias}"` }
    if (!handle.client || !handle.tools) {
      return {
        ok: false,
        error: handle.lastError ?? "client not connected",
      }
    }
    return { ok: true, tools: handle.tools }
  }

  async callTool(
    alias: string,
    toolName: string,
    args: unknown
  ): Promise<ProxyCallOutcome> {
    const handle = await this.connectIfNeeded(alias)
    if (!handle) return { ok: false, error: `unknown alias "${alias}"` }
    if (!handle.client) {
      return {
        ok: false,
        error: handle.lastError ?? "client not connected",
      }
    }
    const hint = handle.tools
      ?.find(t => t.name === toolName)
      ?._meta?.["x-client-resolve"] as
      | { read: string; inject: string }
      | undefined
    const resolved = await applyClientResolve(hint, args)
    try {
      const result = await handle.client.callTool({
        name: toolName,
        arguments:
          resolved && typeof resolved === "object"
            ? (resolved as Record<string, unknown>)
            : {},
      })
      return { ok: true, result }
    } catch (err) {
      // Mark the client as dirty — the connection may have died
      // mid-call (process crash, http server restart). The next call
      // re-opens via connectIfNeeded.
      const msg = err instanceof Error ? err.message : String(err)
      if (/closed|disconnect|EPIPE|ECONNRESET/i.test(msg)) {
        await safeClose(handle.client)
        handle.client = null
        handle.tools = null
        handle.lastError = msg
      }
      return { ok: false, error: msg }
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map(c => safeClose(c.client))
    )
    this.clients.clear()
  }
}

/**
 * Generic client-side file resolution driven by the upstream tool's
 * `_meta["x-client-resolve"]` hint: `{ read: "<path-field>", inject: "<data-field>" }`.
 *
 * When the hint is present and `args[read]` is a local path whose `args[inject]`
 * is not yet set, the proxy reads the file on the client machine, base64-encodes
 * it, and injects it before forwarding — zero context tokens, works even when
 * the MCP server is remote. Any tool from any server can opt in by declaring
 * `x-client-resolve` in its `_meta`.
 */
async function applyClientResolve(
  hint: { read: string; inject: string } | undefined,
  args: unknown
): Promise<unknown> {
  if (!hint) return args
  if (!args || typeof args !== "object") return args
  const a = args as Record<string, unknown>
  if (typeof a[hint.read] !== "string" || a[hint.inject] !== undefined)
    return args
  try {
    const bytes = await fs.readFile(a[hint.read] as string)
    return { ...a, [hint.inject]: bytes.toString("base64") }
  } catch {
    return args
  }
}

function freshPlaceholder(entry: ImportedMcpEntry): ProxyClient {
  return { entry, client: null, tools: null, lastError: null }
}

function toDescriptor(tool: {
  name: string
  description?: string
  inputSchema?: unknown
  _meta?: Record<string, unknown>
}): ProxyToolDescriptor {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    ...(tool._meta ? { _meta: tool._meta } : {}),
  }
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
function expandEnvPlaceholders(
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

async function safeClose(client: Client | null): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch {
    // best-effort
  }
}

/**
 * Open a transport for a discovered MCP. stdio spawns the command;
 * http/sse open over the network. Returns a connected `Client` on
 * success; throws with a useful message on failure.
 */
async function openClient(entry: ImportedMcpEntry): Promise<Client> {
  const snap = entry.snapshot
  const client = new Client(
    { name: "agentproto-daemon-proxy", version: "0.1.0" },
    { capabilities: {} }
  )
  if (snap.type === "stdio") {
    if (!snap.command) {
      throw new Error(
        `import "${entry.alias}" is stdio but has no command field`
      )
    }
    // claude-code / cursor / vscode all support `${VAR}` placeholders
    // in the env map (and the more permissive `${VAR:-default}`
    // form). Our scanner stores the snapshot verbatim — expand at
    // spawn time so live env changes work without a re-import, and
    // tokens like REPLICATE_API_TOKEN don't end up forwarded as the
    // literal string `${REPLICATE_API_TOKEN}`.
    const expandedEnv = expandEnvPlaceholders(snap.env ?? {})
    const transport = new StdioClientTransport({
      command: snap.command,
      args: snap.args ?? [],
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
  if (snap.type === "http") {
    if (!snap.url) throw new Error(`import "${entry.alias}" has no url`)
    const transport = new StreamableHTTPClientTransport(new URL(snap.url), {
      requestInit: {
        headers: snap.headers ?? {},
      },
    })
    await client.connect(transport)
    return client
  }
  if (snap.type === "sse") {
    if (!snap.url) throw new Error(`import "${entry.alias}" has no url`)
    const transport = new SSEClientTransport(new URL(snap.url), {
      requestInit: {
        headers: snap.headers ?? {},
      },
    })
    await client.connect(transport)
    return client
  }
  throw new Error(
    `import "${entry.alias}" has unsupported transport type "${snap.type}"`
  )
}
