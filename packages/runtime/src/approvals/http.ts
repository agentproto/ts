/**
 * HTTP twins over the approvals engine — for non-MCP clients (a product
 * like Pygmalion's core): `POST /approvals`, `GET /approvals?status=`,
 * `GET /approvals/:id`, `GET /approvals/:id/wait`,
 * `POST /approvals/:id/consume`, plus the two decide routes reachable over
 * HTTP: `web_click` (`POST /approvals/:id/decision`) and `telegram`
 * (`POST /approvals/:id/decision/telegram`). There is no HTTP
 * ticket-minting or `ui_card` decide route — those live only inside the
 * card's `ui://` resource (`card.ts`) and the app-only
 * `approval_card_decide` MCP tool (`card-tool.ts`).
 *
 * `telegram` trusts a shared bearer secret instead of `web_click`'s
 * Origin check — a Telegram webhook callback has no browser Origin to
 * verify, so the bridge service holding `approvals.telegramBotSecret` IS
 * the credential, the same way `web_click`'s Origin+token pair is.
 *
 * `GET /approvals/:id/attachments` lists the files `preview.attachments`
 * names and `GET /approvals/:id/attachments/:name` serves one (four content
 * types only, never HTML or SVG as such, 25 MB at most).
 *
 * An approval link (a link-session token whose `approvalId` claim names one
 * approval, `app-link-gate.ts`) reaches exactly these routes,
 * `GET /approvals/:id`, the two files routes (action `files`) and
 * `POST /approvals/:id/decision/telegram`, for that
 * one id, and only for a verified Telegram user listed in the owner-only
 * `approvals.humanTelegramIds`. It replaces the bot secret on the decide
 * route for that request; the secret keeps working for the bot bridge.
 * Every refusal is the same 403 `approval_link_forbidden`, so a caller never
 * learns which condition failed (an allow-listed id included).
 *
 * Mirrors `handleTasks`/`handlePermissions`'s shape in `http-server.ts`.
 * An HTTP caller has no MCP session identity, so every request/consume
 * made through this surface is `{operator: true}` — same convention as
 * `/tasks`, `/policies`.
 */

import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"

import {
  appLinkApprovalRefusal,
  logAppLinkApprovalAccess,
  type AppLinkApprovalRequest,
} from "../app-link-gate.js"
import {
  ApprovalError,
  ApprovalNotPendingError,
  parseApprovalStatus,
  type ApprovalRecord,
  type ApprovalReachOption,
  type ApprovalRequester,
  type ApprovalWakeTarget,
} from "./types.js"
import type { ApprovalsEngine } from "./engine.js"
import { readAttachmentNames, resolveAttachments } from "./telegram-attachments.js"

export interface ApprovalsHttpAuth {
  /** The daemon's per-boot bearer token. Absent ⇒ the `web_click` decision
   *  route can never pass the token half of its gate. */
  token?: string
  /** `approvals.webOrigins` — exact-match allowlist for the `web_click`
   *  decision route. Empty ⇒ the channel is off; the route always 403s. */
  webOrigins: readonly string[]
  /** `approvals.telegramBotSecret` — shared secret gating the `telegram`
   *  decision route. Absent ⇒ the channel is off; the route always 403s. */
  telegramBotSecret?: string
  /** The approval link this request carries (`appLinkApprovalRequest`,
   *  resolved once per request by the caller). Present ⇒ the request is
   *  served in link mode and NEVER as the operator, whatever its claims. */
  link?: AppLinkApprovalRequest
  /** `approvals.humanTelegramIds`: Telegram user ids allowed to use an
   *  approval link. Empty/absent ⇒ every link is refused. */
  humanTelegramIds?: readonly string[]
  /** The folder an approval's files are relative to (the one resolver the
   *  Telegram bridge uses too). Absent ⇒ every name is a `no-folder` problem. */
  attachmentDir?: (record: ApprovalRecord) => string | undefined | Promise<string | undefined>
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

type FileViewer = "pdf" | "image" | "markdown" | "text" | "html" | "file"

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}
const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "svg"])
const PLAIN = "text/plain; charset=utf-8"

/** The viewer and the one content type the daemon serves, from the extension only. */
function fileType(name: string): { viewer: FileViewer; mimeType: string } {
  const dot = name.lastIndexOf(".")
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
  if (ext === "pdf") return { viewer: "pdf", mimeType: "application/pdf" }
  const image = IMAGE_TYPES[ext]
  if (image) return { viewer: "image", mimeType: image }
  if (ext === "md" || ext === "markdown") return { viewer: "markdown", mimeType: PLAIN }
  if (TEXT_EXTENSIONS.has(ext)) return { viewer: "text", mimeType: PLAIN }
  if (ext === "html" || ext === "htm") return { viewer: "html", mimeType: PLAIN }
  return { viewer: "file", mimeType: "application/octet-stream" }
}

interface ListedFile {
  name: string
  size: number
  path: string
}
interface FileProblem {
  name: string
  reason: string
  size?: number
}

/** The approval's files as the contract lists them: each name in exactly one
 *  of the two lists. Path checks are `resolveAttachments`'s. */
async function listApprovalFiles(
  record: ApprovalRecord,
  attachmentDir: ApprovalsHttpAuth["attachmentDir"],
): Promise<{ files: ListedFile[]; problems: FileProblem[] }> {
  const { names, problems: nameProblems } = readAttachmentNames(record.preview)
  const files: ListedFile[] = []
  const problems: FileProblem[] = nameProblems.map(p => ({
    name: p.name,
    reason: p.reason.startsWith("over the limit") ? "too-many" : "missing",
  }))
  const dir = record.appId && attachmentDir ? await attachmentDir(record) : undefined
  for (const name of names) {
    if (dir === undefined) {
      problems.push({ name, reason: "no-folder" })
      continue
    }
    const { files: ok, problems: bad } = await resolveAttachments([name], dir)
    const hit = ok[0]
    if (hit) {
      if (hit.size > MAX_FILE_BYTES) problems.push({ name, reason: "too-large", size: hit.size })
      else files.push({ name, size: hit.size, path: hit.path })
      continue
    }
    const why = bad[0]?.reason ?? ""
    if (why.startsWith("empty file") || why.startsWith("too large")) {
      // `resolveAttachments` already proved the real path is inside the folder.
      const real = await realpath(join(dir, name)).catch(() => undefined)
      const info = real ? await stat(real).catch(() => undefined) : undefined
      if (real && info) {
        if (info.size > MAX_FILE_BYTES) problems.push({ name, reason: "too-large", size: info.size })
        else files.push({ name, size: info.size, path: real })
        continue
      }
    }
    problems.push({
      name,
      reason: why.startsWith("refused")
        ? "outside-folder"
        : why.startsWith("no folder")
          ? "no-folder"
          : why === "not a file"
            ? "not-a-file"
            : "missing",
    })
  }
  return { files, problems }
}

function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function serveApprovalFiles(
  res: ServerResponse,
  record: ApprovalRecord,
  encodedName: string | undefined,
  attachmentDir: ApprovalsHttpAuth["attachmentDir"],
): Promise<void> {
  const { files, problems } = await listApprovalFiles(record, attachmentDir)
  if (encodedName === undefined) {
    json(res, 200, {
      attachments: files.map(f => ({
        name: f.name,
        size: f.size,
        ...fileType(f.name),
        url: `/approvals/${encodeURIComponent(record.id)}/attachments/${encodeURIComponent(f.name)}`,
      })),
      problems,
    })
    return
  }
  let name: string
  try {
    name = decodeURIComponent(encodedName)
  } catch {
    json(res, 404, { error: "attachment_not_found" })
    return
  }
  if (problems.some(p => p.name === name && p.reason === "too-large")) {
    json(res, 413, { error: "attachment_too_large" })
    return
  }
  const file = files.find(f => f.name === name)
  const info = file ? await stat(file.path).catch(() => undefined) : undefined
  if (!file || !info?.isFile()) {
    json(res, 404, { error: "attachment_not_found" })
    return
  }
  if (info.size > MAX_FILE_BYTES) {
    json(res, 413, { error: "attachment_too_large" })
    return
  }
  const { viewer, mimeType } = fileType(file.name)
  res.writeHead(200, {
    "content-type": mimeType,
    "content-length": info.size,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": `${viewer === "file" ? "attachment" : "inline"}; filename*=UTF-8''${rfc5987(file.name)}`,
  })
  if (info.size === 0) {
    res.end()
    return
  }
  const stream = createReadStream(file.path, { end: info.size - 1 })
  stream.on("error", () => res.destroy())
  stream.pipe(res)
}

const FILES_PATH_RE = /^\/approvals\/([^/]+)\/attachments(?:\/([^/]+))?$/

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

/** Link mode: read or decide exactly the claimed approval, nothing else.
 *  Authorization (claim, Telegram identity, allow-list) is checked before
 *  the body is read or the approval is looked up. */
async function handleApprovalLink(
  req: IncomingMessage,
  res: ServerResponse,
  engine: ApprovalsEngine,
  link: AppLinkApprovalRequest,
  humanTelegramIds: readonly string[],
  attachmentDir: ApprovalsHttpAuth["attachmentDir"],
): Promise<void> {
  const ip = req.socket.remoteAddress ?? undefined
  const deny = (reason: string): void => {
    logAppLinkApprovalAccess({ request: link, allowed: false, reason, ...(ip ? { ip } : {}) })
    json(res, 403, { error: "approval_link_forbidden" })
  }
  const refusal = appLinkApprovalRefusal(link, humanTelegramIds)
  if (refusal) return deny(refusal)
  const telegramUserId = link.auth.telegramUserId!

  if (link.action === "read") {
    const record = engine.get(link.approvalId)
    if (!record) return deny("not_found")
    logAppLinkApprovalAccess({ request: link, allowed: true, ...(ip ? { ip } : {}) })
    json(res, 200, record)
    return
  }

  if (link.action === "files") {
    const record = engine.get(link.approvalId)
    if (!record) return deny("not_found")
    logAppLinkApprovalAccess({ request: link, allowed: true, ...(ip ? { ip } : {}) })
    await serveApprovalFiles(res, record, FILES_PATH_RE.exec(req.url?.split("?")[0] ?? "")?.[2], attachmentDir)
    return
  }

  const body = await readJsonBody(req)
  const decision = isJsonRecord(body) ? body.decision : undefined
  if (decision !== "approve" && decision !== "deny") {
    logAppLinkApprovalAccess({ request: link, allowed: false, reason: "invalid_decision", ...(ip ? { ip } : {}) })
    json(res, 400, { error: "invalid_decision", message: 'body.decision must be "approve" or "deny"' })
    return
  }
  const current = engine.get(link.approvalId)
  if (!current) return deny("not_found")
  if (current.status !== "pending") return deny("not_pending")
  if (!current.channels.includes("telegram")) return deny("channel_disabled")
  const userAgentHeader = req.headers["user-agent"]
  try {
    const record = await engine.decideTelegram(link.approvalId, decision, {
      ipAddress: ip ?? "unknown",
      userAgent: typeof userAgentHeader === "string" ? userAgentHeader : "unknown",
      telegramUserId,
    })
    logAppLinkApprovalAccess({ request: link, allowed: true, ...(ip ? { ip } : {}) })
    json(res, 200, record)
  } catch {
    // A decide that lost a race with another channel, or any engine refusal.
    deny("decide_failed")
  }
}

function parseWake(value: unknown): ApprovalWakeTarget | undefined {
  if (!isJsonRecord(value)) return undefined
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : ""
  const agent = typeof value.agent === "string" ? value.agent.trim() : ""
  if (!sessionId && !agent) return undefined
  return { ...(sessionId ? { sessionId } : {}), ...(agent ? { agent } : {}) }
}

/** `reach` on `POST /approvals`: absent, `false`, or `{ urgency }`. This is
 *  producer code, so `urgency: "now"` is accepted here (and only here). */
function parseReach(value: unknown): { ok: true; reach?: ApprovalReachOption } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (value === false) return { ok: true, reach: false }
  if (
    isJsonRecord(value) &&
    Object.keys(value).every(k => k === "urgency") &&
    (value.urgency === "now" || value.urgency === "normal" || value.urgency === "digest")
  ) {
    return { ok: true, reach: { urgency: value.urgency } }
  }
  return { ok: false }
}

export async function handleApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  engine: ApprovalsEngine,
  auth: ApprovalsHttpAuth,
): Promise<boolean> {
  const requester: ApprovalRequester = { operator: true }

  if (auth.link) {
    await handleApprovalLink(req, res, engine, auth.link, auth.humanTelegramIds ?? [], auth.attachmentDir)
    return true
  }

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
    const wake = parseWake(body.wake)
    const reach = parseReach(body.reach)
    if (!reach.ok) {
      json(res, 400, {
        error: "invalid_reach",
        message: 'reach must be false or { urgency: "now" | "normal" | "digest" }',
      })
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
          ...(wake ? { wake } : {}),
          ...(reach.reach !== undefined ? { reach: reach.reach } : {}),
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

  // POST /approvals/:id/decision/telegram — the `telegram` decide route.
  // Gated by a single shared-secret bearer token (`auth.telegramBotSecret`)
  // instead of `web_click`'s Origin+token pair: a Telegram webhook callback
  // carries no browser Origin, so the bridge service holding the secret IS
  // the credential. Absent secret ⇒ always 403, same convention as an
  // empty `webOrigins`.
  const telegramDecisionMatch = path.match(/^\/approvals\/([^/]+)\/decision\/telegram$/)
  if (telegramDecisionMatch && req.method === "POST") {
    const id = decodeURIComponent(telegramDecisionMatch[1] ?? "")
    const header = req.headers.authorization
    if (!auth.telegramBotSecret || header !== `Bearer ${auth.telegramBotSecret}`) {
      json(res, 403, {
        error: "forbidden_channel",
        message: "telegram decisions require the configured approvals.telegramBotSecret bearer token.",
      })
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
      const record = await engine.decideTelegram(id, decision, { ipAddress, userAgent })
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

  const filesMatch = FILES_PATH_RE.exec(path)
  if (filesMatch && req.method === "GET") {
    const id = decodeURIComponent(filesMatch[1] ?? "")
    const record = engine.get(id)
    if (!record) {
      json(res, 404, { error: "approval_not_found", approvalId: id })
      return true
    }
    await serveApprovalFiles(res, record, filesMatch[2], auth.attachmentDir)
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

  if (path === "/approvals" || idMatch || decisionMatch || telegramDecisionMatch || waitMatch || consumeMatch || filesMatch) {
    json(res, 405, { error: "method_not_allowed" })
    return true
  }
  return false
}
