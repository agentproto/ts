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
   */
  maxRetryAfterMs?: number
  /**
   * Minimum gap between two request starts on the same host. Default 1000.
   * 0 turns the limiter off. The collect engine already gates every host by
   * the connector's pace; when you hand this transport to the engine, set 0
   * so the two do not wait one after the other. Used alone (outside the
   * engine) keep the default. If both are on, the engine's gate runs first
   * and this one only waits for the part of its own interval not yet elapsed,
   * so the waits do not add up, they overlap.
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
 * Markers of the usual bot-check interstitials, matched case-insensitively on
 * the first 64 KiB of an HTML body. Kept generic on purpose: vendor-neutral
 * wording of verification pages and the names of the widely used widgets.
 */
const CHALLENGE_MARKERS: RegExp[] = [
  /<title>\s*just a moment/i,
  /<title>\s*attention required/i,
  /<title>\s*access denied/i,
  /<title>\s*(?:are you a robot|robot check|security check|verifying you are human|human verification)/i,
  /verify (?:that )?you are (?:a )?human/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /enable javascript and cookies to continue/i,
  /unusual traffic from your computer network/i,
  /cf-chl-|challenge-platform|__cf_chl/i,
  /g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile|px-captcha|geo\.captcha-delivery\.com/i,
]
/** A 200 page this size or larger is real content that merely mentions a captcha. */
const CHALLENGE_MAX_OK_BYTES = 50 * 1024
const CHALLENGE_SCAN_BYTES = 64 * 1024

function looksLikeChallenge(status: number, headers: Record<string, string>, body: Uint8Array): boolean {
  if (headers["cf-mitigated"]?.toLowerCase() === "challenge") return true
  const type = headers["content-type"]?.toLowerCase() ?? ""
  if (type && !type.includes("html") && !type.includes("text/plain")) return false
  const blockedStatus = status === 403 || status === 429 || status === 503
  const okSmall = status >= 200 && status < 300 && body.byteLength < CHALLENGE_MAX_OK_BYTES
  if (!blockedStatus && !okSmall) return false
  const head = new TextDecoder().decode(body.subarray(0, CHALLENGE_SCAN_BYTES))
  return CHALLENGE_MARKERS.some((re) => re.test(head))
}

function extOf(headers: Record<string, string>): string {
  const t = headers["content-type"]?.toLowerCase() ?? ""
  if (t.includes("json")) return "json"
  if (t.includes("html")) return "html"
  if (t.includes("xml")) return "xml"
  if (t.startsWith("text/")) return "txt"
  return "bin"
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP-date, relative to `now`. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const v = value.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
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

/**
 * Real HTTP transport on Node's global `fetch`.
 *
 * - **Timeout**: one deadline per attempt (connect, headers, body). Exceeding
 *   it is a `network` error.
 * - **Retries**: network errors, 429 and 5xx are retried up to `maxAttempts`
 *   with exponential backoff and jitter. 429 and 503 wait for `Retry-After`
 *   (seconds or date) instead, unless it exceeds `maxRetryAfterMs`, in which
 *   case the request gives up at once. A challenge page is never retried.
 *   POST and PATCH are not retried unless `retryUnsafeMethods`.
 * - **Redirects** are followed by hand (so a host gate and credential
 *   stripping apply to each hop); the returned `url` is the final one.
 *   Credential headers are dropped when a hop changes origin.
 * - **Size cap**: a 2xx body larger than `maxBytes` (declared by
 *   `Content-Length` or counted while streaming) aborts the transfer and
 *   fails with cause `http` and the response status, never retried. The body
 *   of a non-2xx response is truncated to the cap, not failed.
 * - **Errors**, all `TransportError`: 401/403 `blocked`; a verification page
 *   `challenge` (see the markers above; on 403, 429, 503 any marker counts, on
 *   a small 2xx page too); 429 or 5xx once retries are used up and any other
 *   non-2xx `http` with the status; an empty 2xx body `empty`; DNS, reset,
 *   TLS, timeout, abort `network`. Failed responses keep their body and
 *   extension for the raw store.
 * - **Per-host limiter**: see `minIntervalMs`.
 *
 * No third-party dependency, no logging.
 */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxBackoffMs = options.maxBackoffMs ?? 10_000
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000
  const minIntervalMs = options.minIntervalMs ?? 1000
  const userAgent = options.userAgent ?? DEFAULT_UA
  const maxBytes = options.maxBytes ?? 10 * MiB
  const maxRedirects = options.maxRedirects ?? 10
  const random = options.random ?? Math.random
  const clock = options.clock ?? systemClock
  const doFetch = options.fetch ?? globalThis.fetch

  const hosts = new Map<string, { tail: Promise<void>; lastStart?: number }>()
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
    await mine
  }

  async function readBody(res: Response, strict: boolean, url: string, status: number, controller: AbortController): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"))
    if (strict && Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw new TransportError("http", `response of ${declared} bytes exceeds the ${maxBytes} byte cap (${shown(url)})`, { status, url })
    }
    if (!res.body) return new Uint8Array()
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
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
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
  }

  /** One attempt: every redirect hop, the gate on each, one shared deadline. */
  async function once(req: HttpRequest): Promise<HttpResponse> {
    const timeout = req.timeoutMs ?? timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout)
    const onCaller = () => controller.abort(req.signal?.reason)
    if (req.signal?.aborted) onCaller()
    req.signal?.addEventListener("abort", onCaller, { once: true })
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) lower[k.toLowerCase()] = v
    if (!lower["user-agent"]) lower["user-agent"] = userAgent
    if (!lower["accept"]) lower["accept"] = "*/*"
    const credentials = new Set([...ALWAYS_CREDENTIAL, ...(req.credentialHeaders ?? [])])
    let url = req.url
    let method = (req.method ?? "GET").toUpperCase()
    let body = req.body
    try {
      for (let hop = 0; ; hop++) {
        await gate(url, controller.signal)
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
          if (next.origin !== new URL(url).origin) for (const h of credentials) delete lower[h]
          if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
            if (method !== "HEAD") method = "GET"
            body = undefined
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
    if (status >= 200 && status < 300) {
      if (looksLikeChallenge(status, headers, body)) {
        throw new TransportError("challenge", `verification page (HTTP ${status}, ${shown(url)})`, keep)
      }
      if (body.byteLength === 0) throw new TransportError("empty", `empty body (HTTP ${status}, ${shown(url)})`, keep)
      return res
    }
    if (looksLikeChallenge(status, headers, body)) {
      throw new TransportError("challenge", `verification page (HTTP ${status}, ${shown(url)})`, keep)
    }
    const err =
      status === 401 || status === 403
        ? new TransportError("blocked", `blocked (HTTP ${status}, ${shown(url)})`, keep)
        : new TransportError("http", `HTTP ${status} (${shown(url)})`, keep)
    if (status === 429 || status === 503) {
      const wait = parseRetryAfter(headers["retry-after"], clock.now())
      if (wait !== undefined) RETRY_AFTER.set(err, wait)
    }
    return fail(err)
  }
  const fail = (e: TransportError): never => {
    throw e
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
