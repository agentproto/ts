/**
 * A reused camofox tab per `userId`. A camofox `userId` owns one browser context
 * (cookies); `POST /tabs` always creates a NEW tab, so reuse is the client's job:
 * the tab id is remembered in a small state file and re-navigated on the next run.
 *
 * Public half only: cookie injection, tab reuse, navigation, evaluation, basic
 * input, screenshots and server-side network capture. Human-mode pacing,
 * anti-bot challenge handling and passive in-page capture stay private.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SessionCookie } from "./cookie.js"

/** Where the reused tab ids are remembered. Computed on call, never at import. */
export function camofoxStatePath(): string {
  return process.env["CAMOFOX_TABS_STATE"] ?? join(homedir(), ".agentproto", "camofox-tabs.json")
}

/** The camofox instance a session resolves against when no base is pinned: `CAMOFOX_URL`, else `localhost:$CAMOFOX_PORT` (9377). */
export function defaultCamofoxBase(): string {
  return (process.env["CAMOFOX_URL"] || `http://localhost:${process.env["CAMOFOX_PORT"] || "9377"}`).replace(/\/$/, "")
}

export interface OpenSessionOptions {
  /** The camofox `userId` that owns the browser context. */
  userId: string
  base?: string
  /** Curated cookies to inject: the declared domains only, never the whole jar. */
  cookies?: readonly SessionCookie[]
  /** Initial URL to land the tab on. Omitted: no landing navigation. */
  url?: string
  /** Inject cookies before use (default true). */
  injectCookies?: boolean
  /** Absolute path to a Playwright storageState JSON loaded when creating a new tab. */
  storageState?: string
  /** Exempt the tab from camofox's idle reaper. */
  keepAlive?: boolean
  /** If a read returns 401, POST this URL in-page (a token-refresh endpoint) and retry once. */
  refreshUrl?: string
  /** Where tab ids are remembered. Default: {@link camofoxStatePath}. */
  stateFile?: string
  /** Injectable transport, for tests. Default: global `fetch`. */
  fetch?: typeof fetch
  /** Injectable settle delay after navigation (ms). Default 2500. */
  settleMs?: number
}

export interface ApiRawResult {
  status: number
  body: unknown
}

export interface CamofoxSession {
  tabId: string
  userId: string
  /** In-page authed JSON GET; returns the parsed body, throws on non-2xx. */
  api(pathAndQuery: string): Promise<unknown>
  /** In-page GET returning `{ status, body }` without throwing. */
  apiRaw(pathAndQuery: string): Promise<ApiRawResult>
  evaluate<T = unknown>(expression: string): Promise<T>
  screenshot(opts?: {
    selector?: string
    format?: "png" | "jpeg"
    quality?: number
  }): Promise<{ imageBase64: string; mimeType: string }>
  goto(url: string, waitUntil?: string): Promise<void>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  press(key: string): Promise<void>
  /** Arm server-side network capture (Playwright request events). */
  startNetCapture(urlPattern?: string, max?: number): Promise<void>
  readNetCapture(): Promise<
    Array<{
      method: string
      url: string
      resourceType: string
      postData: string | null
      headers: Record<string, string>
    }>
  >
  /** Close and forget the tab. */
  close(): Promise<void>
}

interface TabRow {
  tabId?: string
  id?: string
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function readState(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

function writeState(file: string, s: Record<string, string>): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
}

export async function openSession(opts: OpenSessionOptions): Promise<CamofoxSession> {
  const base = (opts.base || defaultCamofoxBase()).replace(/\/$/, "")
  const userId = opts.userId
  const stateFile = opts.stateFile ?? camofoxStatePath()
  const doFetch = opts.fetch ?? fetch
  const settleMs = opts.settleMs ?? 2500

  const rest = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const t = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${t.slice(0, 160)}`)
    return t ? (JSON.parse(t) as Record<string, unknown>) : {}
  }

  if (opts.injectCookies !== false) {
    await rest("POST", `/sessions/${encodeURIComponent(userId)}/cookies`, {
      cookies: opts.cookies ? [...opts.cookies] : [],
      sessionKey: userId,
    })
  }

  const state = readState(stateFile)
  let tabId = ""
  let listed: TabRow[] = []
  try {
    const l = await rest("GET", `/tabs?userId=${encodeURIComponent(userId)}`)
    const tabs = (l["tabs"] ?? l) as unknown
    listed = Array.isArray(tabs) ? (tabs as TabRow[]) : []
  } catch {
    // fall through to create
  }
  const ids = new Set(listed.map(t => t.tabId ?? t.id))
  const remembered = state[userId]
  const first = listed[0]
  if (remembered && ids.has(remembered)) {
    tabId = remembered
  } else if (first) {
    tabId = first.tabId ?? first.id ?? ""
  } else {
    // With a storageState, create at about:blank so its cookies load BEFORE the
    // first navigation (navigating during init would hit an auth wall).
    const tab = await rest("POST", "/tabs", {
      userId,
      sessionKey: userId,
      ...(opts.storageState ? { storageState: opts.storageState } : opts.url ? { url: opts.url } : {}),
      ...(opts.keepAlive ? { keepAlive: true } : {}),
    })
    tabId = String(tab["tabId"] ?? tab["id"] ?? "")
    if (opts.storageState && opts.url) {
      await rest("POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, {
        userId,
        url: opts.url,
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
    }
  }
  state[userId] = tabId
  writeState(stateFile, state)

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const r = await rest("POST", `/tabs/${encodeURIComponent(tabId)}/evaluate`, { userId, expression })
    return (r["result"] ?? r["value"]) as T
  }
  const goto = async (u: string, waitUntil = "domcontentloaded"): Promise<void> => {
    await rest("POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, { userId, url: u, waitUntil })
    if (settleMs > 0) await sleep(settleMs)
  }
  const screenshot = async (
    o: { selector?: string; format?: "png" | "jpeg"; quality?: number } = {},
  ): Promise<{ imageBase64: string; mimeType: string }> => {
    const format = o.format ?? "jpeg"
    const qs = new URLSearchParams({ userId, format })
    if (o.selector) qs.set("selector", o.selector)
    if (o.quality != null) qs.set("quality", String(o.quality))
    const res = await doFetch(`${base}/tabs/${encodeURIComponent(tabId)}/screenshot?${qs.toString()}`)
    if (!res.ok) throw new Error(`screenshot -> ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // Trust the bytes, not the requested format: a wrong mimeType makes vision APIs reject the image.
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50
    const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8
    const mimeType = isPng ? "image/png" : isJpeg ? "image/jpeg" : format === "png" ? "image/png" : "image/jpeg"
    return { imageBase64: buf.toString("base64"), mimeType }
  }
  const rawGet = (p: string): Promise<ApiRawResult> =>
    evaluate<ApiRawResult>(
      `(async()=>{try{const r=await fetch(${JSON.stringify(p)},{headers:{accept:"application/json","x-requested-with":"XMLHttpRequest"},credentials:"include"});let b=null;try{b=await r.json()}catch{}return{status:r.status,body:b}}catch(e){return{status:-1,error:String(e)}}})()`,
    )
  const refresh = async (): Promise<boolean> => {
    if (!opts.refreshUrl) return false
    const r = await evaluate<{ status: number }>(
      `(async()=>{try{const r=await fetch(${JSON.stringify(opts.refreshUrl)},{method:"POST",credentials:"include",headers:{accept:"application/json"}});return{status:r.status}}catch(e){return{status:-1}}})()`,
    )
    return r?.status === 200
  }
  const apiRaw = async (p: string): Promise<ApiRawResult> => {
    let r = await rawGet(p)
    if (r?.status === 401 && (await refresh())) r = await rawGet(p)
    return r
  }
  const api = async (p: string): Promise<unknown> => {
    const r = await apiRaw(p)
    if (!r || r.status < 200 || r.status >= 300) throw new Error(`GET ${p} -> ${r?.status}`)
    return r.body
  }

  if (opts.url) await goto(opts.url)

  return {
    tabId,
    userId,
    api,
    apiRaw,
    evaluate,
    screenshot,
    goto,
    click: async selector => {
      await rest("POST", `/tabs/${encodeURIComponent(tabId)}/click`, { userId, selector })
    },
    type: async (selector, text) => {
      await rest("POST", `/tabs/${encodeURIComponent(tabId)}/type`, { userId, selector, text })
    },
    press: async key => {
      await rest("POST", `/tabs/${encodeURIComponent(tabId)}/press`, { userId, key })
    },
    startNetCapture: async (urlPattern, max) => {
      await rest("POST", `/tabs/${encodeURIComponent(tabId)}/capture`, {
        userId,
        sessionKey: userId,
        ...(urlPattern ? { urlPattern } : {}),
        ...(max ? { max } : {}),
      })
    },
    readNetCapture: async () => {
      const r = await rest("GET", `/tabs/${encodeURIComponent(tabId)}/capture?userId=${encodeURIComponent(userId)}`)
      const reqs = r["requests"]
      return Array.isArray(reqs) ? (reqs as Awaited<ReturnType<CamofoxSession["readNetCapture"]>>) : []
    },
    close: async () => {
      try {
        await rest("DELETE", `/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`)
      } catch {
        // best effort
      }
      const s = readState(stateFile)
      delete s[userId]
      writeState(stateFile, s)
    },
  }
}
