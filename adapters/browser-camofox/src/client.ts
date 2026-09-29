import { z } from "zod"

export const DEFAULT_CAMOFOX_URL = "http://127.0.0.1:9377"

/** A non-2xx answer from the camofox server. Never carries the API key. */
export class CamofoxHttpError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string

  constructor(method: string, path: string, status: number, detail: string) {
    super(`camofox ${method} ${path}: HTTP ${status}${detail ? `: ${detail}` : ""}`)
    this.name = "CamofoxHttpError"
    this.status = status
    this.method = method
    this.path = path
  }
}

export interface CamofoxNavigateOptions {
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle2"
  readonly timeout?: number
}

export interface CamofoxScreenshotOptions {
  readonly selector?: string
  readonly format?: string
  readonly quality?: number
}

/** `human: true` types keystroke by keystroke with `delay` ms of jitter; otherwise one shot. */
export interface CamofoxTypeOptions {
  readonly human?: boolean
  readonly delay?: number
}

export interface CamofoxScriptResult<T = unknown> {
  readonly value?: T
  readonly error?: string
}

/** One live tab as reported by `GET /tabs`. */
export interface CamofoxTab {
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly listItemId?: string
  readonly keepAlive?: boolean
}

/** A cookie in the shape the camofox cookie endpoint takes. */
export const camofoxCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.string().optional(),
  })
  .loose()
export type CamofoxCookie = z.infer<typeof camofoxCookieSchema>

/** The raw answer of `GET /health`: HTTP status plus whatever JSON came back. */
export interface CamofoxHealthResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** What the driver needs from a camofox REST client. */
export interface CamofoxClient {
  createSession(opts?: { keepAlive?: boolean }): Promise<{ id: string }>
  navigate(sessionId: string, url: string, options?: CamofoxNavigateOptions): Promise<void>
  click(sessionId: string, selector: string): Promise<void>
  type(sessionId: string, selector: string, value: string, options?: CamofoxTypeOptions): Promise<void>
  getScreenshot(sessionId: string, options?: CamofoxScreenshotOptions): Promise<Buffer>
  executeScript<T = unknown>(sessionId: string, script: string): Promise<CamofoxScriptResult<T>>
  getRecordedVideo(sessionId: string): Promise<Buffer>
  setCookies(sessionId: string, cookies: CamofoxCookie[]): Promise<unknown>
  closeSession(sessionId: string): Promise<void>
}

export interface CamofoxRestClient extends CamofoxClient {
  readonly baseUrl: string
  listTabs(userId?: string): Promise<CamofoxTab[]>
  /** `GET /health`. Resolves for a 503 too (it carries lifecycle state); rejects only when nothing answers. */
  health(opts?: { timeoutMs?: number }): Promise<CamofoxHealthResponse>
  /** `POST /start`: launch the browser and reset the crash-loop counters. */
  start(): Promise<void>
}

export interface CamofoxRestClientConfig {
  /** Service base URL. Default: `$CAMOFOX_URL` or `http://127.0.0.1:9377`. */
  baseUrl?: string
  /** Context id: logins (cookies) live at this level. Default `main`. */
  userId?: string
  /** Session key under the userId context. Default `main`. */
  sessionKey?: string
  /**
   * Sent as `Authorization: Bearer <key>`. Defaults to `$CAMOFOX_API_KEY`.
   * Never logged, and scrubbed out of error text.
   */
  apiKey?: string
}

/** `localhost` resolves to `::1` first in node and the service is IPv4-only. */
export function normalizeBaseUrl(url: string): string {
  return url.replace("localhost", "127.0.0.1").replace(/\/+$/, "")
}

export function createCamofoxRestClient(config: CamofoxRestClientConfig = {}): CamofoxRestClient {
  const base = normalizeBaseUrl(config.baseUrl ?? process.env["CAMOFOX_URL"] ?? DEFAULT_CAMOFOX_URL)
  const userId = config.userId ?? "main"
  const sessionKey = config.sessionKey ?? "main"
  const apiKey = config.apiKey ?? process.env["CAMOFOX_API_KEY"]

  const authHeaders = (): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  const scrub = (text: string): string => (apiKey ? text.split(apiKey).join("[redacted]") : text)

  const fail = async (method: string, path: string, res: Response): Promise<never> => {
    const text = await res.text().catch(() => "")
    throw new CamofoxHttpError(method, path, res.status, scrub(text.slice(0, 300)))
  }

  const json = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // A 4xx/5xx is a failed operation (e.g. the server's own handler budget
    // aborting a long fill). Returning it as a body made callers report success.
    if (!res.ok) return fail(method, path, res)
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  const binary = async (method: string, path: string): Promise<Buffer> => {
    const res = await fetch(base + path, { method, headers: authHeaders() })
    if (!res.ok) return fail(method, path, res)
    return Buffer.from(await res.arrayBuffer())
  }

  const q = (params: Record<string, string | undefined>): string => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v != null) sp.set(k, v)
    return sp.toString()
  }

  return {
    baseUrl: base,

    async createSession(opts) {
      const r = await json<{ tabId?: string; error?: string }>("POST", "/tabs", {
        userId,
        sessionKey,
        ...(opts?.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
      })
      if (!r.tabId) throw new Error(`camofox /tabs: ${r.error ?? "no tabId returned"}`)
      return { id: r.tabId }
    },

    async navigate(sessionId, url, options) {
      await json("POST", `/tabs/${sessionId}/navigate`, {
        userId,
        url,
        waitUntil: options?.waitUntil,
        timeout: options?.timeout,
      })
    },

    async click(sessionId, selector) {
      await json("POST", `/tabs/${sessionId}/click`, { userId, selector })
    },

    async type(sessionId, selector, value, options) {
      await json("POST", `/tabs/${sessionId}/type`, {
        userId,
        selector,
        text: value,
        ...(options?.human ? { human: true, delay: options.delay ?? 90 } : {}),
      })
    },

    async getScreenshot(sessionId, options) {
      return binary(
        "GET",
        `/tabs/${sessionId}/screenshot?${q({
          userId,
          selector: options?.selector,
          format: options?.format,
          quality: options?.quality?.toString(),
        })}`,
      )
    },

    async executeScript<T = unknown>(sessionId: string, script: string) {
      // /evaluate runs page.evaluate(expression) server-side and wraps nothing,
      // so the body goes in an IIFE: multi-statement scripts `return` explicitly.
      const r = await json<{ result?: T; error?: string }>("POST", `/tabs/${sessionId}/evaluate`, {
        userId,
        expression: `(function(){ ${script} })()`,
      })
      return r.error ? { error: r.error } : { value: r.result }
    },

    async getRecordedVideo(sessionId) {
      return binary("GET", `/tabs/${sessionId}/video?${q({ userId })}`)
    },

    async setCookies(_sessionId, cookies) {
      return json("POST", `/sessions/${encodeURIComponent(userId)}/cookies`, { cookies, sessionKey })
    },

    async closeSession(sessionId) {
      await json("DELETE", `/tabs/${sessionId}?${q({ userId })}`)
    },

    async listTabs(forUserId) {
      const r = await json<{ tabs?: CamofoxTab[] }>("GET", `/tabs?${q({ userId: forUserId ?? userId })}`)
      return r.tabs ?? []
    },

    async health(opts) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 3000)
      try {
        const res = await fetch(base + "/health", { headers: authHeaders(), signal: ac.signal })
        const text = await res.text()
        let body: Record<string, unknown> = {}
        try {
          const parsed: unknown = text ? JSON.parse(text) : {}
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>
          }
        } catch {
          // not JSON: some other service on the port
        }
        return { status: res.status, body }
      } finally {
        clearTimeout(timer)
      }
    },

    async start() {
      await json("POST", "/start", {})
    },
  }
}
