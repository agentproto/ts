/**
 * `GET /sessions/:id/screencast.jpg` for an id that is not a chrome-live
 * browser descriptor: a Bureau `browser_screenshot` (JPEG) of the newest open
 * tab owned by session `:id`. Called as a raw imported tool, that result is a
 * JSON object `{ base64, format, width, height }` (not an MCP `image` block),
 * handed over as `structuredContent`, as a `text` block holding the JSON, or
 * both; `parseImage` reads all of those plus the `image` block. The bytes
 * field is `base64` (the driver layer calls it `data`; both are read). No
 * recording is started or needed, so any session that owns an open tab can be
 * watched with no cooperation from the agent.
 *
 * Every Bureau call is made AS the path id (the imported-tool call takes a
 * caller session id, forwarded in `x-agentproto-caller-session`), so Bureau's
 * own tab ownership decides what is visible: a caller only ever gets the
 * viewport of a tab opened for that session. The route is read-only; nothing
 * here clicks, types or reaches another tab. The HTTP gate (bearer, or a link
 * token whose `sessionId` / `browserSessionId` claim equals the path id)
 * decides who may ask.
 *
 * Each frame is a real CDP capture of the user's browser, so it is rate
 * limited: a per-session frame cache (a frame under FRAME_FRESH_MS old is
 * served as is), one shared in-flight capture per session, and at most
 * MAX_CONCURRENT_CAPTURES captures in flight for the whole reader. The frame
 * cache is keyed by session id only, in memory, capped and expiring.
 */

import type { ServerResponse } from "node:http"
import { loadConfig } from "./config.js"
import { resolveBrowserProxyImport } from "./browser-proxy.js"

export const SESSION_SCREENCAST_NO_FRAME_MESSAGE = "No open browser tab for this session."

const MAX_TABS = 5
const TAB_CACHE_TTL_MS = 5_000
const CACHE_CAP = 200
const LOG_REPEAT_MS = 30_000
const FRAME_FRESH_MS = 800
const FRAME_CACHE_CAP = 50
const FRAME_CACHE_TTL_MS = 60_000
const MAX_CONCURRENT_CAPTURES = 2
const QUEUE_WAIT_MS = 3_000
const SCREENSHOT_FORMAT = "jpeg"
const SCREENSHOT_QUALITY = 55

type CallImportedTool = (
  alias: string,
  tool: string,
  args: Record<string, unknown>,
  callerSessionId?: string,
) => Promise<unknown>

interface OwnedTab {
  targetId: string
  instance?: string
  openedAt: number
}

export type SessionScreencastMissReason = "not_wired" | "no_tab" | "bureau_error" | "bad_result"

export type SessionScreencastOutcome =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: SessionScreencastMissReason }

export interface SessionScreencastReader {
  read(sessionId: string): Promise<SessionScreencastOutcome>
}

export interface SessionScreencastReaderOptions {
  callImportedTool?: CallImportedTool | undefined
  /** The imported MCP alias of Bureau. Default: `defaults.browser.proxyImport`. */
  resolveAlias?: () => Promise<string>
  now?: () => number
  log?: (line: string) => void
  /** How long a capture may wait for one of the concurrency slots. Default 3 s. */
  queueWaitMs?: number
}

async function defaultResolveAlias(): Promise<string> {
  try {
    return resolveBrowserProxyImport((await loadConfig()).defaults?.browser)
  } catch {
    return resolveBrowserProxyImport(undefined)
  }
}

function contentBlocks(result: unknown): Record<string, unknown>[] {
  const content = (result as { content?: unknown } | null)?.content
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    : []
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: unknown } | null)?.isError === true
}

function parseOpenedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

function parseTabs(result: unknown): OwnedTab[] | null {
  let payload: unknown = (result as { structuredContent?: unknown } | null)?.structuredContent
  if (!payload) {
    const text = contentBlocks(result).find(b => b.type === "text" && typeof b.text === "string")
    if (!text) return null
    try {
      payload = JSON.parse(text.text as string)
    } catch {
      return null
    }
  }
  const tabs = (payload as { tabs?: unknown } | null)?.tabs
  if (!Array.isArray(tabs)) return null
  const out: OwnedTab[] = []
  for (const raw of tabs) {
    if (!raw || typeof raw !== "object") continue
    const t = raw as Record<string, unknown>
    if (typeof t.targetId !== "string" || t.targetId === "") continue
    out.push({
      targetId: t.targetId,
      ...(typeof t.instance === "string" && t.instance !== "" ? { instance: t.instance } : {}),
      openedAt: parseOpenedAt(t.openedAt),
    })
  }
  return out.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_TABS)
}

const SCREENSHOT_FORMATS = new Set(["jpeg", "png", "webp"])

// Live evidence: a raw imported `browser_screenshot` result observed 2026-11-09 has the keys
// base64, format, width, height; `data` is the in-process driver spelling and is accepted too.
function decodeScreenshotObject(value: unknown): { bytes: Buffer; mimeType: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as { base64?: unknown; data?: unknown; format?: unknown }
  const base64 = typeof raw.base64 === "string" && raw.base64 !== "" ? raw.base64 : raw.data
  const format = raw.format
  if (typeof base64 !== "string" || base64 === "") return null
  if (typeof format !== "string" || !SCREENSHOT_FORMATS.has(format)) return null
  const bytes = Buffer.from(base64, "base64")
  return bytes.length > 0 ? { bytes, mimeType: `image/${format}` } : null
}

function parseImage(result: unknown): { bytes: Buffer; mimeType: string } | null {
  const blocks = contentBlocks(result)
  const block = blocks.find(b => b.type === "image" && typeof b.data === "string" && b.data !== "")
  if (block) {
    const bytes = Buffer.from(block.data as string, "base64")
    const mime = typeof block.mimeType === "string" ? block.mimeType : ""
    if (bytes.length > 0) {
      return { bytes, mimeType: /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/jpeg" }
    }
  }
  const structured = decodeScreenshotObject(
    (result as { structuredContent?: unknown } | null)?.structuredContent,
  )
  if (structured) return structured
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(b.text)
    } catch {
      continue
    }
    const decoded = decodeScreenshotObject(parsed)
    if (decoded) return decoded
  }
  return null
}

function setBounded<V>(map: Map<string, V>, key: string, value: V, cap = CACHE_CAP): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

interface CachedFrame {
  at: number
  bytes: Buffer
  mimeType: string
}

export function createSessionScreencastReader(
  opts: SessionScreencastReaderOptions,
): SessionScreencastReader {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.warn(line))
  const resolveAlias = opts.resolveAlias ?? defaultResolveAlias
  const queueWaitMs = opts.queueWaitMs ?? QUEUE_WAIT_MS
  const tabCache = new Map<string, { at: number; tabs: OwnedTab[] }>()
  const frameCache = new Map<string, CachedFrame>()
  const inFlight = new Map<string, Promise<SessionScreencastOutcome>>()
  const lastLogged = new Map<string, { reason: SessionScreencastMissReason; at: number }>()

  let active = 0
  const waiters: (() => void)[] = []
  const acquire = (): Promise<boolean> => {
    if (active < MAX_CONCURRENT_CAPTURES) {
      active += 1
      return Promise.resolve(true)
    }
    return new Promise<boolean>(resolve => {
      const grant = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(grant)
        if (at >= 0) waiters.splice(at, 1)
        resolve(false)
      }, queueWaitMs)
      timer.unref?.()
      waiters.push(grant)
    })
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }

  const logMiss = (sessionId: string, reason: SessionScreencastMissReason): void => {
    const prev = lastLogged.get(sessionId)
    const at = now()
    if (prev && prev.reason === reason && at - prev.at < LOG_REPEAT_MS) return
    setBounded(lastLogged, sessionId, { reason, at })
    log(`[screencast] session ${JSON.stringify(sessionId.slice(0, 80))}: no frame (${reason})`)
  }

  const miss = (sessionId: string, reason: SessionScreencastMissReason): SessionScreencastOutcome => {
    logMiss(sessionId, reason)
    return { ok: false, reason }
  }

  const expireFrames = (): void => {
    const at = now()
    for (const [key, frame] of frameCache) {
      if (at - frame.at >= FRAME_CACHE_TTL_MS) frameCache.delete(key)
    }
  }

  const capture = async (
    sessionId: string,
    call: CallImportedTool,
  ): Promise<SessionScreencastOutcome> => {
    if (!(await acquire())) return miss(sessionId, "bureau_error")
    try {
      const alias = await resolveAlias()

      let bureauError = false
      let badResult = false
      const list = async (): Promise<OwnedTab[]> => {
        try {
          const result = await call(alias, "browser_list_owned_tabs", {}, sessionId)
          const tabs = isToolError(result) ? null : parseTabs(result)
          if (!tabs) {
            bureauError = true
            return []
          }
          setBounded(tabCache, sessionId, { at: now(), tabs })
          return tabs
        } catch {
          bureauError = true
          return []
        }
      }
      const firstFrame = async (tabs: OwnedTab[]) => {
        for (const tab of tabs) {
          try {
            const result = await call(
              alias,
              "browser_screenshot",
              {
                tabId: tab.targetId,
                ...(tab.instance ? { instance: tab.instance } : {}),
                format: SCREENSHOT_FORMAT,
                quality: SCREENSHOT_QUALITY,
              },
              sessionId,
            )
            if (isToolError(result)) {
              bureauError = true
            } else {
              const image = parseImage(result)
              if (image) return image
              badResult = true
            }
          } catch {
            bureauError = true
          }
          tabCache.delete(sessionId)
        }
        return null
      }

      const cached = tabCache.get(sessionId)
      const fresh = cached !== undefined && now() - cached.at < TAB_CACHE_TTL_MS
      let tabs = fresh ? cached.tabs : await list()
      let image = tabs.length > 0 ? await firstFrame(tabs) : null
      if (!image && fresh) {
        tabs = await list()
        image = tabs.length > 0 ? await firstFrame(tabs) : null
      }
      if (image) {
        expireFrames()
        setBounded(frameCache, sessionId, { at: now(), ...image }, FRAME_CACHE_CAP)
        return { ok: true, ...image }
      }
      if (badResult) return miss(sessionId, "bad_result")
      if (bureauError) return miss(sessionId, "bureau_error")
      return miss(sessionId, "no_tab")
    } finally {
      release()
    }
  }

  return {
    async read(sessionId) {
      const call = opts.callImportedTool
      if (!call) return miss(sessionId, "not_wired")

      const frame = frameCache.get(sessionId)
      if (frame && now() - frame.at < FRAME_FRESH_MS) {
        return { ok: true, bytes: frame.bytes, mimeType: frame.mimeType }
      }
      const pending = inFlight.get(sessionId)
      if (pending) return pending

      const started = capture(sessionId, call).catch(() => miss(sessionId, "bureau_error"))
      inFlight.set(sessionId, started)
      try {
        return await started
      } finally {
        if (inFlight.get(sessionId) === started) inFlight.delete(sessionId)
      }
    },
  }
}

/** Answer `GET /sessions/:id/screencast.jpg` from Bureau. Always ends `res`. */
export async function serveSessionScreencast(
  res: ServerResponse,
  reader: SessionScreencastReader,
  sessionId: string,
): Promise<void> {
  const outcome = await reader.read(sessionId)
  if (outcome.ok) {
    res.writeHead(200, {
      "content-type": outcome.mimeType,
      "cache-control": "no-store",
      "content-length": outcome.bytes.length,
    })
    res.end(outcome.bytes)
    return
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(
    JSON.stringify({
      error: "no_screencast_frame",
      message: SESSION_SCREENCAST_NO_FRAME_MESSAGE,
    }),
  )
}
