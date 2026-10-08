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
import { z } from "zod"
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
  /** First retry delay after a failed refresh; doubles per attempt up to `retryMaxMs`. */
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (line: string) => void
}

interface Entry {
  /** Stable identity: event name + canonical arguments (the daemon's own id is not trusted to stay the same). */
  key: string
  /** Latest subscription id the daemon returned. */
  id: string
  args: SubscribeArgs
  timer?: unknown
}

const SubscribeSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict()
const UnsubscribeSchema = SubscribeSchema.omit({ ttlMs: true })

const MIN_REFRESH_MS = 30_000

/** JSON with sorted object keys, so equal arguments always produce the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const keyOf = (args: Pick<SubscribeArgs, "name" | "arguments">) => `${args.name}\u0000${canonical(args.arguments)}`

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
  const retryBaseMs = opts.retryBaseMs ?? 15_000
  const retryMaxMs = opts.retryMaxMs ?? 300_000
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
    const key = keyOf(args)
    // One live entry per name+arguments, whatever id the daemon hands back: a replaced entry's timer must die with it.
    const previous = entries.get(key)
    if (previous?.timer) clearTimer(previous.timer)
    const entry: Entry = { key, id: String(result.id ?? ""), args }
    const refreshBefore = typeof result.refreshBefore === "string" ? Date.parse(result.refreshBefore) : NaN
    if (Number.isFinite(refreshBefore)) {
      const delay = Math.max(MIN_REFRESH_MS, (refreshBefore - now()) * refreshFraction)
      entry.timer = setTimer(() => void refresh(entry, refreshBefore, 0), delay)
    }
    entries.set(key, entry)
    return result
  }

  /** Re-subscribe before expiry; on failure retry with backoff until the granted lifetime runs out. */
  async function refresh(entry: Entry, deadline: number, attempt: number): Promise<void> {
    try {
      await subscribe(entry.args) // success replaces this entry and schedules the next refresh
    } catch (error) {
      log(`refresh of ${entry.id} failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`)
      const wait = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs)
      if (entries.get(entry.key) !== entry) return // unsubscribed or replaced meanwhile
      if (now() + wait >= deadline) {
        log(`giving up on ${entry.id}: the subscription lapses at ${new Date(deadline).toISOString()}`)
        return
      }
      entry.timer = setTimer(() => void refresh(entry, deadline, attempt + 1), wait)
    }
  }

  async function unsubscribe(args: Pick<SubscribeArgs, "name" | "arguments">): Promise<Record<string, unknown>> {
    const base = await opts.publicBase()
    const result = await opts.daemon.request("events/unsubscribe", {
      name: args.name,
      arguments: args.arguments,
      delivery: { mode: "webhook", url: `${base}${opts.hookPath}` },
    })
    const key = keyOf(args)
    const entry = entries.get(key)
    if (entry?.timer) clearTimer(entry.timer)
    entries.delete(key)
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
    const params = request.params.arguments ?? {}
    try {
      if (request.params.name === "events_list") return text(await opts.daemon.request("events/list", {}))
      if (request.params.name === "events_subscribe") return text(await subscribe(SubscribeSchema.parse(params)))
      if (request.params.name === "events_unsubscribe") return text(await unsubscribe(UnsubscribeSchema.parse(params)))
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { isError: true, content: [{ type: "text" as const, text: `invalid arguments: ${error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` }] }
      }
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
