import type { Clock } from "../engine"
import { type HttpRequest, type HttpResponse, type HttpTransport, TransportError } from "../transport"

export interface HttpTransportOptions {
  /** Per-request timeout, covering connect, headers and body. Default 30000. A request's own `timeoutMs` wins. */
  timeoutMs?: number
  /** Attempts per request, first one included. Default 3. */
  maxAttempts?: number
  /** First backoff step. Default 500. Step n waits between half and all of `min(base * 2^(n-1), maxBackoffMs)`. */
  baseDelayMs?: number
  /** Ceiling of one backoff step. Default 10000. */
  maxBackoffMs?: number
  /**
   * Longest `Retry-After` honoured. A longer one makes the request give up at
   * once with cause `http` and the response status (429 or 503). Default 30000.
   * Only a 429 then falls back in the engine; a 503 is a final `http` failure.
   */
  maxRetryAfterMs?: number
  /**
   * Minimum gap between two sends to the same host. Default 1000, 0 turns the
   * limiter off. This is the one pacing point at the send boundary: it paces
   * the first send, every retry and every redirect hop. The collect engine
   * has its own per-host gate (the connector's `pace.delayMs`) that paces the
   * start of each task, so the first send of a task is paced by both; the two
   * overlap (the later deadline wins) and do not add up. Retries and redirect
   * hops never go back through the engine, so only this limiter paces them:
   * inside the engine, set it to the gap you want between those extra sends
   * (0 leaves them unpaced). A wait in its queue ends when the request is
   * aborted.
   */
  minIntervalMs?: number
  /** Value of `User-Agent` unless the request sets one. Default `agentproto-collect`. */
  userAgent?: string
  /** Response size cap in bytes. Default 10 MiB. See `createHttpTransport`. */
  maxBytes?: number
  /** Redirect hops followed per request. Default 10. */
  maxRedirects?: number
  /** Also retry POST and PATCH on network errors and 5xx. Default false. */
  retryUnsafeMethods?: boolean
  /** Injectable for tests: `[0, 1)`. Default `Math.random`. */
  random?: () => number
  /** Injectable for tests: time and sleep. Default system time. */
  clock?: Clock
  /** Injectable for tests. Default global `fetch`. */
  fetch?: typeof fetch
}

const MiB = 1024 * 1024
const DEFAULT_UA = "agentproto-collect"

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(done, ms)
      const onAbort = () => {
        clearTimeout(t)
        done()
      }
      function done() {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
}

/**
 * Wording of a bot-check interstitial page (matched on the first 64 KiB of an
 * HTML body, case-insensitively). Generic, vendor-neutral titles and phrases.
 */
const INTERSTITIAL_MARKERS: RegExp[] = [
  /<title>\s*just a moment/i,
  /<title>\s*attention required/i,
  /<title>\s*access denied/i,
  /<title>\s*(?:are you a robot|robot check|security check|verifying you are human|human verification)/i,
  /verify (?:that )?you are (?:a )?human/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /enable javascript and cookies to continue/i,
  /unusual traffic from your computer network/i,
  /cf-chl-|challenge-platform|__cf_chl/i,
]
/** Names of the widely used verification widgets. */
const WIDGET_MARKERS: RegExp[] = [/g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile|px-captcha|geo\.captcha-delivery\.com/i]
const CHALLENGE_STATUSES = new Set([403, 429, 503])
const CHALLENGE_SCAN_BYTES = 64 * 1024
/** A page nothing but a widget is tiny and has almost no visible text. */
const WIDGET_ONLY_MAX_BYTES = 4 * 1024
const WIDGET_ONLY_MAX_TEXT = 120

function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A verification page needs real evidence. It is one when:
 * - the response says so (`cf-mitigated: challenge`), or
 * - the status is 403, 429 or 503 and the HTML carries an interstitial phrase
 *   or a verification widget, or
 * - the body is nothing but the interstitial: under 4 KiB, a marker or widget
 *   present, and under 120 characters of visible text.
 * A normal page that embeds a widget or happens to contain a verification
 * phrase is not one.
 */
function looksLikeChallenge(status: number, headers: Record<string, string>, body: Uint8Array): boolean {
  if (headers["cf-mitigated"]?.toLowerCase() === "challenge") return true
  const type = headers["content-type"]?.toLowerCase() ?? ""
  if (type && !type.includes("html") && !type.includes("text/plain")) return false
  const head = new TextDecoder().decode(body.subarray(0, CHALLENGE_SCAN_BYTES))
  const interstitial = INTERSTITIAL_MARKERS.some((re) => re.test(head))
  const widget = WIDGET_MARKERS.some((re) => re.test(head))
  if (!interstitial && !widget) return false
  if (CHALLENGE_STATUSES.has(status)) return true
  return body.byteLength < WIDGET_ONLY_MAX_BYTES && visibleText(head).length < WIDGET_ONLY_MAX_TEXT
}

function extOf(headers: Record<string, string>): string {
  const t = headers["content-type"]?.toLowerCase() ?? ""
  if (t.includes("json")) return "json"
  if (t.includes("html")) return "html"
  if (t.includes("xml")) return "xml"
  if (t.startsWith("text/")) return "txt"
  return "bin"
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)"
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})"
/** IMF-fixdate, RFC 850, asctime: [day, month, year, h, m, s] capture orders. */
const DATE_FORMS: Array<{ re: RegExp; order: [number, number, number, number, number, number] }> = [
  { re: new RegExp(`^${DAY}, (\\d{2}) ${MON} (\\d{4}) ${TIME} GMT$`), order: [1, 2, 3, 4, 5, 6] },
  { re: new RegExp(`^${LONG_DAY}, (\\d{2})-${MON}-(\\d{2}) ${TIME} GMT$`), order: [1, 2, 3, 4, 5, 6] },
  { re: new RegExp(`^${DAY} ${MON} ( \\d|\\d{2}) ${TIME} (\\d{4})$`), order: [2, 1, 6, 3, 4, 5] },
]

/**
 * `Retry-After` in milliseconds, relative to `now`. Accepts a non-negative
 * integer number of seconds, or an HTTP date in IMF-fixdate, RFC 850 or
 * asctime form (GMT). Anything else is ignored (`undefined`).
 */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const v = value.trim()
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000
  for (const { re, order } of DATE_FORMS) {
    const m = re.exec(v)
    if (!m) continue
    const [d, mo, y, h, mi, se] = order.map((i) => m[i]!)
    let year = Number(y)
    if (y!.length === 2) {
      // RFC 850: a two-digit year more than 50 years ahead means the past century.
      year += 2000
      if (year > new Date(now).getUTCFullYear() + 50) year -= 100
    }
    const at = Date.UTC(year, MONTHS.indexOf(mo!.toLowerCase()), Number(d!.trim()), Number(h), Number(mi), Number(se))
    return Number.isNaN(at) ? undefined : Math.max(0, at - now)
  }
  return undefined
}

/** What can be put in a message without leaking a query string. */
function shown(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return "invalid URL"
  }
}

const RETRY_AFTER = new WeakMap<TransportError, number>()
const REDIRECT = new Set([301, 302, 303, 307, 308])
const SAFE = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
const ALWAYS_CREDENTIAL = ["authorization", "cookie", "proxy-authorization"]
const BODY_HEADERS = ["content-type", "content-length", "content-encoding"]
const MAX_MS = 3_600_000
const MAX_BYTES = 2 ** 30

function bounded(name: string, value: number, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}, got ${String(value)}`)
  }
  return value
}

/**
 * Real HTTP transport on Node's global `fetch`.
 *
 * - **Timeout**: one deadline per attempt (connect, headers, body). Exceeding
 *   it is a `network` error, unless the status line already arrived: then the
 *   status decides (see below).
 * - **Retries**: network errors, 429 and 5xx are retried up to `maxAttempts`
 *   with exponential backoff and jitter. 429 and 503 wait for `Retry-After`
 *   (seconds or date) instead, unless it exceeds `maxRetryAfterMs`, in which
 *   case the request gives up at once. A challenge page is never retried.
 *   POST and PATCH are not retried unless `retryUnsafeMethods`.
 * - **Redirects** are followed by hand (so the limiter and credential
 *   stripping apply to each hop); the returned `url` is the final one.
 *   Credential headers (`Authorization`, `Cookie`, `Proxy-Authorization` and
 *   the request's `credentialHeaders`) are dropped when a hop changes origin;
 *   a request with `urlCredential` refuses such a hop with a `blocked` error.
 *   A 301/302 on POST and any 303 become a GET without the body headers.
 * - **Size cap**: a 2xx body larger than `maxBytes` (declared by
 *   `Content-Length` or counted while streaming) aborts the transfer and
 *   fails with cause `http` and the response status, never retried. The body
 *   of a non-2xx response is truncated to the cap, not failed.
 * - **Errors**, all `TransportError`: 401/403 `blocked`; a verification page
 *   `challenge` (see `looksLikeChallenge` rules in the README); 429 or 5xx once
 *   retries are used up and any other non-2xx `http` with the status; an empty
 *   2xx body `empty`; DNS, reset, TLS, timeout, abort `network`. Once the
 *   headers of an error response arrived, its status and `Retry-After` are
 *   kept: a body that stalls or resets is cut short and the response still
 *   classifies by status. A caller cancellation always wins.
 * - **Limiter**: one pacing point at the send boundary, first send, retries and
 *   redirect hops alike; see `minIntervalMs`. Waits in its queue are abortable.
 *
 * Options are validated: a non-finite, negative or out-of-range value throws
 * a `RangeError`. No third-party dependency, no logging.
 */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const timeoutMs = bounded("timeoutMs", options.timeoutMs ?? 30_000, 1, MAX_MS)
  const maxAttempts = bounded("maxAttempts", options.maxAttempts ?? 3, 1, 10, true)
  const baseDelayMs = bounded("baseDelayMs", options.baseDelayMs ?? 500, 0, MAX_MS)
  const maxBackoffMs = bounded("maxBackoffMs", options.maxBackoffMs ?? 10_000, 0, MAX_MS)
  const maxRetryAfterMs = bounded("maxRetryAfterMs", options.maxRetryAfterMs ?? 30_000, 0, MAX_MS)
  const minIntervalMs = bounded("minIntervalMs", options.minIntervalMs ?? 1000, 0, MAX_MS)
  const maxBytes = bounded("maxBytes", options.maxBytes ?? 10 * MiB, 1, MAX_BYTES, true)
  const maxRedirects = bounded("maxRedirects", options.maxRedirects ?? 10, 0, 50, true)
  const userAgent = options.userAgent ?? DEFAULT_UA
  const random = options.random ?? Math.random
  const clock = options.clock ?? systemClock
  const doFetch = options.fetch ?? globalThis.fetch

  const hosts = new Map<string, { tail: Promise<void>; lastStart?: number }>()
  /** Waits for this host's turn. Throws when `signal` fires, before or while queued; an abandoned turn takes no slot. */
  async function gate(url: string, signal: AbortSignal): Promise<void> {
    if (minIntervalMs <= 0) return
    let host: string
    try {
      host = new URL(url).host.toLowerCase()
    } catch {
      return
    }
    let g = hosts.get(host)
    if (!g) hosts.set(host, (g = { tail: Promise.resolve() }))
    const state = g
    const mine = state.tail.then(async () => {
      for (;;) {
        if (signal.aborted) return
        const wait = state.lastStart === undefined ? 0 : state.lastStart + minIntervalMs - clock.now()
        if (wait <= 0) break
        await clock.sleep(wait, signal)
      }
      state.lastStart = clock.now()
    })
    state.tail = mine.catch(() => undefined)
    let onAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve()
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([mine, aborted])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted")
  }

  /**
   * Reads the body. `strict` (a 2xx body) fails on the cap and on any read error;
   * otherwise the cap truncates and a read error returns what arrived.
   */
  async function readBody(res: Response, strict: boolean, url: string, status: number, controller: AbortController): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"))
    if (strict && Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new TransportError("http", `response of ${declared} bytes exceeds the ${maxBytes} byte cap (${shown(url)})`, { status, url })
    }
    const chunks: Uint8Array[] = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (total + value.byteLength > maxBytes) {
            if (strict) {
              controller.abort()
              throw new TransportError("http", `response exceeds the ${maxBytes} byte cap (${shown(url)})`, { status, url })
            }
            chunks.push(value.subarray(0, maxBytes - total))
            total = maxBytes
            await reader.cancel().catch(() => undefined)
            break
          }
          chunks.push(value)
          total += value.byteLength
        }
      } catch (e) {
        if (strict || e instanceof TransportError) throw e
        // Best effort on an error response: keep the part that arrived.
      }
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
  }

  /** One attempt: every redirect hop, the limiter on each, one shared deadline. */
  async function once(req: HttpRequest): Promise<HttpResponse> {
    const timeout = bounded("timeoutMs", req.timeoutMs ?? timeoutMs, 1, MAX_MS)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout)
    const onCaller = () => controller.abort(req.signal?.reason)
    if (req.signal?.aborted) onCaller()
    req.signal?.addEventListener("abort", onCaller, { once: true })
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) lower[k.toLowerCase()] = v
    if (!lower["user-agent"]) lower["user-agent"] = userAgent
    if (!lower["accept"]) lower["accept"] = "*/*"
    const credentials = new Set([...ALWAYS_CREDENTIAL, ...(req.credentialHeaders ?? []).map((h) => h.toLowerCase())])
    let url = req.url
    let method = (req.method ?? "GET").toUpperCase()
    let body = req.body
    try {
      for (let hop = 0; ; hop++) {
        try {
          await gate(url, controller.signal)
        } catch (e) {
          throw networkError(e, url, req.signal, timeout)
        }
        let res: Response
        try {
          res = await doFetch(url, { method, headers: lower, body: body as never, redirect: "manual", signal: controller.signal })
        } catch (e) {
          throw networkError(e, url, req.signal, timeout)
        }
        const status = res.status
        if (REDIRECT.has(status) && res.headers.get("location")) {
          await res.body?.cancel().catch(() => undefined)
          if (hop >= maxRedirects) throw new TransportError("http", `more than ${maxRedirects} redirects (${shown(url)})`, { status, url })
          let next: URL
          try {
            next = new URL(res.headers.get("location")!, url)
          } catch {
            throw new TransportError("http", `invalid redirect target from ${shown(url)}`, { status, url })
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            throw new TransportError("http", `redirect to a non-http URL from ${shown(url)}`, { status, url })
          }
          if (next.origin !== new URL(url).origin) {
            if (req.urlCredential) {
              // No status on purpose: the engine would read a 3xx as a final http failure.
              throw new TransportError("blocked", `refused a redirect to another origin: the request carries a credential in its URL (${shown(url)})`, {
                url,
              })
            }
            for (const h of credentials) delete lower[h]
          }
          if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
            if (method !== "HEAD") method = "GET"
            body = undefined
            for (const h of BODY_HEADERS) delete lower[h]
          }
          url = next.toString()
          continue
        }
        let bytes: Uint8Array
        try {
          bytes = await readBody(res, status >= 200 && status < 300, url, status, controller)
        } catch (e) {
          if (e instanceof TransportError) throw e
          throw networkError(e, url, req.signal, timeout)
        }
        // Cancellation stays authoritative even when the status had arrived.
        if (req.signal?.aborted) throw networkError(req.signal.reason, url, req.signal, timeout)
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
        return classify({ status, headers, body: bytes, url })
      }
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener("abort", onCaller)
    }
  }

  function networkError(e: unknown, url: string, caller: AbortSignal | undefined, timeout: number): TransportError {
    if (caller?.aborted) return new TransportError("network", `request aborted (${shown(url)})`, { url, origin: e })
    if (e instanceof Error && e.message === "timeout") {
      return new TransportError("network", `timed out after ${timeout} ms (${shown(url)})`, { url, origin: e })
    }
    const inner = e instanceof Error && e.cause instanceof Error ? e.cause : undefined
    const code = inner && "code" in inner ? String((inner as { code: unknown }).code) : undefined
    const why = code ?? inner?.message ?? (e instanceof Error ? e.message : "request failed")
    return new TransportError("network", `network error: ${why} (${shown(url)})`, { url, origin: e })
  }

  function classify(res: HttpResponse): HttpResponse {
    const { status, headers, body, url } = res
    const keep = { status, url, body, ext: extOf(headers) }
    if (looksLikeChallenge(status, headers, body)) {
      throw new TransportError("challenge", `verification page (HTTP ${status}, ${shown(url)})`, keep)
    }
    if (status >= 200 && status < 300) {
      if (body.byteLength === 0) throw new TransportError("empty", `empty body (HTTP ${status}, ${shown(url)})`, keep)
      return res
    }
    const err =
      status === 401 || status === 403
        ? new TransportError("blocked", `blocked (HTTP ${status}, ${shown(url)})`, keep)
        : new TransportError("http", `HTTP ${status} (${shown(url)})`, keep)
    if (status === 429 || status === 503) {
      const wait = parseRetryAfter(headers["retry-after"], clock.now())
      if (wait !== undefined) RETRY_AFTER.set(err, wait)
    }
    throw err
  }

  return {
    async request(req) {
      const retryable = SAFE.has((req.method ?? "GET").toUpperCase()) || options.retryUnsafeMethods === true
      for (let attempt = 1; ; attempt++) {
        try {
          return await once(req)
        } catch (e) {
          const err =
            e instanceof TransportError ? e : new TransportError("network", "request failed", { url: req.url, origin: e })
          const again =
            retryable &&
            attempt < maxAttempts &&
            !req.signal?.aborted &&
            (err.cause === "network" || (err.cause === "http" && err.status !== undefined && (err.status === 429 || err.status >= 500)))
          if (!again) throw err
          const hinted = RETRY_AFTER.get(err)
          let wait: number
          if (hinted !== undefined) {
            if (hinted > maxRetryAfterMs) {
              throw new TransportError("http", `${err.message}; Retry-After ${Math.round(hinted / 1000)}s exceeds the ${Math.round(maxRetryAfterMs / 1000)}s cap`, {
                status: err.status,
                url: err.url,
                body: err.body,
                ext: err.ext,
              })
            }
            wait = hinted
          } else {
            const step = Math.min(baseDelayMs * 2 ** (attempt - 1), maxBackoffMs)
            wait = step / 2 + (random() * step) / 2
          }
          await clock.sleep(wait, req.signal)
          if (req.signal?.aborted) throw new TransportError("network", `request aborted (${shown(req.url)})`, { url: req.url })
        }
      }
    },
  }
}
