/**
 * What a session's harness ACTUALLY loaded from the daemon's own `/mcp`
 * mount, as opposed to what `mcpServers` merely declares.
 *
 * `session_capabilities` used to report only the declared mount, which is
 * exactly the blind spot that hid the "server/discover advertises an era we
 * don't serve" bug: the descriptor said `agentproto` was mounted while the
 * harness saw zero tools. The `/mcp` endpoint is stateless (a fresh
 * server+transport per POST), so the only place the session's handshake is
 * visible is the transport itself: this module wraps it (incoming
 * `initialize` / `server/discover` / `tools/list`, and the matching
 * responses) and keeps the latest outcome of each, keyed by the trusted
 * `?callerSessionId=` the self-mount carries.
 *
 * State is in memory only: a daemon restart resets it, and a harness
 * resumed after the restart reconnects (and re-lists) anyway.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { SessionDescriptor } from "./sessions.js"

/** Methods whose outcome tells us whether the harness loaded the mount. */
type ObservedMethod = "initialize" | "server/discover" | "tools/list"

const OBSERVED_METHODS: ReadonlySet<string> = new Set<ObservedMethod>([
  "initialize",
  "server/discover",
  "tools/list",
])

/** Descriptions are capped so ~70 sessions x ~275 tools stays small. */
const MAX_DESCRIPTION_CHARS = 200
const DEFAULT_MAX_SESSIONS = 500

export interface McpObservedCall {
  at: string
  ok: boolean
  /** `<code>: <message>` of the JSON-RPC error, or a transport failure note. */
  error?: string
  /** `initialize`: the version the server answered. Other methods: the
   *  `mcp-protocol-version` header the client sent. */
  protocolVersion?: string
}

export interface McpObservedTool {
  name: string
  description?: string
}

export interface McpToolsListObservation extends McpObservedCall {
  toolCount: number
  /** `true` when the list is the lazy projection (it carries `tool_search`,
   *  which only the deferred wrapper registers). */
  deferred: boolean
  tools: McpObservedTool[]
}

export interface McpSessionObservation {
  firstSeenAt: string
  lastSeenAt: string
  initialize?: McpObservedCall
  discover?: McpObservedCall
  toolsList?: McpToolsListObservation
  /** Last request that the transport rejected before any JSON-RPC message
   *  was read (e.g. a 400 on the protocol-version header). */
  httpError?: { at: string; status: number }
}

export interface McpObservationStore {
  /** Wrap an already-`connect()`ed transport. Never throws into the request. */
  observe(transport: Transport, ctx: { sessionId: string; clientProtocolVersion?: string }): void
  /** Record an HTTP-level rejection that produced no JSON-RPC message. */
  recordHttpError(sessionId: string, status: number): void
  get(sessionId: string): McpSessionObservation | undefined
  delete(sessionId: string): void
}

export function createMcpObservationStore(
  opts: { maxSessions?: number; now?: () => Date } = {},
): McpObservationStore {
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS
  const now = opts.now ?? (() => new Date())
  const bySession = new Map<string, McpSessionObservation>()

  const touch = (sessionId: string): McpSessionObservation => {
    const at = now().toISOString()
    let obs = bySession.get(sessionId)
    if (!obs) {
      obs = { firstSeenAt: at, lastSeenAt: at }
      bySession.set(sessionId, obs)
      if (bySession.size > maxSessions) {
        const oldest = bySession.keys().next().value
        if (oldest !== undefined) bySession.delete(oldest)
      }
    }
    obs.lastSeenAt = at
    return obs
  }

  const record = (
    sessionId: string,
    method: ObservedMethod,
    message: { result?: unknown; error?: { code?: unknown; message?: unknown } },
    clientProtocolVersion: string | undefined,
  ): void => {
    const obs = touch(sessionId)
    const at = obs.lastSeenAt
    const result =
      message.result && typeof message.result === "object" ? (message.result as Record<string, unknown>) : undefined
    // This daemon never registers `server/discover` (removed in #1684). A
    // harness that probes for it and gets JSON-RPC "Method not found" back is
    // doing normal protocol negotiation before falling back to `initialize` +
    // `tools/list`, not failing to load the mount.
    const isExpectedDiscoverMiss = method === "server/discover" && message.error?.code === -32601
    const error =
      message.error && !isExpectedDiscoverMiss
        ? `${String(message.error.code ?? "error")}: ${String(message.error.message ?? "")}`
        : undefined
    const answeredVersion = typeof result?.["protocolVersion"] === "string" ? (result["protocolVersion"] as string) : undefined
    const protocolVersion = method === "initialize" ? answeredVersion : clientProtocolVersion
    const base: McpObservedCall = {
      at,
      ok: error === undefined,
      ...(error !== undefined ? { error } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
    }
    if (method === "initialize") obs.initialize = base
    else if (method === "server/discover") obs.discover = base
    else {
      const rawTools = Array.isArray(result?.["tools"]) ? (result["tools"] as unknown[]) : []
      const tools: McpObservedTool[] = []
      for (const t of rawTools) {
        if (!t || typeof t !== "object") continue
        const name = (t as { name?: unknown }).name
        if (typeof name !== "string") continue
        const description = (t as { description?: unknown }).description
        tools.push({
          name,
          ...(typeof description === "string" && description.length > 0
            ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) }
            : {}),
        })
      }
      obs.toolsList = {
        ...base,
        toolCount: tools.length,
        deferred: tools.some(t => t.name === "tool_search"),
        tools,
      }
    }
  }

  return {
    observe(transport, ctx) {
      const pending = new Map<string | number, ObservedMethod>()
      const innerOnMessage = transport.onmessage
      transport.onmessage = (message, extra) => {
        try {
          if ("method" in message && "id" in message && message.id !== undefined && OBSERVED_METHODS.has(message.method)) {
            pending.set(message.id, message.method as ObservedMethod)
          }
        } catch {
          // observation must never break the request
        }
        innerOnMessage?.(message, extra)
      }
      const innerSend = transport.send.bind(transport)
      transport.send = async (message, options) => {
        try {
          if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) {
            const method = pending.get(message.id)
            if (method) {
              pending.delete(message.id)
              record(ctx.sessionId, method, message, ctx.clientProtocolVersion)
            }
          }
        } catch {
          // observation must never break the request
        }
        return innerSend(message, options)
      }
    },
    recordHttpError(sessionId, status) {
      const obs = touch(sessionId)
      obs.httpError = { at: obs.lastSeenAt, status }
    },
    get: sessionId => bySession.get(sessionId),
    delete: sessionId => {
      bySession.delete(sessionId)
    },
  }
}

/**
 * True when `entry` is the daemon's own `/mcp` mount stamped with this
 * session's id (`?callerSessionId=<id>`) — the one server whose handshake the
 * observer can see. Importers/user servers and the scoped orchestrator
 * gateway (`/mcp/orchestrator`) never match.
 */
export function isDaemonMountFor(
  sessionId: string,
  entry: { transport: string; ref?: string },
): boolean {
  if (entry.transport !== "http" || typeof entry.ref !== "string") return false
  try {
    const url = new URL(entry.ref)
    return url.pathname === "/mcp" && url.searchParams.get("callerSessionId") === sessionId
  } catch {
    return false
  }
}

export type McpMountStatus = "declared" | "connected" | "listed" | "error" | "never-contacted"

/**
 * Status of the daemon mount from what the observer saw.
 *  - `listed`: the latest `tools/list` succeeded (check `toolCount` for 0)
 *  - `error`: the latest `tools/list` failed, or the handshake failed before one
 *  - `connected`: `initialize`/`server/discover` seen, no `tools/list` yet
 *  - `never-contacted`: nothing seen although the session already ran a turn
 *  - `declared`: nothing seen yet and no turn has run (too early to tell)
 */
export function daemonMountStatus(
  obs: McpSessionObservation | undefined,
  turnsCompleted: number | undefined,
): McpMountStatus {
  if (!obs) return (turnsCompleted ?? 0) > 0 ? "never-contacted" : "declared"
  if (obs.toolsList) return obs.toolsList.ok ? "listed" : "error"
  if (obs.initialize?.ok === false || obs.discover?.ok === false || obs.httpError) return "error"
  if (obs.initialize || obs.discover) return "connected"
  return (turnsCompleted ?? 0) > 0 ? "never-contacted" : "declared"
}

export type McpDegradedReason = "never-listed" | "zero-tools" | "error"

export interface McpDegradedAssessment {
  reason: McpDegradedReason
  detail?: string
}

/** `undefined` when the mount looks healthy (tools/list answered with tools). */
export function assessDaemonMount(obs: McpSessionObservation | undefined): McpDegradedAssessment | undefined {
  const tl = obs?.toolsList
  if (tl) {
    if (!tl.ok) return { reason: "error", ...(tl.error ? { detail: tl.error } : {}) }
    if (tl.toolCount === 0) return { reason: "zero-tools" }
    return undefined
  }
  if (obs?.initialize?.ok === false) {
    return { reason: "error", ...(obs.initialize.error ? { detail: `initialize ${obs.initialize.error}` } : {}) }
  }
  if (obs?.discover?.ok === false) {
    return { reason: "error", ...(obs.discover.error ? { detail: `server/discover ${obs.discover.error}` } : {}) }
  }
  if (obs?.httpError) return { reason: "error", detail: `HTTP ${obs.httpError.status}` }
  return {
    reason: "never-listed",
    ...(obs?.initialize || obs?.discover ? { detail: "handshake seen but no tools/list" } : {}),
  }
}

/** Turn endings that say nothing about MCP (the turn itself failed or was cut). */
const ABNORMAL_TURN_REASONS: ReadonlySet<string> = new Set(["error", "cancelled", "watchdog-timeout", "aborted"])

/**
 * Emit `mcp:degraded` when a session finished a turn while its daemon mount
 * was never listed, listed zero tools, or failed. One event per distinct
 * (reason, detail) per session until the mount recovers or the session exits,
 * so a long conversation does not repeat it every turn.
 */
export function wireMcpDegradedWarnings(opts: {
  sessionEvents: SessionEventBus
  getSession: (sessionId: string) => SessionDescriptor | undefined
  store: McpObservationStore
}): () => void {
  const lastEmitted = new Map<string, string>()
  const offTurnEnd = opts.sessionEvents.on("session:turn-end", ev => {
    if (ev.reason !== undefined && ABNORMAL_TURN_REASONS.has(ev.reason)) return
    const desc = opts.getSession(ev.sessionId)
    if (!desc || desc.kind !== "agent-cli") return
    const mount = (desc.mcpServers ?? []).find(s => isDaemonMountFor(ev.sessionId, s))
    if (!mount) return
    const assessment = assessDaemonMount(opts.store.get(ev.sessionId))
    if (!assessment) {
      lastEmitted.delete(ev.sessionId)
      return
    }
    const key = `${assessment.reason}|${assessment.detail ?? ""}`
    if (lastEmitted.get(ev.sessionId) === key) return
    lastEmitted.set(ev.sessionId, key)
    opts.sessionEvents.emit({
      type: "mcp:degraded",
      sessionId: ev.sessionId,
      server: mount.name,
      reason: assessment.reason,
      ...(assessment.detail ? { detail: assessment.detail } : {}),
      ...(desc.label ? { label: desc.label } : {}),
      ts: new Date().toISOString(),
    })
  })
  const offExit = opts.sessionEvents.on("session:exited", ev => {
    lastEmitted.delete(ev.sessionId)
  })
  // A resumed harness is a new process that handshakes again: drop the old
  // process's observation so it cannot mask a regression.
  const offResumed = opts.sessionEvents.on("session:resumed", ev => {
    lastEmitted.delete(ev.sessionId)
    opts.store.delete(ev.sessionId)
  })
  return () => {
    offTurnEnd()
    offExit()
    offResumed()
  }
}
