import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { registerEventsMethods, type EventsMethodsHandlers } from "@agentproto/mcp-server"

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
      if (!isSubscriptionPermitted(params, opts.repoAllowlist)) {
        throw new McpError(ErrorCode.InvalidParams, "subscription not permitted")
      }
      return opts.handlers.subscribe(params)
    },
    unsubscribe: params => opts.handlers.unsubscribe(params),
  })
  return server
}
