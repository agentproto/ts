/**
 * The daemon live relay of a session's browser tab (session-chat live
 * contract, T3): `GET /sessions/:id/live.mjpeg` and
 * `GET|HEAD /sessions/:id/live/:streamId/replay.mp4`.
 *
 * `live.mjpeg` picks the tab exactly like the screencast reader
 * (session-screencast.ts): the newest open tab Bureau lists as owned by `:id`,
 * moving on to the next one when Bureau refuses a tab (`target_gone`). It then
 * calls Bureau `browser_live_view` AS `:id` with `reuse: true`, so a stream the
 * agent's own widget is already watching is shared, not replaced, takes the
 * result's `urls.loopback`, refuses anything that is not
 * `http://127.0.0.1:<port>/s/<token>`, and pipes that MJPEG body verbatim.
 * The relay never calls `browser_live_stop`: the stream belongs to the tab.
 * A client disconnect aborts the upstream request.
 *
 * Bureau's token URLs never leave this module: no response body, header or
 * log line carries them. Every miss is the same 404 body, logged with a
 * reason only. The last {@link REMEMBERED_STREAMS} streams relayed per
 * session are remembered in memory (`streamId` -> replay URL, 24 h) so the
 * replay route can relay the kept video of a stream that ended, with the
 * client's `range` header passed through.
 *
 * Who may ask is the HTTP gate's call (bearer, or a link token whose
 * `sessionId` / `browserSessionId` claim equals `:id`, app-link-gate.ts).
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import {
  contentBlocks,
  defaultResolveAlias,
  isToolError,
  parseTabs,
  setBounded,
  type OwnedTab,
} from "./session-screencast.js"

export const LIVE_RELAY_NO_STREAM_MESSAGE = "No live browser stream for this session."

const LIVE_FPS = 8
const LIVE_MAX_DURATION_SEC = 600
const MAX_PER_SESSION = 3
const MAX_TOTAL = 12
const REMEMBERED_STREAMS = 5
const REMEMBER_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_CAP = 200
const LOG_REPEAT_MS = 30_000
/** How long the upstream may take to answer with headers. The body itself
 *  has no deadline: it ends when Bureau's stream ends. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000

const LIVE_PATH_RE = /^\/s\/[A-Za-z0-9_-]{8,512}$/
const REPLAY_PATH_RE = /^\/v\/[A-Za-z0-9_-]{8,512}$/
const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

type CallImportedTool = (
  alias: string,
  tool: string,
  args: Record<string, unknown>,
  callerSessionId?: string,
) => Promise<unknown>

export type LiveRelayMissReason =
  | "not_wired"
  | "no_tab"
  | "bureau_error"
  | "bad_result"
  | "refused_url"
  | "upstream_error"
  | "unknown_stream"

export interface SessionLiveRelay {
  /** Answer `GET /sessions/:id/live.mjpeg`. Always ends `res`. */
  serveLive(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void>
  /** Answer `GET|HEAD /sessions/:id/live/:streamId/replay.mp4`. Always ends `res`. */
  serveReplay(req: IncomingMessage, res: ServerResponse, sessionId: string, streamId: string): Promise<void>
  /** Relayed connections open right now (tests, diagnostics). */
  activeCount(sessionId?: string): number
}

export interface SessionLiveRelayOptions {
  callImportedTool?: CallImportedTool | undefined
  /** The imported MCP alias of Bureau. Default: `defaults.browser.proxyImport`. */
  resolveAlias?: () => Promise<string>
  now?: () => number
  log?: (line: string) => void
  maxPerSession?: number
  maxTotal?: number
}

/** A loopback Bureau URL of the given shape, or null. Only
 *  `http://127.0.0.1:<explicit port><path>`, no credentials, query or hash. */
export function parseLoopbackBureauUrl(value: unknown, pathRe: RegExp): URL | null {
  if (typeof value !== "string" || value.length > 1024) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "http:") return null
  if (url.hostname !== "127.0.0.1") return null
  if (url.port === "") return null
  if (url.username !== "" || url.password !== "") return null
  if (url.search !== "" || url.hash !== "") return null
  if (!value.startsWith(`http://127.0.0.1:${url.port}/`)) return null
  if (!pathRe.test(url.pathname)) return null
  return url
}

interface LiveViewResult {
  streamId: string
  loopback: URL
  replay: URL | null
}

type LiveViewParse = { ok: true; value: LiveViewResult } | { ok: false; reason: "bad_result" | "refused_url" }

function liveViewPayload(result: unknown): Record<string, unknown> | null {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>
  }
  for (const b of contentBlocks(result)) {
    if (b.type !== "text" || typeof b.text !== "string") continue
    try {
      const parsed: unknown = JSON.parse(b.text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // not JSON, try the next block
    }
  }
  return null
}

export function parseLiveViewResult(result: unknown): LiveViewParse {
  const payload = liveViewPayload(result)
  if (!payload) return { ok: false, reason: "bad_result" }
  const streamId = payload.streamId
  const urls = payload.urls as Record<string, unknown> | undefined
  if (typeof streamId !== "string" || !STREAM_ID_RE.test(streamId)) return { ok: false, reason: "bad_result" }
  if (!urls || typeof urls !== "object" || typeof urls.loopback !== "string") return { ok: false, reason: "bad_result" }
  const loopback = parseLoopbackBureauUrl(urls.loopback, LIVE_PATH_RE)
  if (!loopback) return { ok: false, reason: "refused_url" }
  const replay = parseLoopbackBureauUrl(urls.replay, REPLAY_PATH_RE)
  return { ok: true, value: { streamId, loopback, replay } }
}

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const

function sendMiss(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error: "no_live_stream", message: LIVE_RELAY_NO_STREAM_MESSAGE })
  res.writeHead(404, { "content-type": "application/json", ...SAFE_HEADERS })
  res.end(body)
}

function sendBusy(res: ServerResponse): void {
  res.writeHead(429, { "content-type": "application/json", ...SAFE_HEADERS })
  res.end(JSON.stringify({ error: "live_relay_busy" }))
}

/** Add `name` to `access-control-expose-headers` when CORS headers are sent. */
function exposeHeader(res: ServerResponse, name: string): void {
  if (res.getHeader("access-control-allow-origin") === undefined) return
  const prev = res.getHeader("access-control-expose-headers")
  const list = typeof prev === "string" && prev !== "" ? prev.split(",").map(s => s.trim()) : []
  if (!list.some(h => h.toLowerCase() === name)) list.push(name)
  res.setHeader("access-control-expose-headers", list.join(", "))
}

/** One upstream request to a loopback Bureau URL, aborted when the client
 *  goes away. Resolves with the response or null (refused, timed out,
 *  client gone). Never rejects; never surfaces the URL. */
function openUpstream(
  url: URL,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  clientRes: ServerResponse,
): Promise<{ upstream: IncomingMessage; abort: () => void } | null> {
  return new Promise(resolve => {
    let settled = false
    const upReq = httpRequest(
      {
        protocol: "http:",
        host: "127.0.0.1",
        port: Number(url.port),
        path: url.pathname,
        method,
        headers,
        agent: false,
      },
      upstream => {
        clearTimeout(timer)
        if (settled) {
          upstream.destroy()
          return
        }
        settled = true
        resolve({ upstream, abort })
      },
    )
    const abort = (): void => {
      upReq.destroy()
    }
    const finish = (): void => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve(null)
    }
    const timer = setTimeout(() => {
      upReq.destroy()
      finish()
    }, UPSTREAM_HEADERS_TIMEOUT_MS)
    timer.unref?.()
    upReq.on("error", finish)
    clientRes.once("close", () => {
      upReq.destroy()
      finish()
    })
    upReq.end()
  })
}

export function createSessionLiveRelay(opts: SessionLiveRelayOptions): SessionLiveRelay {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.warn(line))
  const resolveAlias = opts.resolveAlias ?? defaultResolveAlias
  const maxPerSession = opts.maxPerSession ?? MAX_PER_SESSION
  const maxTotal = opts.maxTotal ?? MAX_TOTAL

  const perSession = new Map<string, number>()
  let total = 0
  /** sessionId -> (streamId -> { replay URL, remembered at }), newest last. */
  const remembered = new Map<string, Map<string, { replay: URL; at: number }>>()
  const lastLogged = new Map<string, { reason: string; at: number }>()

  const label = (sessionId: string): string => JSON.stringify(sessionId.slice(0, 80))

  const logMiss = (sessionId: string, reason: LiveRelayMissReason | "busy"): void => {
    const prev = lastLogged.get(sessionId)
    const at = now()
    if (prev && prev.reason === reason && at - prev.at < LOG_REPEAT_MS) return
    setBounded(lastLogged, sessionId, { reason, at }, SESSION_CAP)
    log(`[live-relay] session ${label(sessionId)}: no live stream (${reason})`)
  }

  const acquire = (sessionId: string): (() => void) | null => {
    const mine = perSession.get(sessionId) ?? 0
    if (mine >= maxPerSession || total >= maxTotal) return null
    perSession.set(sessionId, mine + 1)
    total += 1
    let released = false
    return () => {
      if (released) return
      released = true
      total -= 1
      const left = (perSession.get(sessionId) ?? 1) - 1
      if (left <= 0) perSession.delete(sessionId)
      else perSession.set(sessionId, left)
    }
  }

  const remember = (sessionId: string, streamId: string, replay: URL): void => {
    const at = now()
    const streams = remembered.get(sessionId) ?? new Map<string, { replay: URL; at: number }>()
    for (const [id, entry] of streams) {
      if (at - entry.at >= REMEMBER_TTL_MS) streams.delete(id)
    }
    setBounded(streams, streamId, { replay, at }, REMEMBERED_STREAMS)
    setBounded(remembered, sessionId, streams, SESSION_CAP)
  }

  const recall = (sessionId: string, streamId: string): URL | null => {
    const entry = remembered.get(sessionId)?.get(streamId)
    if (!entry) return null
    if (now() - entry.at >= REMEMBER_TTL_MS) {
      remembered.get(sessionId)?.delete(streamId)
      return null
    }
    return entry.replay
  }

  /** Tab pick + `browser_live_view` as `sessionId`. */
  const startView = async (
    sessionId: string,
    call: CallImportedTool,
  ): Promise<{ ok: true; value: LiveViewResult } | { ok: false; reason: LiveRelayMissReason }> => {
    let alias: string
    try {
      alias = await resolveAlias()
    } catch {
      return { ok: false, reason: "bureau_error" }
    }
    let tabs: OwnedTab[] | null
    try {
      const listed = await call(alias, "browser_list_owned_tabs", {}, sessionId)
      tabs = isToolError(listed) ? null : parseTabs(listed)
    } catch {
      tabs = null
    }
    if (!tabs) return { ok: false, reason: "bureau_error" }
    if (tabs.length === 0) return { ok: false, reason: "no_tab" }

    let failure: LiveRelayMissReason = "bureau_error"
    for (const tab of tabs) {
      let result: unknown
      try {
        result = await call(
          alias,
          "browser_live_view",
          {
            tabId: tab.targetId,
            ...(tab.instance ? { instance: tab.instance } : {}),
            reuse: true,
            fps: LIVE_FPS,
            maxDurationSec: LIVE_MAX_DURATION_SEC,
          },
          sessionId,
        )
      } catch {
        failure = "bureau_error"
        continue
      }
      // A tool error (`target_gone`, a tab closed since the listing):
      // try the next tab, like the screencast reader.
      if (isToolError(result)) {
        failure = "bureau_error"
        continue
      }
      const parsed = parseLiveViewResult(result)
      if (parsed.ok) return parsed
      // A well-formed answer we refuse is not a reason to try another tab.
      return { ok: false, reason: parsed.reason }
    }
    return { ok: false, reason: failure }
  }

  return {
    activeCount(sessionId) {
      return sessionId === undefined ? total : (perSession.get(sessionId) ?? 0)
    },

    async serveLive(_req, res, sessionId) {
      const call = opts.callImportedTool
      if (!call) {
        logMiss(sessionId, "not_wired")
        sendMiss(res)
        return
      }
      const release = acquire(sessionId)
      if (!release) {
        logMiss(sessionId, "busy")
        sendBusy(res)
        return
      }
      let closed = false
      res.once("close", () => {
        closed = true
        release()
      })
      try {
        const view = await startView(sessionId, call)
        if (!view.ok) {
          logMiss(sessionId, view.reason)
          sendMiss(res)
          return
        }
        if (closed) return
        const { streamId, loopback, replay } = view.value
        if (replay) remember(sessionId, streamId, replay)

        const opened = await openUpstream(loopback, "GET", { accept: "multipart/x-mixed-replace" }, res)
        if (!opened) {
          if (!closed) {
            logMiss(sessionId, "upstream_error")
            sendMiss(res)
          }
          return
        }
        const { upstream, abort } = opened
        const contentType = upstream.headers["content-type"]
        if (
          upstream.statusCode !== 200 ||
          typeof contentType !== "string" ||
          !/^multipart\/x-mixed-replace\s*;/i.test(contentType)
        ) {
          upstream.resume()
          abort()
          logMiss(sessionId, "upstream_error")
          sendMiss(res)
          return
        }
        exposeHeader(res, "x-live-stream-id")
        res.writeHead(200, {
          "content-type": contentType,
          ...SAFE_HEADERS,
          "x-live-stream-id": streamId,
        })
        res.flushHeaders()
        res.once("close", abort)
        upstream.on("error", () => res.destroy())
        upstream.on("aborted", () => res.destroy())
        upstream.pipe(res)
      } catch {
        logMiss(sessionId, "bureau_error")
        sendMiss(res)
      }
    },

    async serveReplay(req, res, sessionId, streamId) {
      const method = req.method === "HEAD" ? "HEAD" : "GET"
      const replay = STREAM_ID_RE.test(streamId) ? recall(sessionId, streamId) : null
      if (!replay) {
        logMiss(sessionId, "unknown_stream")
        sendMiss(res)
        return
      }
      let closed = false
      res.once("close", () => {
        closed = true
      })
      const headers: Record<string, string> = {}
      const range = req.headers.range
      if (typeof range === "string" && range.length <= 200) headers.range = range
      const opened = await openUpstream(replay, method, headers, res)
      if (!opened) {
        if (!closed) {
          logMiss(sessionId, "upstream_error")
          sendMiss(res)
        }
        return
      }
      const { upstream, abort } = opened
      const status = upstream.statusCode ?? 0
      if (status !== 200 && status !== 206 && status !== 416) {
        // A Bureau 404 (still encoding, pruned, failed) stays a 404: the
        // client retries. Anything else is the same miss.
        upstream.resume()
        abort()
        logMiss(sessionId, "upstream_error")
        sendMiss(res)
        return
      }
      const out: Record<string, string> = { ...SAFE_HEADERS }
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"] as const) {
        const value = upstream.headers[name]
        if (typeof value === "string") out[name] = value
      }
      res.writeHead(status, out)
      if (method === "HEAD") {
        upstream.resume()
        abort()
        res.end()
        return
      }
      res.once("close", abort)
      upstream.on("error", () => res.destroy())
      upstream.on("aborted", () => res.destroy())
      upstream.pipe(res)
    },
  }
}
