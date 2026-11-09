/**
 * `GET /sessions/:id/screencast.jpg` for an id that is not a chrome-live
 * browser descriptor: the latest Bureau recording frame of a tab owned by
 * session `:id`.
 *
 * Every Bureau call is made AS the path id (the imported-tool call takes a
 * caller session id, forwarded in `x-agentproto-caller-session`), so Bureau's
 * own tab ownership decides what is visible: a caller only ever gets frames of
 * tabs opened for that session. The route is read-only; nothing here writes
 * to a tab. The HTTP gate (bearer, or a link token whose `sessionId` /
 * `browserSessionId` claim equals the path id) decides who may ask.
 */

import type { ServerResponse } from "node:http"
import { loadConfig } from "./config.js"
import { resolveBrowserProxyImport } from "./browser-proxy.js"

export const SESSION_SCREENCAST_NO_FRAME_MESSAGE =
  "No frame yet: the session must call browser_screencast_start on a tab it owns."

const MAX_TABS = 5
const TAB_CACHE_TTL_MS = 5_000
const CACHE_CAP = 200
const LOG_REPEAT_MS = 30_000

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

export type SessionScreencastMissReason = "not_wired" | "no_tab" | "no_frame" | "bureau_error"

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

function parseImage(result: unknown): { bytes: Buffer; mimeType: string } | null {
  const block = contentBlocks(result).find(
    b => b.type === "image" && typeof b.data === "string" && b.data !== "",
  )
  if (!block) return null
  const mime = typeof block.mimeType === "string" ? block.mimeType : ""
  return {
    bytes: Buffer.from(block.data as string, "base64"),
    mimeType: /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/jpeg",
  }
}

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > CACHE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export function createSessionScreencastReader(
  opts: SessionScreencastReaderOptions,
): SessionScreencastReader {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.warn(line))
  const resolveAlias = opts.resolveAlias ?? defaultResolveAlias
  const tabCache = new Map<string, { at: number; tabs: OwnedTab[] }>()
  const lastLogged = new Map<string, { reason: SessionScreencastMissReason; at: number }>()

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

  return {
    async read(sessionId) {
      const call = opts.callImportedTool
      if (!call) return miss(sessionId, "not_wired")
      const alias = await resolveAlias()

      let bureauError = false
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
              "browser_record_frame",
              { tabId: tab.targetId, ...(tab.instance ? { instance: tab.instance } : {}) },
              sessionId,
            )
            if (isToolError(result)) {
              bureauError = true
              continue
            }
            const image = parseImage(result)
            if (image) return image
          } catch {
            bureauError = true
          }
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
      if (image) return { ok: true, ...image }
      if (bureauError) return miss(sessionId, "bureau_error")
      return miss(sessionId, tabs.length === 0 ? "no_tab" : "no_frame")
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
    res.writeHead(200, { "content-type": outcome.mimeType, "cache-control": "no-store" })
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
