/**
 * The relay's own HTTP surface:
 *
 *   POST /relay/inbound   auth + rate-limited; wakes the ONE configured
 *                         target session with the request's `text`.
 *   GET  /relay/health    trivial healthcheck, no auth.
 *
 * The target session is never a request parameter — it's baked into
 * `config.targetSession` at process startup (see config.ts) and that's
 * the only session this server will ever touch.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as defaultDaemonClient from "./daemon-client.js"
import type { DeliveryResult, SessionAliveResult } from "./daemon-client.js"
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js"
import { timingSafeEqualStrings } from "./timing-safe.js"
import type { RelayConfig } from "./config.js"

export interface DaemonClient {
  checkSessionAlive(daemonUrl: string, target: string): Promise<SessionAliveResult>
  resolveDaemonToken(daemonUrl: string): Promise<string | undefined>
  sendAgentPrompt(
    daemonUrl: string,
    sessionId: string,
    text: string,
    token: string | undefined,
  ): Promise<DeliveryResult>
  sendTerminalInput(
    daemonUrl: string,
    sessionId: string,
    text: string,
    token: string | undefined,
  ): Promise<DeliveryResult>
}

export interface CreateRelayServerOptions {
  config: RelayConfig
  daemonClient?: DaemonClient
  rateLimiter?: RateLimiter
}

const MAX_BODY_BYTES = 1_000_000

export function createRelayServer(opts: CreateRelayServerOptions): Server {
  const daemonClient = opts.daemonClient ?? defaultDaemonClient
  const rateLimiter = opts.rateLimiter ?? createRateLimiter(opts.config.rateLimit)

  return createServer((req, res) => {
    handleRequest(req, res, opts.config, daemonClient, rateLimiter).catch(err => {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  daemonClient: DaemonClient,
  rateLimiter: RateLimiter,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://relay.local")

  if (url.pathname === "/relay/health" && req.method === "GET") {
    writeJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/relay/inbound" && req.method === "POST") {
    await handleInbound(req, res, config, daemonClient, rateLimiter)
    return
  }

  writeJson(res, 404, { error: "not_found" })
}

async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  daemonClient: DaemonClient,
  rateLimiter: RateLimiter,
): Promise<void> {
  // Rate limit before anything else — including before auth — so a
  // flood of requests (valid token or not) can't cost more than the
  // configured budget of daemon calls.
  if (!rateLimiter.allow()) {
    writeJson(res, 429, {
      error: "rate_limited",
      message: `Too many requests — limit is ${config.rateLimit.max} per ${config.rateLimit.windowMs}ms.`,
    })
    return
  }

  const authHeader = req.headers.authorization ?? ""
  const expected = `Bearer ${config.token}`
  if (!timingSafeEqualStrings(authHeader, expected)) {
    writeJson(res, 401, { error: "unauthorized" })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES)
  } catch (err) {
    writeJson(res, 400, {
      error: "invalid_body",
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (body === INVALID_JSON) {
    writeJson(res, 400, { error: "invalid_body", message: "Body must be valid JSON." })
    return
  }
  const text = (body as { text?: unknown } | null)?.text
  if (typeof text !== "string" || text.length === 0) {
    writeJson(res, 400, {
      error: "missing_text",
      message: "Body must include a non-empty top-level `text` string. All other fields are ignored.",
    })
    return
  }

  const alive = await daemonClient.checkSessionAlive(config.daemonUrl, config.targetSession)
  if (!alive.ok || !alive.id) {
    writeJson(res, 502, {
      error: "target_session_unavailable",
      message: alive.reason ?? "target session is not available",
    })
    return
  }

  const token = await daemonClient.resolveDaemonToken(config.daemonUrl)

  const result =
    config.targetVia === "terminal"
      ? await daemonClient.sendTerminalInput(config.daemonUrl, alive.id, text, token)
      : await daemonClient.sendAgentPrompt(config.daemonUrl, alive.id, text, token)

  if (!result.ok) {
    const status = result.status && result.status >= 400 && result.status < 500 ? result.status : 502
    writeJson(res, status, {
      error: "relay_delivery_failed",
      message: result.message ?? "delivery to the target session failed",
    })
    return
  }

  writeJson(res, 202, { ok: true, sessionId: alive.id, via: config.targetVia })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const INVALID_JSON = Symbol("invalid_json")

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        resolve(INVALID_JSON)
      }
    })
    req.on("error", reject)
  })
}
