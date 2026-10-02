/**
 * Native MCP Events methods (W-C of `.plans/sentinel-mcp-events/PLAN.md`).
 *
 * The official OpenAI MCP Events integration requires THREE NATIVE JSON-RPC
 * methods — `events/list`, `events/subscribe`, `events/unsubscribe` — on the
 * SAME authenticated MCP endpoint as `tools`, plus an `events:{}` capability
 * in the `server/discover` response. These are NOT `tools/call` tools, so
 * `register-builtin-tool` cannot express them.
 *
 * This module owns the TRANSPORT mechanism (request schemas, native dispatch
 * via `Server.setRequestHandler`, and the discovery capability). The adapter
 * logic behind the handlers lives in `@agentproto/runtime`'s `mcp-events`
 * module and is injected — the transport package must not depend on runtime.
 *
 * Schemas are intentionally loose: the adapter validates params (returning
 * `-32602`/`-32015` with a reason), so the transport must not reject a shape
 * first and turn a typed error into a generic one.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js"

/** Protocol version the MCP Events integration advertises (official doc). */
export const MCP_EVENTS_PROTOCOL_VERSION = "2026-07-28"

const LooseParams = z.object({}).loose()

export const ServerDiscoverRequestSchema = z.object({
  method: z.literal("server/discover"),
  params: LooseParams.optional(),
})

export const EventsListRequestSchema = z.object({
  method: z.literal("events/list"),
  params: LooseParams.optional(),
})

export const EventsSubscribeRequestSchema = z.object({
  method: z.literal("events/subscribe"),
  params: LooseParams.optional(),
})

export const EventsUnsubscribeRequestSchema = z.object({
  method: z.literal("events/unsubscribe"),
  params: LooseParams.optional(),
})

export interface ServerDiscoverResult {
  resultType: "complete"
  supportedVersions: string[]
  capabilities: {
    tools: Record<string, never>
    events: Record<string, never>
  }
}

export interface EventsMethodsHandlers {
  list(params: Record<string, unknown>): Promise<unknown>
  subscribe(params: Record<string, unknown>): Promise<unknown>
  unsubscribe(params: Record<string, unknown>): Promise<unknown>
}

/**
 * Register the three native methods and the `server/discover` capability on
 * an `McpServer` that is already on the authenticated `/mcp` surface. Must be
 * called before the server is connected to a transport.
 */
export function registerEventsMethods(server: McpServer, handlers: EventsMethodsHandlers): void {
  // Advertise `events` alongside `tools` at initialize too, not only in
  // `server/discover` — a spec-compliant host may read either.
  server.server.registerCapabilities({ events: {} } as unknown as ServerCapabilities)

  server.server.setRequestHandler(ServerDiscoverRequestSchema, async () =>
    ({
      resultType: "complete",
      supportedVersions: [MCP_EVENTS_PROTOCOL_VERSION],
      capabilities: { tools: {}, events: {} },
    }) as Record<string, unknown>,
  )
  // The adapter returns domain-shaped objects; the SDK's request-handler
  // return type only requires a JSON object, so each result is widened at the
  // boundary (an adapter throw still propagates untouched).
  server.server.setRequestHandler(EventsListRequestSchema, async (request) =>
    (await handlers.list((request.params ?? {}) as Record<string, unknown>)) as Record<string, unknown>,
  )
  server.server.setRequestHandler(EventsSubscribeRequestSchema, async (request) =>
    (await handlers.subscribe((request.params ?? {}) as Record<string, unknown>)) as Record<string, unknown>,
  )
  server.server.setRequestHandler(EventsUnsubscribeRequestSchema, async (request) =>
    (await handlers.unsubscribe((request.params ?? {}) as Record<string, unknown>)) as Record<string, unknown>,
  )
}
