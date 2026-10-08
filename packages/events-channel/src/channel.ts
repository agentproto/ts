/**
 * The Claude Code channel server: an MCP server that declares the
 * `claude/channel` capability, exposes `events_list` / `events_subscribe` /
 * `events_unsubscribe`, and pushes verified MCP Events deliveries into the
 * session as `notifications/claude/channel`.
 *
 * The daemon connection and the public callback base are injected, so the
 * whole core runs in tests against an in-memory transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createDeliveryHandler, type DeliveryInput, type DeliveryResult, type McpEventEnvelope } from "./receiver.js"
import { generateSecret } from "./webhook.js"

/** Minimal client for the daemon's native `events/*` JSON-RPC methods. */
export interface EventsDaemon {
  request(method: "events/list" | "events/subscribe" | "events/unsubscribe", params: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface SubscribeArgs {
  name: string
  arguments: Record<string, unknown>
  ttlMs?: number
}

export interface EventsChannelOptions {
  daemon: EventsDaemon
  /** Public https base that reaches the receiver (resolved lazily; may take a while to warm up). */
  publicBase: () => Promise<string>
  /** Unguessable path the receiver serves, e.g. `/hook/<random>`. */
  hookPath: string
  secret?: string
  /** Re-subscribe at this fraction of the granted lifetime. */
  refreshFraction?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (line: string) => void
}

interface Entry {
  id: string
  args: SubscribeArgs
  timer?: unknown
}

export interface EventsChannel {
  /** The MCP server to connect to a stdio transport. */
  server: Server
  /** Hand a verified-or-not delivery to the channel (wire this to the receiver). */
  handleDelivery(input: DeliveryInput): Promise<DeliveryResult>
  subscribe(args: SubscribeArgs): Promise<Record<string, unknown>>
  unsubscribe(args: Pick<SubscribeArgs, "name" | "arguments">): Promise<Record<string, unknown>>
  /** Unsubscribe everything and cancel refresh timers. */
  close(): Promise<void>
}

const INSTRUCTIONS =
  'Events from agentproto MCP Events arrive as <channel source="agentproto-events" event="..." event_id="..." subscription_id="...">. ' +
  "The body is a one-line summary followed by the JSON event. They are one-way notifications: read them and act on them, no reply is expected. " +
  "Use events_list to see subscribable events, events_subscribe to start receiving one (arguments follow the event's inputSchema), and events_unsubscribe to stop."

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] })

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b)

export function createEventsChannel(opts: EventsChannelOptions): EventsChannel {
  const secret = opts.secret ?? generateSecret()
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return handle
  })
  const clearTimer = opts.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout))
  const refreshFraction = opts.refreshFraction ?? 0.8
  const log = opts.log ?? (() => {})
  const entries = new Map<string, Entry>()

  const server = new Server(
    { name: "agentproto-events", version: "0.0.1" },
    { capabilities: { experimental: { "claude/channel": {} }, tools: {} }, instructions: INSTRUCTIONS },
  )

  const handleDelivery = createDeliveryHandler({
    secret,
    onEvent: async (event: McpEventEnvelope, subscriptionId: string) => {
      const summary = typeof event.data?.summary === "string" ? event.data.summary : event.name
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: `${summary}\n${JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data })}`,
          // meta keys become tag attributes; values are stripped to safe characters.
          meta: { event: event.name.replace(/[^A-Za-z0-9_.]/g, "_"), event_id: event.eventId, subscription_id: subscriptionId },
        },
      })
      log(`pushed ${event.eventId} (${event.name})`)
    },
  })

  async function subscribe(args: SubscribeArgs): Promise<Record<string, unknown>> {
    const base = await opts.publicBase()
    const result = await opts.daemon.request("events/subscribe", {
      name: args.name,
      arguments: args.arguments,
      delivery: { mode: "webhook", url: `${base}${opts.hookPath}`, secret },
      ...(args.ttlMs ? { ttlMs: args.ttlMs } : {}),
    })
    const id = String(result.id ?? "")
    const previous = entries.get(id)
    if (previous?.timer) clearTimer(previous.timer)
    const entry: Entry = { id, args }
    const refreshBefore = typeof result.refreshBefore === "string" ? Date.parse(result.refreshBefore) : NaN
    if (Number.isFinite(refreshBefore)) {
      const delay = Math.max(30_000, (refreshBefore - now()) * refreshFraction)
      entry.timer = setTimer(() => {
        subscribe(args).catch(error => log(`refresh of ${id} failed: ${error instanceof Error ? error.message : String(error)}`))
      }, delay)
    }
    entries.set(id, entry)
    return result
  }

  async function unsubscribe(args: Pick<SubscribeArgs, "name" | "arguments">): Promise<Record<string, unknown>> {
    const base = await opts.publicBase()
    const result = await opts.daemon.request("events/unsubscribe", {
      name: args.name,
      arguments: args.arguments,
      delivery: { mode: "webhook", url: `${base}${opts.hookPath}` },
    })
    for (const [id, entry] of entries) {
      if (entry.args.name === args.name && sameArgs(entry.args.arguments, args.arguments)) {
        if (entry.timer) clearTimer(entry.timer)
        entries.delete(id)
      }
    }
    return result
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "events_list",
        description: "List the events the agentproto daemon lets you subscribe to, with each event's inputSchema.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "events_subscribe",
        description: "Subscribe this session to an agentproto MCP Event. Matching events arrive as <channel> notifications. Arguments must follow the event's inputSchema from events_list.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object" },
            ttlMs: { type: "number", description: "Optional lifetime; the channel refreshes before expiry." },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
      {
        name: "events_unsubscribe",
        description: "Stop receiving an event subscription (same name and arguments used to subscribe).",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, arguments: { type: "object" } },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const params = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      if (request.params.name === "events_list") return text(await opts.daemon.request("events/list", {}))
      if (request.params.name === "events_subscribe") return text(await subscribe(params as unknown as SubscribeArgs))
      if (request.params.name === "events_unsubscribe") return text(await unsubscribe(params as unknown as SubscribeArgs))
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
    }
    throw new Error(`unknown tool: ${request.params.name}`)
  })

  return {
    server,
    handleDelivery,
    subscribe,
    unsubscribe,
    async close() {
      for (const entry of [...entries.values()]) await unsubscribe(entry.args).catch(() => {})
    },
  }
}
