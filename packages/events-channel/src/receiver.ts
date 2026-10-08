/**
 * Callback receiver for MCP Events webhook deliveries.
 *
 * `createDeliveryHandler` is transport-free (headers + raw body in, status
 * out) so it is testable without binding a port; `startReceiver` is the thin
 * node:http wrapper that gates on the secret path before anything is read.
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
}

const header = (headers: DeliveryInput["headers"], name: string): string => {
  const value = headers[name]
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "")
}

export function createDeliveryHandler(opts: DeliveryHandlerOptions): (input: DeliveryInput) => Promise<DeliveryResult> {
  const seen = new Set<string>()
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
    // Ack duplicates (the daemon redelivers on any non-2xx) without pushing them to the session again.
    if (seen.has(record.eventId)) return { status: 200, body: "ok" }

    try {
      await opts.onEvent(record as unknown as McpEventEnvelope, header(headers, "x-mcp-subscription-id"))
    } catch {
      return { status: 500 }
    }
    seen.add(record.eventId)
    return { status: 200, body: "ok" }
  }
}

export interface Receiver {
  port: number
  close(): Promise<void>
}

export async function startReceiver(opts: {
  hookPath: string
  port?: number
  handle: (input: DeliveryInput) => Promise<DeliveryResult>
}): Promise<Receiver> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== opts.hookPath) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      opts
        .handle({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
        .then(result => res.writeHead(result.status, result.body ? { "content-type": "application/json" } : {}).end(result.body))
        .catch(() => res.writeHead(500).end())
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
