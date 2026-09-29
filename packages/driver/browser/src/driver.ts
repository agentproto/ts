import { z } from "zod"
import type { BrowserDriverCapabilities } from "./capabilities.js"

/**
 * The `BrowserDriver` port: page and tab control against one attached target.
 * Canonical home of the page-control port, so every provider and host
 * shares one definition. Data shapes carry zod schemas;
 * behaviour stays a TypeScript interface.
 */

// ---------- Target identity ----------

/** One tab (or page) the driver is bound to. */
export const browserTargetSchema = z.object({
  /** Stable id within the driver session: a tab id or a page guid. */
  id: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
})
export type BrowserTarget = z.infer<typeof browserTargetSchema>

// ---------- CDP escape hatch ----------

/** Raw CDP command. `method` is e.g. `"Page.navigate"`. */
export interface CDPCommand<TParams = unknown> {
  method: string
  params?: TParams
}

/** Raw CDP event emitted by the attached target. */
export interface CDPEvent<TParams = unknown> {
  method: string
  params: TParams
}

export type CDPEventListener = (event: CDPEvent) => void
export type Unsubscribe = () => void

/** Faithful subset of CDP's `TargetInfo`. */
export interface CDPTargetInfo {
  targetId: string
  type: "page"
  title: string
  url: string
  attached: boolean
  openerId?: string
}

/** CDP `Target.getTargets` response shape. */
export interface CDPGetTargetsResult {
  targetInfos: CDPTargetInfo[]
}

// ---------- Network capture ----------

export const networkRequestSummarySchema = z.object({
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  fromCache: z.boolean().optional(),
  /** ms epoch. */
  startedAt: z.number(),
  completedAt: z.number().optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  /** Only populated lazily via `getRequestBody(requestId)`. */
  hasResponseBody: z.boolean().optional(),
})
export type NetworkRequestSummary = z.infer<typeof networkRequestSummarySchema>

// ---------- Tool-level options ----------

export const navigateOptionsSchema = z.object({
  url: z.string(),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .default("load"),
  timeoutMs: z.number().int().positive().optional(),
})
export type NavigateOptions = z.infer<typeof navigateOptionsSchema>

export const evaluateOptionsSchema = z.object({
  expression: z.string(),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
  /** Cap on serialized result size; oversize results return a truncation marker. */
  maxResultBytes: z.number().int().positive().default(64_000),
})
export type EvaluateOptions = z.infer<typeof evaluateOptionsSchema>

export const clickOptionsSchema = z.object({
  selector: z.string(),
  button: z.enum(["left", "middle", "right"]).default("left"),
  clickCount: z.number().int().min(1).max(3).default(1),
  /** Force trusted input even if a synthetic-DOM fallback would be cheaper. */
  trusted: z.boolean().default(true),
})
export type ClickOptions = z.infer<typeof clickOptionsSchema>

export const fillOptionsSchema = z.object({
  selector: z.string(),
  value: z.string(),
  /** Clear the existing value first. */
  clear: z.boolean().default(true),
})
export type FillOptions = z.infer<typeof fillOptionsSchema>

export const screenshotOptionsSchema = z.object({
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
  /**
   * Capture the whole scrollable page. Native when
   * `capabilities.canFullPageScreenshot`; otherwise the caller falls back to
   * scrolling and writing one file per viewport-height segment, and `path`
   * is required for that fallback.
   */
  fullPage: z.boolean().default(false),
  /** Optional CSS selector to clip to. */
  selector: z.string().optional(),
  /** Write the image to this file on the driver host instead of returning base64. */
  path: z.string().optional(),
})
export type ScreenshotOptions = z.infer<typeof screenshotOptionsSchema>

// ---------- Results ----------

export const evaluateResultSchema = z.object({
  value: z.unknown(),
  /** True when the result was clipped to `maxResultBytes`. */
  truncated: z.boolean(),
})
export interface EvaluateResult<T = unknown> {
  value: T | undefined
  truncated: boolean
}

const imageFormatSchema = z.enum(["png", "jpeg", "webp"])

export const screenshotResultSchema = z.object({
  /** Base64-encoded image bytes. */
  base64: z.string(),
  format: imageFormatSchema,
  width: z.number(),
  height: z.number(),
})
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>

/** Returned when `path` was set: the image was written to disk instead. */
export const screenshotFileResultSchema = z.object({
  path: z.string(),
  format: imageFormatSchema,
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
})
export type ScreenshotFileResult = z.infer<typeof screenshotFileResultSchema>

/** Returned for `fullPage` on a driver without native full-page capture. */
export const screenshotSegmentsResultSchema = z.object({
  paths: z.array(z.string()),
  format: imageFormatSchema,
  segments: z.number(),
  viewportWidth: z.number(),
  viewportHeight: z.number(),
  /** Full document scroll height in CSS px. */
  totalHeight: z.number(),
  /** True if the page was taller than the segment cap allows. */
  truncated: z.boolean(),
})
export type ScreenshotSegmentsResult = z.infer<
  typeof screenshotSegmentsResultSchema
>

// ---------- Attach ----------

/**
 * How human-like a driver's interactions are, chosen per session:
 * `human` (default) jitters typing and settles clicks, `fast` is raw and
 * instant, `stealth` adds anti-bot awareness. Backends without pacing
 * ignore it.
 */
export const behaviorProfileSchema = z.enum(["human", "fast", "stealth"])
export type BehaviorProfile = z.infer<typeof behaviorProfileSchema>

export const browserAttachOptionsSchema = z.object({
  targetId: z.string().optional(),
  /** Initial URL for backends that open a fresh page; ignored when attaching to an existing tab. */
  initialUrl: z.string().optional(),
  /** Optional cookie or storage seed, injected before first navigation where supported. */
  sessionPayload: z.unknown().optional(),
  behavior: behaviorProfileSchema.optional(),
})
export type BrowserAttachOptions = z.infer<typeof browserAttachOptionsSchema>

// ---------- The port ----------

/** Live handle to one target. Disposed via `close()`; methods may throw on detach. */
export interface BrowserDriver {
  /** Provider id that produced this driver. Open string: providers are pluggable. */
  readonly kind: string
  readonly capabilities: BrowserDriverCapabilities
  readonly target: BrowserTarget

  navigate(options: NavigateOptions): Promise<void>
  evaluate<T = unknown>(options: EvaluateOptions): Promise<EvaluateResult<T>>
  click(options: ClickOptions): Promise<void>
  fill(options: FillOptions): Promise<void>
  screenshot(options: ScreenshotOptions): Promise<ScreenshotResult>
  /** Serialized DOM (outerHTML of documentElement, post-render). */
  getDom(selector?: string): Promise<string>

  /** Recent network requests, newest last. Needs the `cdp` capability. */
  listRequests(opts?: {
    since?: number
    limit?: number
  }): Promise<NetworkRequestSummary[]>
  /** Fetch a response body. Needs `capabilities.canCaptureResponseBodies`. */
  getRequestBody(
    requestId: string,
  ): Promise<{ body: string; base64Encoded: boolean }>

  /** Raw CDP escape hatch. Needs the `cdp` capability. */
  send<TResult = unknown, TParams = unknown>(
    command: CDPCommand<TParams>,
  ): Promise<TResult>
  onEvent(method: string, listener: CDPEventListener): Unsubscribe

  /** List all tabs/pages in the browser. */
  listTabs?(): Promise<BrowserTarget[]>
  /** Open a new tab. */
  openTab?(opts: { url?: string; active?: boolean }): Promise<BrowserTarget>
  /** Pin subsequent tab-scoped ops to a specific tab id. */
  focusTab?(tabId: string): Promise<BrowserTarget>

  close(): Promise<void>
  readonly closed: boolean
}

/** Scopes a host can require before handing out a driver. */
export const BROWSER_DRIVER_SCOPES = {
  ATTACH: "browser_driver:attach",
  CONTROL: "browser_driver:control",
} as const
