import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { EventsListRequestSchema, registerEventsMethods, type EventsMethodsHandlers } from "@agentproto/mcp-server"
import type { EventsStreamHandler } from "./mcp-modern/index.js"
import { McpEventsError, eventsList, type EventsListRequest } from "./mcp-events/adapter.js"
import type { Principal } from "./mcp-events/events-registry.js"

/** MCP Events `-32024 Forbidden`. */
const ERR_FORBIDDEN = -32024
const forbiddenError = (message: string): McpError => new McpError(ERR_FORBIDDEN, message)

export interface EventsSurfaceOptions {
  version: string
  /** Real adapter handlers, already bound to a principal by the caller. */
  handlers: EventsMethodsHandlers
  /** `owner/repo` values a subscriber may watch. Empty = every subscribe is refused. */
  repoAllowlist: readonly string[]
}

/** Pure allowlist check, exported for tests. */
export function isSubscriptionPermitted(params: Record<string, unknown>, repoAllowlist: readonly string[]): boolean {
  const args = params.arguments
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false
  const repo = (args as Record<string, unknown>).repo
  return typeof repo === "string" && repoAllowlist.includes(repo)
}

/**
 * The ONLY server ever exposed on the public events origin. Built from scratch: `events/*` plus one harmless probe
 * tool. It must never gain tools, resources or prompts without a security review (see mcp-events-surface.test.ts).
 */
export function createEventsSurfaceServer(opts: EventsSurfaceOptions): McpServer {
  const server = new McpServer({ name: "agentproto-events", version: opts.version }, { capabilities: { tools: {} } })
  server.registerTool(
    "events_ping",
    { description: "Liveness probe for the events surface. Returns ok.", inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  )
  registerEventsMethods(server, {
    list: params => opts.handlers.list(params),
    subscribe: async params => {
      if (!isSubscriptionPermitted(params, opts.repoAllowlist)) throw forbiddenError("subscription not permitted")
      return opts.handlers.subscribe(params)
    },
    unsubscribe: params => opts.handlers.unsubscribe(params),
    // Reading is as sensitive as subscribing: the public origin must not expose a repo outside the allowlist.
    ...(opts.handlers.poll
      ? {
          poll: async (params: Record<string, unknown>) => {
            if (!isSubscriptionPermitted(params, opts.repoAllowlist)) throw forbiddenError("poll not permitted")
            return opts.handlers.poll!(params)
          },
        }
      : {}),
  })
  return server
}

/**
 * `events/stream` on the public origin: the same repo allowlist as poll and subscribe, checked BEFORE the stream
 * opens (`-32024`, no slot, no lease, no frame).
 */
export function guardEventsStream(handler: EventsStreamHandler, repoAllowlist: readonly string[]): EventsStreamHandler {
  return {
    open: async request => {
      if (!isSubscriptionPermitted(request.params, repoAllowlist)) {
        throw new McpEventsError(ERR_FORBIDDEN, "stream not permitted", { reason: "not_permitted" })
      }
      return handler.open(request)
    },
  }
}

/**
 * Re-register `events/list` on a MODERN-era per-request server so each type lists `push` (`events/stream` is served
 * there). The legacy 2025-11-25 transport never runs this, so it keeps listing `["poll", "webhook"]`. Must be called
 * after `registerEventsMethods` and before the server is connected.
 */
export function registerPushAwareEventsList(server: McpServer, principal: Principal): void {
  server.server.setRequestHandler(
    EventsListRequestSchema,
    async request =>
      (await eventsList((request.params ?? {}) as EventsListRequest, {
        principal,
        pollEnabled: true,
        pushEnabled: true,
      })) as unknown as Record<string, unknown>,
  )
}
