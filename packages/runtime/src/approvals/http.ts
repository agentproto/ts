/**
 * HTTP twins over the approvals engine — for non-MCP clients (a product
 * like Pygmalion's core): `POST /approvals`, `GET /approvals?status=`,
 * `GET /approvals/:id`, `GET /approvals/:id/wait`,
 * `POST /approvals/:id/consume`, plus the ONE decide route reachable over
 * HTTP: `web_click` (`POST /approvals/:id/decision`). There is no HTTP
 * ticket-minting or `ui_card` decide route — those live only inside the
 * card's `ui://` resource (`card.ts`) and the app-only
 * `approval_card_decide` MCP tool (`card-tool.ts`).
 *
 * Mirrors `handleTasks`/`handlePermissions`'s shape in `http-server.ts`.
 * An HTTP caller has no MCP session identity, so every request/consume
 * made through this surface is `{operator: true}` — same convention as
 * `/tasks`, `/policies`.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

import { ApprovalError, ApprovalNotPendingError, parseApprovalStatus, type ApprovalRequester } from "./types.js"
import type { ApprovalsEngine } from "./engine.js"

export interface ApprovalsHttpAuth {
  /** The daemon's per-boot bearer token. Absent ⇒ the `web_click` decision
   *  route can never pass the token half of its gate. */
  token?: string
  /** `approvals.webOrigins` — exact-match allowlist for the `web_click`
   *  decision route. Empty ⇒ the channel is off; the route always 403s. */
  webOrigins: readonly string[]
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    return undefined
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorStatus(code: ApprovalError["code"]): number {
  switch (code) {
    case "approval_not_found":
      return 404
    case "not_requester":
      return 403
    case "approval_already_consumed":
    case "approval_not_approved":
    case "approval_expired":
      return 409
    case "payload_mismatch":
      return 400
  }
}

export async function handleApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  engine: ApprovalsEngine,
  auth: ApprovalsHttpAuth,
): Promise<boolean> {
  const requester: ApprovalRequester = { operator: true }

  if (path === "/approvals" && req.method === "GET") {
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "")
    const status = parseApprovalStatus(qs.get("status"))
    json(res, 200, { approvals: engine.list(status ? { status } : undefined) })
    return true
  }

  if (path === "/approvals" && req.method === "POST") {
    const body = await readJsonBody(req)
    if (
      !isJsonRecord(body) ||
      typeof body.kind !== "string" ||
      typeof body.title !== "string" ||
      !("payload" in body)
    ) {
      json(res, 400, { error: "invalid_body", message: "body must include kind, title, preview, payload" })
      return true
    }
    try {
      const record = engine.request(
        {
          kind: body.kind,
          title: body.title,
          preview: body.preview,
          payload: body.payload,
          ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
          ...(typeof body.appId === "string" ? { appId: body.appId } : {}),
          ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
        },
        requester,
      )
      json(res, 201, record)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // POST /approvals/:id/decision — the ONE decide route reachable over
  // HTTP, `web_click` only. BOTH gates must pass: an Origin present in
  // `auth.webOrigins`, AND the daemon's bearer token. A null/missing
  // Origin (or one not on the list) always 403s, before the token is even
  // checked — the approval stays pending either way.
  const decisionMatch = path.match(/^\/approvals\/([^/]+)\/decision$/)
  if (decisionMatch && req.method === "POST") {
    const id = decodeURIComponent(decisionMatch[1] ?? "")
    const origin = req.headers.origin
    if (typeof origin !== "string" || origin.length === 0 || !auth.webOrigins.includes(origin)) {
      json(res, 403, {
        error: "forbidden_origin",
        message: "web_click decisions require an Origin in the configured approvals.webOrigins allowlist.",
      })
      return true
    }
    const header = req.headers.authorization
    if (!auth.token || header !== `Bearer ${auth.token}`) {
      json(res, 401, { error: "unauthorized", message: "web_click decisions require the daemon's bearer token." })
      return true
    }
    const body = await readJsonBody(req)
    const decision = isJsonRecord(body) ? body.decision : undefined
    if (decision !== "approve" && decision !== "deny") {
      json(res, 400, { error: "invalid_decision", message: 'body.decision must be "approve" or "deny"' })
      return true
    }
    const ipAddress = req.socket.remoteAddress ?? "unknown"
    const userAgentHeader = req.headers["user-agent"]
    const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : "unknown"
    try {
      const record = await engine.decideWeb(id, decision, { ipAddress, userAgent })
      json(res, 200, record)
    } catch (err) {
      if (err instanceof ApprovalError) json(res, errorStatus(err.code), { error: err.code, message: err.message })
      else if (err instanceof ApprovalNotPendingError) json(res, 409, { error: "not_pending", message: err.message })
      else json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  const waitMatch = path.match(/^\/approvals\/([^/]+)\/wait$/)
  if (waitMatch && req.method === "GET") {
    const id = decodeURIComponent(waitMatch[1] ?? "")
    const reqUrl = req.url ?? ""
    const qs = new URLSearchParams(reqUrl.includes("?") ? reqUrl.slice(reqUrl.indexOf("?") + 1) : "")
    const requestedMs = Number(qs.get("timeoutMs") ?? 45_000)
    const timeoutMs = Math.min(Number.isFinite(requestedMs) && requestedMs >= 0 ? requestedMs : 45_000, 45_000)
    const record = await engine.wait(id, timeoutMs)
    if (!record) {
      json(res, 404, { error: "approval_not_found", approvalId: id })
      return true
    }
    json(res, 200, record)
    return true
  }

  const consumeMatch = path.match(/^\/approvals\/([^/]+)\/consume$/)
  if (consumeMatch && req.method === "POST") {
    const id = decodeURIComponent(consumeMatch[1] ?? "")
    const body = await readJsonBody(req)
    if (!isJsonRecord(body) || !("payload" in body)) {
      json(res, 400, { error: "invalid_body", message: "body must include payload" })
      return true
    }
    try {
      const record = engine.consume(id, requester, body.payload)
      json(res, 200, record)
    } catch (err) {
      if (err instanceof ApprovalError) json(res, errorStatus(err.code), { error: err.code, message: err.message })
      else json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  const idMatch = path.match(/^\/approvals\/([^/]+)$/)
  if (idMatch && req.method === "GET") {
    const id = decodeURIComponent(idMatch[1] ?? "")
    const record = engine.get(id)
    if (!record) {
      json(res, 404, { error: "approval_not_found", approvalId: id })
      return true
    }
    json(res, 200, record)
    return true
  }

  if (path === "/approvals" || idMatch || decisionMatch || waitMatch || consumeMatch) {
    json(res, 405, { error: "method_not_allowed" })
    return true
  }
  return false
}
