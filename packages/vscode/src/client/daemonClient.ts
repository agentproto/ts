/**
 * Typed HTTP + MCP client for the agentproto daemon. This is the ONLY
 * module that talks to the daemon over the network — everything else in
 * the extension goes through a DaemonClient instance.
 *
 * Auth (recon §Auth): the daemon's per-boot bearer token is auto-resolved
 * from (in order): an explicit config.tokenPath override → the active
 * workspace's `<cwd>/.agentproto/runtime.json` → the global
 * `~/.agentproto/daemons/<port>.json` keyed by the daemon's listen port.
 * Loopback requests without a token are accepted by the daemon in its
 * default "none" auth mode, so a missing token is non-fatal — methods
 * still work, they just don't send the Authorization header.
 *
 * Every method throws on a non-2xx response. JSON-RPC 2.0 `tools/call`
 * results (POST /mcp) are unwrapped from the MCP content envelope into a
 * parsed JS value.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { DaemonConfig } from "../config.js"
import type {
  AdapterInfo,
  DaemonHealth,
  PendingPermission,
  SessionDescriptor,
  SessionEventsPage,
  SessionEventsPollResult,
} from "./types.js"

export interface SessionEventsOptions {
  /** Return only records with seq > since (cursor for incremental polling). */
  since?: number
  /** Cap the page size (daemon clamps to [1, 2000], default 500). */
  limit?: number
}

/** Raised when a session has no structured events.jsonl (terminal/command
 *  sessions, or one that predates the capture) so callers can fall back to
 *  raw output instead of treating it as a hard error. */
export class NoTranscriptError extends Error {
  constructor(public readonly sessionId: string) {
    super(`no structured transcript for session ${sessionId}`)
    this.name = "NoTranscriptError"
  }
}

export interface SpawnAgentOptions {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  resumeSessionId?: string
  mode?: string
  model?: string
  effort?: string
  auth?: {
    mode: "subscription" | "api-key"
    token?: string
    apiKey?: string
  }
  prompt?: string
  label?: string
  role?: string
  promptAppend?: string
  orchestrator?: boolean | object
  mcpServers?: unknown[]
  trace?: boolean
  permissionHold?: boolean
}

export interface PromptOptions {
  interrupt?: boolean
  /** wait=true blocks until the turn ends; wait=false is fire-and-forget. */
  wait?: boolean
}

export interface WaitOptions {
  event?: "turn-end" | "awaiting-input" | "exited" | "any"
  since?: number
  timeoutMs?: number
}

export interface RespondPermissionInput {
  decision: "approve" | "deny"
  optionId?: string
  scope?: "once" | "always"
}

export class DaemonClient {
  private readonly config: DaemonConfig
  private readonly fetchImpl: typeof fetch
  private tokenPromise: Promise<string | undefined> | undefined

  constructor(config: DaemonConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  /** Base daemon URL, trailing slash stripped. */
  get url(): string {
    return this.config.daemonUrl.replace(/\/+$/, "")
  }

  // ── Health & sessions ───────────────────────────────────────────────

  async health(): Promise<DaemonHealth> {
    return this.getJson<DaemonHealth>("/health")
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    const body = await this.getJson<{ sessions: SessionDescriptor[] }>("/sessions")
    return body.sessions ?? []
  }

  async getSession(id: string): Promise<SessionDescriptor> {
    return this.getJson<SessionDescriptor>(`/sessions/${encodeURIComponent(id)}`)
  }

  async spawnAgent(opts: SpawnAgentOptions): Promise<SessionDescriptor> {
    return this.postJson<SessionDescriptor>("/sessions/agent", opts)
  }

  async prompt(
    id: string,
    prompt: string,
    opts: PromptOptions = {},
  ): Promise<unknown> {
    const wait = opts.wait ?? true
    const url = `/sessions/${encodeURIComponent(id)}/prompt?wait=${wait ? "true" : "false"}`
    return this.postJson<unknown>(url, {
      prompt,
      ...(opts.interrupt ? { interrupt: true } : {}),
    })
  }

  async kill(id: string): Promise<{ ok: boolean; sessionId: string }> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/kill`, {})
  }

  async deleteSession(id: string): Promise<{ ok: boolean; id: string }> {
    return this.deleteJson(`/sessions/${encodeURIComponent(id)}`)
  }

  async exportSession(
    id: string,
    format: "markdown" | "json" = "markdown",
  ): Promise<{ content: string; format: string; adapter?: string }> {
    const url = `/sessions/${encodeURIComponent(id)}/export?format=${format}`
    return this.getJson(url)
  }

  async preview(
    id: string,
    lines = 10,
  ): Promise<{ id: string; lines: string[]; bytes: string | null }> {
    const url = `/sessions/${encodeURIComponent(id)}/preview?lines=${lines}`
    return this.getJson(url)
  }

  async wait(id: string, opts: WaitOptions = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (opts.event) params.set("event", opts.event)
    if (typeof opts.since === "number") params.set("since", String(opts.since))
    if (typeof opts.timeoutMs === "number") params.set("timeoutMs", String(opts.timeoutMs))
    const qs = params.toString()
    const url = `/sessions/${encodeURIComponent(id)}/wait${qs ? `?${qs}` : ""}`
    return this.getJson(url)
  }

  /**
   * GET /sessions/:id/events — a page of the daemon's durable, normalized
   * structured events (events.jsonl). This is the semantic source the
   * transcript panel hydrates and live-polls from (NOT the flattened
   * /stream lines, and NOT the global /events runtime stream).
   *
   * Throws {@link NoTranscriptError} on a 404 no_transcript so terminal-only
   * sessions can fall back to raw output; any other non-2xx throws normally.
   */
  async getSessionEvents(
    id: string,
    opts: SessionEventsOptions = {},
  ): Promise<SessionEventsPage> {
    const params = new URLSearchParams()
    if (typeof opts.since === "number") params.set("since", String(opts.since))
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit))
    const qs = params.toString()
    const path = `/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`
    const token = await this.resolveToken()
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) {
      // Distinguish "no structured transcript" from other 404s so callers
      // can degrade to raw output rather than surfacing an error.
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (body.error === "no_transcript") throw new NoTranscriptError(id)
    }
    if (!res.ok) {
      throw new Error(`GET ${path} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    return (await res.json()) as SessionEventsPage
  }

  // ── Permissions ────────────────────────────────────────────────────

  async listPermissions(
    sessionId?: string,
  ): Promise<PendingPermission[]> {
    const url = sessionId
      ? `/permissions?sessionId=${encodeURIComponent(sessionId)}`
      : "/permissions"
    const body = await this.getJson<{ permissions: PendingPermission[] }>(url)
    return body.permissions ?? []
  }

  async respondPermission(
    id: string,
    input: RespondPermissionInput,
  ): Promise<{ ok: true; id: string; sessionId: string; decision: string; optionId?: string }> {
    return this.postJson(`/permissions/${encodeURIComponent(id)}`, input)
  }

  // ── Tunnels ────────────────────────────────────────────────────────

  async listTunnels(): Promise<unknown[]> {
    const body = await this.getJson<{ tunnels: unknown[] }>("/tunnels")
    return body.tunnels ?? []
  }

  // ── MCP surface (/mcp JSON-RPC 2.0) ────────────────────────────────

  /**
   * Invoke an MCP tool over the stateless /mcp endpoint (JSON-RPC 2.0
   * `tools/call`). Returns the parsed tool result — the MCP content
   * envelope is unwrapped, and a JSON text payload is JSON-parsed. Used
   * for MCP-only surfaces like adapter_list and session_events_poll.
   */
  async mcpCall<T = unknown>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
    const token = await this.resolveToken()
    const res = await this.fetchImpl(`${this.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable-HTTP MCP servers 406 unless the client accepts BOTH.
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`MCP ${toolName} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    const envelope = await parseMcpBody(res)
    if (envelope.error) {
      throw new Error(`MCP ${toolName} error: ${JSON.stringify(envelope.error)}`)
    }
    return unwrapMcpResult<T>(envelope.result)
  }

  /**
   * adapter_list is an MCP-only tool — fetch the daemon's installed
   * adapter registry via mcpCall("adapter_list").
   */
  async listAdapters(): Promise<AdapterInfo[]> {
    const result = await this.mcpCall<{ adapters?: AdapterInfo[] } | AdapterInfo[]>(
      "adapter_list",
    )
    if (Array.isArray(result)) return result
    return result.adapters ?? []
  }

  /**
   * session_events_poll — the daemon's cursor-based session lifecycle
   * stream. See SessionStore for the resilient poll loop that drives this.
   */
  async sessionEventsPoll(
    since = 0,
    types?: string[],
  ): Promise<SessionEventsPollResult> {
    return this.mcpCall<SessionEventsPollResult>("session_events_poll", {
      since,
      ...(types ? { types } : {}),
    })
  }

  // ── Token resolution (recon §Auth) ─────────────────────────────────

  /**
   * Resolve the daemon bearer token. Cached per-instance. Resolution
   * order: config.tokenPath override → workspace runtime.json →
   * ~/.agentproto/daemons/<port>.json. Returns undefined when no token
   * can be found (loopback daemons accept that).
   */
  resolveToken(): Promise<string | undefined> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.doResolveToken().catch(() => undefined)
    }
    return this.tokenPromise
  }

  /** Force re-resolution on the next call (e.g. after a config change). */
  invalidateToken(): void {
    this.tokenPromise = undefined
  }

  private async doResolveToken(): Promise<string | undefined> {
    const { tokenPath } = this.config
    if (tokenPath) {
      const t = await readTokenFile(tokenPath)
      if (t) return t
    }
    // Workspace-scoped runtime.json — best effort. /health is a public
    // liveness probe (no auth), so fetch it DIRECTLY rather than through
    // this.health() → request() → resolveToken(), which would cycle.
    const wsToken = await this.readWorkspaceToken()
    if (wsToken) return wsToken
    // Global per-port registry.
    return readPortRegistryToken(this.url, homedir())
  }

  private async readWorkspaceToken(): Promise<string | undefined> {
    try {
      const res = await this.fetchImpl(`${this.url}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return undefined
      const health = (await res.json()) as { workspace?: unknown }
      if (typeof health.workspace !== "string" || !health.workspace) return undefined
      return readTokenFile(join(health.workspace, ".agentproto", "runtime.json"))
    } catch {
      return undefined
    }
  }

  // ── HTTP primitives ─────────────────────────────────────────────────

  private async getJson<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  private async deleteJson<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.resolveToken()
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${res.status} ${await describeError(res)}`)
    }
    if (res.status === 204) return undefined as unknown as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as unknown as T
  }
}

// ── Token file helpers (no @agentproto/relay dep — hand-rolled, ~30 lines) ──

interface TokenFileMeta {
  token?: unknown
  pid?: unknown
}

async function readTokenFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    const meta = JSON.parse(raw) as TokenFileMeta
    return typeof meta.token === "string" && meta.token ? meta.token : undefined
  } catch {
    return undefined
  }
}

async function readPortRegistryToken(
  daemonUrl: string,
  homeDir: string,
): Promise<string | undefined> {
  let port: string
  try {
    port = new URL(daemonUrl).port
  } catch {
    return undefined
  }
  if (!port) return undefined
  return readTokenFile(join(homeDir, ".agentproto", "daemons", `${port}.json`))
}

// ── MCP response unwrapping ──────────────────────────────────────────

interface McpContentItem {
  type: string
  text?: string
}

interface McpResult {
  content?: McpContentItem[]
  isError?: boolean
}

interface McpResponse {
  jsonrpc: "2.0"
  id: number
  result?: McpResult
  error?: { code: number; message: string; data?: unknown }
}

/**
 * A streamable-HTTP MCP server may answer either plain JSON or an SSE body
 * (content-type text/event-stream) even for a single request/response —
 * in the SSE case the JSON-RPC envelope is the first `data:` frame.
 */
async function parseMcpBody(res: Response): Promise<McpResponse> {
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    return (await res.json()) as McpResponse
  }
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    const parsed = JSON.parse(payload) as McpResponse
    if (parsed.result !== undefined || parsed.error !== undefined) return parsed
  }
  throw new Error("MCP SSE response contained no JSON-RPC envelope")
}

function unwrapMcpResult<T>(result: McpResult | undefined): T {
  if (!result) return undefined as unknown as T
  if (result.isError) {
    const text = result.content?.[0]?.text ?? "MCP tool returned an error"
    throw new Error(text)
  }
  const text = result.content?.[0]?.text
  if (typeof text !== "string") return undefined as unknown as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown }
    if (typeof body.message === "string") return body.message
    if (typeof body.error === "string") return body.error
    return JSON.stringify(body)
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Convenience constructor used by extension.ts — builds a DaemonClient
 * from the current workspace configuration.
 */
export function createDaemonClient(config: DaemonConfig): DaemonClient {
  return new DaemonClient(config)
}
