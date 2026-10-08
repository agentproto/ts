/**
 * Callback receiver for MCP Events webhook deliveries.
 *
 * `createDeliveryHandler` is transport-free (headers + raw body in, status
 * out) so it is testable without binding a port; `startReceiver` is the thin
 * node:http wrapper that gates on the secret path and caps the body before
 * anything is read or verified.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { verifyWebhook } from "./webhook.js"

/** The envelope the daemon POSTs (MCP Events §3). */
export interface McpEventEnvelope {
  eventId: string
  name: string
  timestamp?: string
  data?: Record<string, unknown>
  cursor?: string | null
}

export interface DeliveryInput {
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface DeliveryResult {
  status: number
  body?: string
}

export interface DeliveryHandlerOptions {
  secret: string
  /** Called once per new, verified event. A throw yields a 500 so the daemon retries. */
  onEvent: (event: McpEventEnvelope, subscriptionId: string) => Promise<void>
  nowSeconds?: () => number
  /** How many delivered event ids to remember for dedupe (oldest evicted first). */
  maxSeen?: number
}

/** Request bodies above this are refused before any parsing (a webhook envelope is a few KiB). */
export const MAX_BODY_BYTES = 1024 * 1024

const DEFAULT_MAX_SEEN = 5000

const header = (headers: DeliveryInput["headers"], name: string): string => {
  const value = headers[name]
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "")
}

export function createDeliveryHandler(opts: DeliveryHandlerOptions): (input: DeliveryInput) => Promise<DeliveryResult> {
  const maxSeen = opts.maxSeen ?? DEFAULT_MAX_SEEN
  // Insertion-ordered, so the first key is the oldest. Bounded: a long-lived session must not grow without limit.
  const seen = new Set<string>()
  const remember = (eventId: string) => {
    seen.add(eventId)
    if (seen.size > maxSeen) seen.delete(seen.values().next().value as string)
  }
  // A redelivery that arrives while the first copy is still being pushed waits for it and gets the same status,
  // so the session sees the event once even under concurrent retries.
  const inflight = new Map<string, Promise<DeliveryResult>>()

  return async ({ headers, body }) => {
    const ok = verifyWebhook(
      opts.secret,
      { id: header(headers, "webhook-id"), timestamp: header(headers, "webhook-timestamp"), signature: header(headers, "webhook-signature") },
      body,
      opts.nowSeconds?.(),
    )
    // Unsigned or stale traffic never reaches the session: an open channel is a prompt-injection hole.
    if (!ok) return { status: 401 }

    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return { status: 400 }
    }
    if (typeof message !== "object" || message === null) return { status: 400 }
    const record = message as Record<string, unknown>

    // Subscribe-time challenge: echo it back.
    if (typeof record.challenge === "string") {
      return { status: 200, body: JSON.stringify({ challenge: record.challenge }) }
    }

    if (typeof record.eventId !== "string" || typeof record.name !== "string") return { status: 400 }
    const eventId = record.eventId
    // Ack duplicates (the daemon redelivers on any non-2xx) without pushing them to the session again.
    if (seen.has(eventId)) return { status: 200, body: "ok" }
    const pending = inflight.get(eventId)
    if (pending) return pending

    const work = (async (): Promise<DeliveryResult> => {
      try {
        await opts.onEvent(record as unknown as McpEventEnvelope, header(headers, "x-mcp-subscription-id"))
      } catch {
        return { status: 500 }
      }
      remember(eventId)
      return { status: 200, body: "ok" }
    })()
    inflight.set(eventId, work)
    try {
      return await work
    } finally {
      inflight.delete(eventId)
    }
  }
}

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`)
  }
}

/** Collect a request body as UTF-8, failing as soon as it exceeds `limit` bytes. */
export async function readCappedBody(stream: AsyncIterable<Buffer | string>, limit: number = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) throw new BodyTooLargeError(limit)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export interface Receiver {
  port: number
  close(): Promise<void>
}

export async function startReceiver(opts: {
  hookPath: string
  port?: number
  maxBodyBytes?: number
  handle: (input: DeliveryInput) => Promise<DeliveryResult>
}): Promise<Receiver> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== opts.hookPath) {
      res.writeHead(404).end()
      return
    }
    readCappedBody(req, opts.maxBodyBytes ?? MAX_BODY_BYTES)
      .then(body => opts.handle({ headers: req.headers, body }))
      .then(result => res.writeHead(result.status, result.body ? { "content-type": "application/json" } : {}).end(result.body))
      .catch(error => {
        if (error instanceof BodyTooLargeError) {
          res.writeHead(413, { connection: "close" }).end()
          req.destroy()
          return
        }
        res.writeHead(500).end()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
