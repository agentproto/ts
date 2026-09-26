/**
 * McpAppsHostService — the daemon as the MCP client that fetches MCP App
 * UIs (spec 2026-01-26) on behalf of a session's chat UI.
 *
 * In a session the MCP client is the harness (claude-code, codex, …); it
 * keeps a tool's `_meta.ui.resourceUri` and the `ui://` resource to itself,
 * and the transcript only carries `mcp__<server>__<tool>` + input + result.
 * So the chat asks the daemon, which resolves `<server>` for that session
 * (mcp-app-resolve.ts), connects through a config-keyed pool
 * (mcp-client-pool.ts), and answers three questions:
 *
 *   uiIndex   which of this server's tools declare a UI (+ app-only tools)
 *   readUi    the HTML + `_meta.ui` of one of those `ui://` resources
 *   callTool  an iframe-initiated `tools/call`, allowlisted and recorded
 *
 * None of these throw: every failure is a `status` (or an `isError`
 * result). Failures are cached per (session, alias) for 60s so a
 * transcript full of calls to a dead server costs one attempt a minute.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { McpClientPool, PooledMcpClient } from "./mcp-client-pool.js"
import type { McpServerConfigSource, ResolvedMcpServer } from "./mcp-app-resolve.js"

export type McpAppServerStatus =
  | "ok"
  | "unresolved"
  | "unreachable"
  | "auth_required"

export interface McpAppUiIndex {
  server: string
  status: McpAppServerStatus
  tools: Array<{ name: string; resourceUri: string; appOnly: boolean }>
  appOnlyTools: string[]
  error?: string
  source?: McpServerConfigSource
}

export interface McpAppUiCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export interface McpAppUi {
  resourceUri: string
  html: string
  mimeType: string
  csp?: McpAppUiCsp
  permissions?: Record<string, unknown>
  prefersBorder?: boolean
  domain?: string
}

export interface McpAppUiReadError {
  error: string
  status: McpAppServerStatus
}

/** Durable record of an iframe-initiated call, appended to the session's
 *  events.jsonl as `kind: "mcp_app_tool_call"`. Never carries args or
 *  results. */
export interface McpAppToolCallRecord {
  server: string
  tool: string
  originToolCallId: string
  isError: boolean
  durationMs: number
}

export interface McpAppsHostDeps {
  pool: McpClientPool
  /** Resolve `alias` for a session. `undefined` = unknown session. */
  resolve(sessionId: string, alias: string): Promise<ResolvedMcpServer | null | undefined>
  /** Append the call record to the session's event log. */
  recordToolCall?(sessionId: string, record: McpAppToolCallRecord): void
  /** Tool name the transcript recorded for a tool-call id (the card that
   *  hosts the iframe), e.g. `mcp__guilde__guilde_dashboard`. */
  lookupToolCallName?(sessionId: string, toolCallId: string): Promise<string | undefined>
  /** Default 60s. */
  negativeTtlMs?: number
  now?: () => number
}

const DEFAULT_NEGATIVE_TTL_MS = 60_000

interface CacheEntry<T> {
  at: number
  value: T
}

export class McpAppsHostService {
  private readonly negative = new Map<string, CacheEntry<McpAppUiIndex>>()
  private readonly resolved = new Map<string, CacheEntry<ResolvedMcpServer>>()
  private readonly ttl: number
  private readonly now: () => number

  constructor(private readonly deps: McpAppsHostDeps) {
    this.ttl = deps.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
    this.now = deps.now ?? Date.now
  }

  async uiIndex(sessionId: string, server: string): Promise<McpAppUiIndex> {
    return (await this.connect(sessionId, server)).index
  }

  async readUi(
    sessionId: string,
    server: string,
    resourceUri: string
  ): Promise<McpAppUi | McpAppUiReadError> {
    const { index, client } = await this.connect(sessionId, server)
    if (index.status !== "ok" || !client) {
      return { error: index.error ?? `server "${server}" is ${index.status}`, status: index.status }
    }
    if (!index.tools.some(t => t.resourceUri === resourceUri)) {
      return {
        error: `resourceUri "${resourceUri}" is not declared by any tool of server "${server}"`,
        status: "ok",
      }
    }
    try {
      const read = await client.readResource(resourceUri)
      const content = read.contents[0]
      if (!content) {
        return { error: `resources/read "${resourceUri}" returned no contents`, status: "ok" }
      }
      const html =
        "text" in content && typeof content.text === "string"
          ? content.text
          : "blob" in content && typeof content.blob === "string"
            ? Buffer.from(content.blob, "base64").toString("utf8")
            : ""
      return {
        resourceUri,
        html,
        mimeType: content.mimeType ?? "",
        ...uiMetaOf(content._meta),
      }
    } catch (err) {
      const { status, error } = classifyMcpError(err)
      return { error, status }
    }
  }

  async callTool(input: {
    sessionId: string
    server: string
    tool: string
    args?: Record<string, unknown>
    originToolCallId: string
  }): Promise<CallToolResult> {
    const { sessionId, server, tool, originToolCallId } = input
    const { index, client } = await this.connect(sessionId, server)
    if (index.status !== "ok" || !client) {
      return errorResult(
        `mcp_app_tool_call: server "${server}" is ${index.status}` +
          (index.error ? `: ${index.error}` : "")
      )
    }
    const allowed =
      index.tools.some(t => t.name === tool) ||
      index.appOnlyTools.includes(tool) ||
      (await this.isOriginTool(sessionId, originToolCallId, server, tool))
    if (!allowed) {
      return errorResult(
        `mcp_app_tool_call: tool "${tool}" is not callable from an app UI on server "${server}" ` +
          `(allowed: its UI tools, its app-only tools, or the tool whose card hosts the app)`
      )
    }
    const startedAt = this.now()
    let result: CallToolResult
    try {
      result = await client.callTool(tool, input.args ?? {})
    } catch (err) {
      result = errorResult(`mcp_app_tool_call "${server}".${tool}: ${errorMessage(err)}`)
    }
    this.deps.recordToolCall?.(sessionId, {
      server,
      tool,
      originToolCallId,
      isError: result.isError === true,
      durationMs: this.now() - startedAt,
    })
    return result
  }

  /** Resolve + connect, with the per-(session, alias) caches. A non-ok
   *  outcome is remembered for `ttl`; a resolution for `ttl` too (so the
   *  config files aren't re-read per call), while an ok index is always
   *  the pooled client's own cache. */
  private async connect(
    sessionId: string,
    server: string
  ): Promise<{ index: McpAppUiIndex; client?: PooledMcpClient }> {
    const key = `${sessionId}\u0000${server}`
    const now = this.now()
    const neg = this.negative.get(key)
    if (neg && now - neg.at < this.ttl) return { index: neg.value }
    this.negative.delete(key)

    const fail = (
      status: Exclude<McpAppServerStatus, "ok">,
      error: string,
      source?: McpServerConfigSource
    ): { index: McpAppUiIndex } => {
      const index: McpAppUiIndex = {
        server,
        status,
        tools: [],
        appOnlyTools: [],
        error,
        ...(source ? { source } : {}),
      }
      this.negative.set(key, { at: now, value: index })
      this.resolved.delete(key)
      return { index }
    }

    let resolved: ResolvedMcpServer | null | undefined
    const cached = this.resolved.get(key)
    if (cached && now - cached.at < this.ttl) {
      resolved = cached.value
    } else {
      try {
        resolved = await this.deps.resolve(sessionId, server)
      } catch (err) {
        return fail("unresolved", `resolving "${server}" failed: ${errorMessage(err)}`)
      }
      if (resolved) this.resolved.set(key, { at: now, value: resolved })
    }
    if (resolved === undefined) return fail("unresolved", `unknown session "${sessionId}"`)
    if (resolved === null) {
      return fail("unresolved", `no MCP server named "${server}" in this session's scope`)
    }

    const client = this.deps.pool.get(resolved.config, `server "${server}"`)
    try {
      const ui = await client.uiIndex()
      return {
        index: {
          server,
          status: "ok",
          tools: ui.tools.map(t => ({ ...t })),
          appOnlyTools: [...ui.appOnlyTools],
          source: resolved.source,
        },
        client,
      }
    } catch (err) {
      const { status, error } = classifyMcpError(err)
      return fail(status, error, resolved.source)
    }
  }

  private async isOriginTool(
    sessionId: string,
    originToolCallId: string,
    server: string,
    tool: string
  ): Promise<boolean> {
    if (!this.deps.lookupToolCallName) return false
    const name = await this.deps.lookupToolCallName(sessionId, originToolCallId).catch(() => undefined)
    if (!name) return false
    return (
      name === tool ||
      name === `mcp__${server}__${tool}` ||
      name === `mcp.${server}.${tool}`
    )
  }
}

/** Map a connect / list / read failure onto the contract's statuses. */
export function classifyMcpError(err: unknown): {
  status: "unreachable" | "auth_required"
  error: string
} {
  const error = errorMessage(err)
  if (err instanceof UnauthorizedError) return { status: "auth_required", error }
  if ((err instanceof StreamableHTTPError || err instanceof SseError) && err.code === 401) {
    return { status: "auth_required", error }
  }
  if (/\b401\b|unauthori[sz]ed/i.test(error)) return { status: "auth_required", error }
  return { status: "unreachable", error }
}

function uiMetaOf(meta: unknown): Pick<McpAppUi, "csp" | "permissions" | "prefersBorder" | "domain"> {
  if (!isRecord(meta) || !isRecord(meta.ui)) return {}
  const ui = meta.ui
  return {
    ...(isRecord(ui.csp) ? { csp: ui.csp as McpAppUiCsp } : {}),
    ...(isRecord(ui.permissions) ? { permissions: ui.permissions } : {}),
    ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
    ...(typeof ui.domain === "string" ? { domain: ui.domain } : {}),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}
