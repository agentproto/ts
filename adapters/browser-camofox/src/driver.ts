import {
  BrowserUnsupportedError,
  type BehaviorProfile,
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
import { z } from "zod"
import { actionSettleMs, BLOCKED_PAGE_EXPRESSION, navDwellMs, sleep, typingOptions } from "./behavior.js"
import { camofoxCookieSchema, type CamofoxClient, type CamofoxCookie } from "./client.js"

export const CAMOFOX_PROVIDER_ID = "camofox"

/** Page-level capabilities of the camofox driver. Gecko: no CDP, no network capture. */
export function camofoxDriverCapabilities(nativeVideo: boolean): BrowserDriverCapabilities {
  return {
    canCaptureResponseBodies: false,
    canDispatchTrustedInput: true,
    canMultiTarget: true,
    canThrottleNetwork: false,
    isUserVisible: false,
    canScreencast: false,
    canRecordVideo: nativeVideo,
    canStealth: true,
    canAiActions: false,
    canCookies: true,
    canFullPageScreenshot: false,
  }
}

const ATTACH_PAYLOAD_SCHEMA = z.object({ cookies: z.array(camofoxCookieSchema).optional() }).loose()

/** Explicit option wins, then `$BUREAU_BEHAVIOR`, then `human` (a raw session de-anonymizes what it touches). */
export function resolveBehavior(explicit?: BehaviorProfile, fallback?: BehaviorProfile): BehaviorProfile {
  if (explicit) return explicit
  if (fallback) return fallback
  const env = process.env["BUREAU_BEHAVIOR"]
  if (env === "fast" || env === "stealth" || env === "human") return env
  return "human"
}

function mapWaitUntil(w: NavigateOptions["waitUntil"]): "load" | "domcontentloaded" | "networkidle2" {
  return w === "networkidle" ? "networkidle2" : w
}

export class CamofoxBrowserDriver implements BrowserDriver {
  readonly kind = CAMOFOX_PROVIDER_ID
  readonly capabilities: BrowserDriverCapabilities
  closed = false

  constructor(
    private readonly client: CamofoxClient,
    private readonly sessionId: string,
    readonly target: BrowserTarget,
    private readonly behavior: BehaviorProfile,
    nativeVideo: boolean,
    private readonly ownsTab: boolean,
  ) {
    this.capabilities = camofoxDriverCapabilities(nativeVideo)
  }

  async navigate(options: NavigateOptions): Promise<void> {
    await this.client.navigate(this.sessionId, options.url, {
      waitUntil: mapWaitUntil(options.waitUntil),
      timeout: options.timeoutMs,
    })
    const dwell = navDwellMs(this.behavior)
    if (dwell > 0) await sleep(dwell)
    if (this.behavior === "stealth" && (await this.isBlocked())) {
      throw new Error(`camofox driver: navigation to ${options.url} hit an anti-bot wall (stealth profile)`)
    }
  }

  private async isBlocked(): Promise<boolean> {
    const r = await this.client
      .executeScript<boolean>(this.sessionId, `return ${BLOCKED_PAGE_EXPRESSION};`)
      .catch((): { value?: boolean } => ({ value: false }))
    return r.value === true
  }

  async evaluate<T = unknown>(options: EvaluateOptions): Promise<EvaluateResult<T>> {
    const result = await this.client.executeScript<T>(this.sessionId, `return (${options.expression});`)
    if (result.error) throw new Error(`camofox driver: evaluate failed: ${result.error}`)
    const truncated = JSON.stringify(result.value ?? null).length > options.maxResultBytes
    return { value: result.value, truncated }
  }

  async click(options: ClickOptions): Promise<void> {
    await this.client.click(this.sessionId, options.selector)
    const settle = actionSettleMs(this.behavior)
    if (settle > 0) await sleep(settle)
  }

  async fill(options: FillOptions): Promise<void> {
    await this.client.type(this.sessionId, options.selector, options.value, typingOptions(this.behavior))
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    if (options.fullPage) {
      throw new BrowserUnsupportedError({
        capability: "canFullPageScreenshot",
        providerId: CAMOFOX_PROVIDER_ID,
        tool: "screenshot",
      })
    }
    const buf = await this.client.getScreenshot(this.sessionId, {
      selector: options.selector,
      format: options.format,
      quality: options.quality,
    })
    return { base64: buf.toString("base64"), format: options.format, width: 0, height: 0 }
  }

  async getDom(selector?: string): Promise<string> {
    const script = selector
      ? `const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : "";`
      : `return document.documentElement.outerHTML;`
    const result = await this.client.executeScript<string>(this.sessionId, script)
    if (result.error) throw new Error(`camofox driver: getDom failed: ${result.error}`)
    return typeof result.value === "string" ? result.value : ""
  }

  async listRequests(): Promise<NetworkRequestSummary[]> {
    throw new BrowserUnsupportedError({ capability: "cdp", providerId: CAMOFOX_PROVIDER_ID, tool: "listRequests" })
  }

  async getRequestBody(): Promise<{ body: string; base64Encoded: boolean }> {
    throw new BrowserUnsupportedError({ capability: "cdp", providerId: CAMOFOX_PROVIDER_ID, tool: "getRequestBody" })
  }

  async send<TResult = unknown>(_command: CDPCommand): Promise<TResult> {
    throw new BrowserUnsupportedError({ capability: "cdp", providerId: CAMOFOX_PROVIDER_ID, tool: "send" })
  }

  onEvent(_method: string, _listener: CDPEventListener): Unsubscribe {
    return () => {}
  }

  /** Inject a cookie jar (browse as the user). The service has no export endpoint. */
  async setCookies(cookies: readonly CamofoxCookie[]): Promise<{ injected: number }> {
    await this.client.setCookies(this.sessionId, [...cookies])
    return { injected: cookies.length }
  }

  async getRecordedVideo(): Promise<{ base64: string; mimeType: string }> {
    const buf = await this.client.getRecordedVideo(this.sessionId)
    return { base64: buf.toString("base64"), mimeType: "video/webm" }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.ownsTab) await this.client.closeSession(this.sessionId)
  }
}

export interface AttachCamofoxDriverOptions {
  client: CamofoxClient
  nativeVideo: boolean
  behavior?: BehaviorProfile
  targetId?: string
  initialUrl?: string
  sessionPayload?: unknown
  /** Ask the server to exempt the tab from its idle reaper (a human login). */
  keepAlive?: boolean
}

/** Open (or bind to) a tab and wrap it in a driver. */
export async function attachCamofoxDriver(opts: AttachCamofoxDriverOptions): Promise<CamofoxBrowserDriver> {
  const { client } = opts
  const behavior = resolveBehavior(opts.behavior)
  if (opts.targetId) {
    return new CamofoxBrowserDriver(client, opts.targetId, { id: opts.targetId }, behavior, opts.nativeVideo, false)
  }
  const session = await client.createSession(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : undefined)
  const parsed = ATTACH_PAYLOAD_SCHEMA.safeParse(opts.sessionPayload)
  const cookies = parsed.success ? (parsed.data.cookies ?? []) : []
  if (cookies.length > 0) await client.setCookies(session.id, cookies)
  if (opts.initialUrl) await client.navigate(session.id, opts.initialUrl, { waitUntil: "load" })
  return new CamofoxBrowserDriver(
    client,
    session.id,
    { id: session.id, ...(opts.initialUrl ? { url: opts.initialUrl } : {}) },
    behavior,
    opts.nativeVideo,
    true,
  )
}
