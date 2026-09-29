import type { BrowserContext as PwContext, CDPSession as PwCDPSession, Page as PwPage } from "playwright-core"
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

export const CHROMIUM_PROVIDER_ID = "chromium"

export const chromiumDriverCapabilities: BrowserDriverCapabilities = {
  canCaptureResponseBodies: true,
  canDispatchTrustedInput: true,
  canMultiTarget: true,
  canThrottleNetwork: true,
  isUserVisible: false,
  canScreencast: true,
  canRecordVideo: false,
  canStealth: false,
  canAiActions: false,
  canFullPageScreenshot: true,
  canCookies: true,
}

export interface ScreencastFrame {
  /** Base64 image bytes. */
  data: string
  format: "jpeg" | "png"
  timestampMs: number
  index: number
}

const MAX_SCREENCAST_FRAMES = 300
const MAX_REQUEST_BUFFER = 500

/** Playwright wants every cookie field present: `expires: -1` is a session cookie. */
export function toPlaywrightCookies(cookies: readonly BrowserCookie[]): Parameters<PwContext["addCookies"]>[0] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite ?? ("Lax" as const),
  }))
}

/**
 * Page control for one Playwright page, driven mostly over a raw CDP session
 * (the protocol every other CDP backend speaks). Closing the driver closes its
 * page and session; the browser process belongs to the instance.
 */
export class ChromiumBrowserDriver implements BrowserDriver {
  readonly kind = CHROMIUM_PROVIDER_ID
  readonly capabilities: BrowserDriverCapabilities = chromiumDriverCapabilities
  readonly target: BrowserTarget

  private readonly requests = new Map<string, NetworkRequestSummary>()
  private readonly order: string[] = []
  /** CDP timestamps are monotonic seconds; anchor each request to wall-clock via `wallTime`. */
  private readonly monotonicStart = new Map<string, number>()
  /** A document's bodies are gone once the page navigates away, so remember which loader each request belongs to. */
  private readonly loaderOf = new Map<string, string>()
  private readonly listeners = new Map<string, Set<CDPEventListener>>()
  private _closed = false

  private screencastFrames: ScreencastFrame[] = []
  private screencastActive = false
  private screencastIndex = 0
  private screencastFormat: "jpeg" | "png" = "jpeg"

  constructor(
    private readonly page: PwPage,
    private readonly cdp: PwCDPSession,
  ) {
    this.target = { id: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, url: page.url() }
  }

  get closed(): boolean {
    return this._closed
  }

  async bootstrap(): Promise<void> {
    await this.cdp.send("Network.enable")
    await this.cdp.send("Page.enable")
    await this.cdp.send("Runtime.enable")

    this.cdp.on("Network.requestWillBeSent", (e: unknown) => {
      const ev = e as {
        requestId: string
        loaderId?: string
        request: { url: string; method: string; headers: Record<string, string> }
        type?: string
        timestamp: number
        wallTime: number
      }
      this.monotonicStart.set(ev.requestId, ev.timestamp)
      if (ev.loaderId) this.loaderOf.set(ev.requestId, ev.loaderId)
      this.recordRequest({
        requestId: ev.requestId,
        url: ev.request.url,
        method: ev.request.method,
        ...(ev.type ? { resourceType: ev.type } : {}),
        requestHeaders: ev.request.headers,
        startedAt: Math.round(ev.wallTime * 1000),
      })
    })

    this.cdp.on("Network.responseReceived", (e: unknown) => {
      const ev = e as {
        requestId: string
        response: { status: number; statusText: string; headers: Record<string, string>; fromDiskCache?: boolean }
      }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      summary.status = ev.response.status
      summary.statusText = ev.response.statusText
      summary.responseHeaders = ev.response.headers
      if (ev.response.fromDiskCache !== undefined) summary.fromCache = ev.response.fromDiskCache
    })

    this.cdp.on("Page.frameNavigated", (e: unknown) => {
      const { frame } = e as { frame: { parentId?: string; loaderId: string } }
      if (frame.parentId) return
      for (const [requestId, summary] of this.requests) {
        const loader = this.loaderOf.get(requestId)
        if (loader !== undefined && loader !== frame.loaderId) summary.hasResponseBody = false
      }
    })

    this.cdp.on("Network.loadingFinished", (e: unknown) => {
      const ev = e as { requestId: string; timestamp: number }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      const monoStart = this.monotonicStart.get(ev.requestId)
      summary.completedAt =
        monoStart !== undefined ? Math.round(summary.startedAt + (ev.timestamp - monoStart) * 1000) : summary.startedAt
      summary.hasResponseBody = summary.status !== undefined
    })
  }

  private recordRequest(req: NetworkRequestSummary): void {
    this.requests.set(req.requestId, req)
    this.order.push(req.requestId)
    while (this.order.length > MAX_REQUEST_BUFFER) {
      const evicted = this.order.shift()
      if (evicted) {
        this.requests.delete(evicted)
        this.monotonicStart.delete(evicted)
        this.loaderOf.delete(evicted)
      }
    }
  }

  async navigate(options: NavigateOptions): Promise<void> {
    const waitUntil =
      options.waitUntil === "networkidle" ? "networkidle" : options.waitUntil === "domcontentloaded" ? "domcontentloaded" : "load"
    await this.page.goto(options.url, {
      waitUntil,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    })
    this.target.url = this.page.url()
  }

  private onScreencastFrame = (e: unknown): void => {
    if (!this.screencastActive) return
    const ev = e as { data: string; sessionId: number }
    this.screencastFrames.push({
      data: ev.data,
      format: this.screencastFormat,
      timestampMs: Date.now(),
      index: this.screencastIndex++,
    })
    if (this.screencastFrames.length > MAX_SCREENCAST_FRAMES) this.screencastFrames.shift()
    void this.cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {})
  }

  async startScreencast(opts?: { format?: "jpeg" | "png"; quality?: number; everyNthFrame?: number }): Promise<void> {
    if (this.screencastActive) return
    this.screencastFrames = []
    this.screencastIndex = 0
    this.screencastFormat = opts?.format ?? "jpeg"
    this.screencastActive = true
    this.cdp.on("Page.screencastFrame", this.onScreencastFrame)
    await this.cdp.send("Page.startScreencast", {
      format: this.screencastFormat,
      quality: opts?.quality ?? 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: opts?.everyNthFrame ?? 3,
    })
  }

  async stopScreencast(): Promise<{ frameCount: number }> {
    if (!this.screencastActive) return { frameCount: this.screencastFrames.length }
    this.screencastActive = false
    await this.cdp.send("Page.stopScreencast").catch(() => {})
    this.cdp.off("Page.screencastFrame", this.onScreencastFrame)
    return { frameCount: this.screencastFrames.length }
  }

  async getScreencastFrames(opts?: {
    offset?: number
    limit?: number
  }): Promise<{ frames: ScreencastFrame[]; totalFrames: number }> {
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? this.screencastFrames.length
    return { frames: this.screencastFrames.slice(offset, offset + limit), totalFrames: this.screencastFrames.length }
  }

  async evaluate<T = unknown>(options: EvaluateOptions): Promise<EvaluateResult<T>> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: options.expression,
      awaitPromise: options.awaitPromise,
      returnByValue: options.returnByValue,
    })) as { result: { value: unknown }; exceptionDetails?: { text: string } }

    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text}`)

    const serialized = JSON.stringify(result.result.value)
    const truncated = serialized !== undefined && serialized.length > options.maxResultBytes
    return { value: truncated ? undefined : (result.result.value as T), truncated }
  }

  async click(options: ClickOptions): Promise<void> {
    await this.page.click(options.selector, { button: options.button, clickCount: options.clickCount })
    this.target.url = this.page.url()
  }

  async fill(options: FillOptions): Promise<void> {
    if (options.clear) await this.page.fill(options.selector, "")
    await this.page.fill(options.selector, options.value)
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const target = options.selector ? this.page.locator(options.selector) : this.page
    // Playwright's Chromium has no webp encoder: report the format that matches the returned bytes.
    const encodedFormat = options.format === "webp" ? "png" : options.format
    const buf = await target.screenshot({
      type: encodedFormat,
      ...(encodedFormat === "jpeg" && options.quality !== undefined ? { quality: options.quality } : {}),
      ...(options.selector ? {} : { fullPage: options.fullPage }),
    })
    const viewport = this.page.viewportSize() ?? { width: 0, height: 0 }
    return { base64: buf.toString("base64"), format: encodedFormat, width: viewport.width, height: viewport.height }
  }

  async getDom(selector?: string): Promise<string> {
    if (selector) {
      return (await this.page.locator(selector).first().evaluate((el: { outerHTML: string }) => el.outerHTML)) ?? ""
    }
    return await this.page.content()
  }

  async listRequests(opts?: { since?: number; limit?: number }): Promise<NetworkRequestSummary[]> {
    const since = opts?.since ?? 0
    const limit = opts?.limit ?? 100
    const out: NetworkRequestSummary[] = []
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const req = this.requests.get(this.order[i]!)
      if (req && req.startedAt >= since) out.push(req)
    }
    return out.reverse()
  }

  async getRequestBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    return (await this.cdp.send("Network.getResponseBody", { requestId })) as { body: string; base64Encoded: boolean }
  }

  async send<TResult = unknown, TParams = unknown>(command: CDPCommand<TParams>): Promise<TResult> {
    return (await this.cdp.send(command.method as never, command.params as never)) as TResult
  }

  onEvent(method: string, listener: CDPEventListener): Unsubscribe {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
      this.cdp.on(method as never, (params: unknown) => {
        const s = this.listeners.get(method)
        if (s) for (const l of s) l({ method, params })
      })
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    if (this.screencastActive) {
      this.screencastActive = false
      await this.cdp.send("Page.stopScreencast").catch(() => {})
    }
    this.cdp.off("Page.screencastFrame", this.onScreencastFrame)
    this.listeners.clear()
    await this.cdp.detach().catch(() => {})
    await this.page.close().catch(() => {})
  }
}

/** Open a page in `context`, bind a CDP session and start network capture. */
export async function attachChromiumDriver(
  context: PwContext,
  opts: { initialUrl?: string; cookies?: readonly BrowserCookie[] } = {},
): Promise<ChromiumBrowserDriver> {
  if (opts.cookies && opts.cookies.length > 0) await context.addCookies(toPlaywrightCookies(opts.cookies))
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const driver = new ChromiumBrowserDriver(page, cdp)
  await driver.bootstrap()
  if (opts.initialUrl) await driver.navigate({ url: opts.initialUrl, waitUntil: "load" })
  return driver
}
