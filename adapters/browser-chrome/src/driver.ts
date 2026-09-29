import {
  type BrowserCookie,
  type BrowserDriver,
  type BrowserDriverCapabilities,
  type BrowserTarget,
  type CDPCommand,
  type CDPEventListener,
  type ClickOptions,
  type EvaluateOptions,
  type EvaluateResult,
  type FillOptions,
  type NavigateOptions,
  type NetworkRequestSummary,
  type ScreenshotOptions,
  type ScreenshotResult,
  type Unsubscribe,
} from "@agentproto/driver-browser"
import type { CdpConnection, CdpEnvelope } from "./cdp.js"

export const CHROME_PROVIDER_ID = "chrome"

export const chromeDriverCapabilities: BrowserDriverCapabilities = {
  canCaptureResponseBodies: true,
  canDispatchTrustedInput: true,
  canMultiTarget: false,
  canThrottleNetwork: false,
  isUserVisible: false,
  canScreencast: false,
  canRecordVideo: false,
  canStealth: false,
  canAiActions: false,
  canFullPageScreenshot: true,
  canCookies: true,
}

const MAX_REQUEST_BUFFER = 500

/** The CDP `CookieParam` shape for one granted cookie. */
export function toCdpCookieParams(cookies: readonly BrowserCookie[]): Array<Record<string, unknown>> {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    ...(c.expires !== undefined && c.expires > 0 ? { expires: c.expires } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
  }))
}

interface RuntimeEvaluateResult {
  result: { value?: unknown }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

/** Page control over raw CDP on one target of a system Chrome, in its own flat session. */
export class ChromeCdpDriver implements BrowserDriver {
  readonly kind = CHROME_PROVIDER_ID
  readonly capabilities: BrowserDriverCapabilities = chromeDriverCapabilities
  readonly target: BrowserTarget

  private readonly requests = new Map<string, NetworkRequestSummary>()
  private readonly order: string[] = []
  private readonly loaderOf = new Map<string, string>()
  private readonly monotonicStart = new Map<string, number>()
  private readonly waiters = new Set<(event: CdpEnvelope) => void>()
  private readonly unsubscribe: Unsubscribe
  private _closed = false

  constructor(
    private readonly conn: CdpConnection,
    targetId: string,
    private readonly sessionId: string,
  ) {
    this.target = { id: targetId }
    this.unsubscribe = conn.onEvent((event) => {
      if (event.sessionId !== sessionId) return
      this.track(event)
      for (const waiter of this.waiters) waiter(event)
    })
  }

  get closed(): boolean {
    return this._closed
  }

  async bootstrap(): Promise<void> {
    await Promise.all([
      this.send({ method: "Network.enable" }),
      this.send({ method: "Page.enable" }),
      this.send({ method: "Runtime.enable" }),
    ])
    await this.send({ method: "Page.setLifecycleEventsEnabled", params: { enabled: true } })
  }

  /** Cookies go in through `Network.setCookies`; values are never logged. */
  async setCookies(cookies: readonly BrowserCookie[]): Promise<void> {
    if (cookies.length === 0) return
    await this.send({ method: "Network.setCookies", params: { cookies: toCdpCookieParams(cookies) } })
  }

  private track(event: CdpEnvelope): void {
    const params = (event.params ?? {}) as Record<string, unknown>
    if (event.method === "Network.requestWillBeSent") {
      const ev = params as unknown as {
        requestId: string
        loaderId?: string
        request: { url: string; method: string; headers: Record<string, string> }
        type?: string
        timestamp: number
        wallTime: number
      }
      this.monotonicStart.set(ev.requestId, ev.timestamp)
      if (ev.loaderId) this.loaderOf.set(ev.requestId, ev.loaderId)
      this.requests.set(ev.requestId, {
        requestId: ev.requestId,
        url: ev.request.url,
        method: ev.request.method,
        ...(ev.type ? { resourceType: ev.type } : {}),
        requestHeaders: ev.request.headers,
        startedAt: Math.round(ev.wallTime * 1000),
      })
      this.order.push(ev.requestId)
      while (this.order.length > MAX_REQUEST_BUFFER) {
        const evicted = this.order.shift()
        if (evicted) {
          this.requests.delete(evicted)
          this.monotonicStart.delete(evicted)
          this.loaderOf.delete(evicted)
        }
      }
    } else if (event.method === "Network.responseReceived") {
      const ev = params as unknown as {
        requestId: string
        response: { status: number; statusText: string; headers: Record<string, string>; fromDiskCache?: boolean }
      }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      summary.status = ev.response.status
      summary.statusText = ev.response.statusText
      summary.responseHeaders = ev.response.headers
      if (ev.response.fromDiskCache !== undefined) summary.fromCache = ev.response.fromDiskCache
    } else if (event.method === "Network.loadingFinished") {
      const ev = params as unknown as { requestId: string; timestamp: number }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      const start = this.monotonicStart.get(ev.requestId)
      summary.completedAt = start !== undefined ? Math.round(summary.startedAt + (ev.timestamp - start) * 1000) : summary.startedAt
      summary.hasResponseBody = summary.status !== undefined
    } else if (event.method === "Page.frameNavigated") {
      const { frame } = params as unknown as { frame: { parentId?: string; loaderId: string; url?: string } }
      if (frame.parentId) return
      if (frame.url) this.target.url = frame.url
      for (const [requestId, summary] of this.requests) {
        const loader = this.loaderOf.get(requestId)
        if (loader !== undefined && loader !== frame.loaderId) summary.hasResponseBody = false
      }
    }
  }

  private waitFor(match: (event: CdpEnvelope) => boolean, timeoutMs: number, what: string): { promise: Promise<void>; cancel(): void } {
    let cancel = (): void => {}
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`))
      }, timeoutMs)
      const waiter = (event: CdpEnvelope): void => {
        if (!match(event)) return
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve()
      }
      this.waiters.add(waiter)
      cancel = () => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
      }
    })
    return { promise, cancel }
  }

  async navigate(options: NavigateOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const lifecycle = options.waitUntil === "networkidle" ? "networkIdle" : options.waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "load"
    const settled = this.waitFor(
      (e) => e.method === "Page.lifecycleEvent" && (e.params as { name?: string }).name === lifecycle,
      timeoutMs,
      `the ${lifecycle} event`,
    )
    // A rejection with nobody awaiting yet must not become an unhandled rejection.
    settled.promise.catch(() => {})
    try {
      const nav = await this.send<{ errorText?: string }>({ method: "Page.navigate", params: { url: options.url } })
      if (nav.errorText) throw new Error(`navigation to ${options.url} failed: ${nav.errorText}`)
      await settled.promise
    } finally {
      settled.cancel()
    }
    this.target.url = options.url
  }

  private async evalRaw(expression: string, awaitPromise: boolean, returnByValue: boolean): Promise<RuntimeEvaluateResult> {
    const result = await this.send<RuntimeEvaluateResult>({
      method: "Runtime.evaluate",
      params: { expression, awaitPromise, returnByValue },
    })
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result
  }

  async evaluate<T = unknown>(options: EvaluateOptions): Promise<EvaluateResult<T>> {
    const result = await this.evalRaw(options.expression, options.awaitPromise, options.returnByValue)
    const value = result.result.value
    const serialized = JSON.stringify(value)
    const truncated = serialized !== undefined && serialized.length > options.maxResultBytes
    return { value: truncated ? undefined : (value as T), truncated }
  }

  private async centerOf(selector: string): Promise<{ x: number; y: number }> {
    const found = await this.evalRaw(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
      false,
      true,
    )
    const point = found.result.value as { x: number; y: number } | null | undefined
    if (!point) throw new Error(`no element matches selector ${selector}`)
    return point
  }

  async click(options: ClickOptions): Promise<void> {
    const { x, y } = await this.centerOf(options.selector)
    const button = options.button
    await this.send({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } })
    await this.send({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x, y, button, clickCount: options.clickCount } })
    await this.send({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x, y, button, clickCount: options.clickCount } })
  }

  async fill(options: FillOptions): Promise<void> {
    const ok = await this.evalRaw(
      `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return false; el.focus(); if (typeof el.select === "function") { ${
        options.clear ? "el.select()" : "el.setSelectionRange(el.value.length, el.value.length)"
      } } return true })()`,
      false,
      true,
    )
    if (ok.result.value !== true) throw new Error(`no element matches selector ${options.selector}`)
    if (options.value.length > 0) await this.send({ method: "Input.insertText", params: { text: options.value } })
    else if (options.clear) await this.send({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 } })
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const metrics = await this.send<{
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
      cssContentSize?: { width: number; height: number }
    }>({ method: "Page.getLayoutMetrics" })
    const viewport = metrics.cssVisualViewport ?? { clientWidth: 0, clientHeight: 0 }
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (options.selector) {
      const box = await this.evalRaw(
        `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } })()`,
        false,
        true,
      )
      const rect = box.result.value as { x: number; y: number; width: number; height: number } | null | undefined
      if (!rect) throw new Error(`no element matches selector ${options.selector}`)
      clip = { ...rect, scale: 1 }
    } else if (options.fullPage && metrics.cssContentSize) {
      clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 }
    }
    const shot = await this.send<{ data: string }>({
      method: "Page.captureScreenshot",
      params: {
        format: options.format,
        ...(options.format !== "png" && options.quality !== undefined ? { quality: options.quality } : {}),
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
      },
    })
    return {
      base64: shot.data,
      format: options.format,
      width: Math.round(clip?.width ?? viewport.clientWidth),
      height: Math.round(clip?.height ?? viewport.clientHeight),
    }
  }

  async getDom(selector?: string): Promise<string> {
    const expression = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : "" })()`
      : "document.documentElement.outerHTML"
    const result = await this.evalRaw(expression, false, true)
    return typeof result.result.value === "string" ? result.result.value : ""
  }

  async listRequests(opts?: { since?: number; limit?: number }): Promise<NetworkRequestSummary[]> {
    const since = opts?.since ?? 0
    const limit = opts?.limit ?? 100
    const out: NetworkRequestSummary[] = []
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const req = this.requests.get(this.order[i] as string)
      if (req && req.startedAt >= since) out.push(req)
    }
    return out.reverse()
  }

  async getRequestBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    return await this.send({ method: "Network.getResponseBody", params: { requestId } })
  }

  async send<TResult = unknown, TParams = unknown>(command: CDPCommand<TParams>): Promise<TResult> {
    return await this.conn.send<TResult>(command.method, command.params, this.sessionId)
  }

  onEvent(method: string, listener: CDPEventListener): Unsubscribe {
    return this.conn.onEvent((event) => {
      if (event.sessionId === this.sessionId && event.method === method) listener({ method, params: event.params })
    })
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.unsubscribe()
    this.waiters.clear()
    await this.conn.send("Target.closeTarget", { targetId: this.target.id }).catch(() => {})
  }
}

/** Open a fresh page target, attach a flat session to it, start capture, then seed cookies and the first URL. */
export async function attachChromeDriver(
  conn: CdpConnection,
  opts: { initialUrl?: string; cookies?: readonly BrowserCookie[] } = {},
): Promise<ChromeCdpDriver> {
  const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
  const driver = new ChromeCdpDriver(conn, targetId, sessionId)
  try {
    await driver.bootstrap()
    if (opts.cookies) await driver.setCookies(opts.cookies)
    if (opts.initialUrl) await driver.navigate({ url: opts.initialUrl, waitUntil: "load" })
  } catch (err) {
    await driver.close()
    throw err
  }
  return driver
}
