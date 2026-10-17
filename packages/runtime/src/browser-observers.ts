/**
 * Observer seam for the browser tools (AIP-63 section 7, rules O1-O7).
 *
 * Optional and empty by default: with no observer registered every browser
 * tool behaves exactly as before. State lives at module scope because
 * `registerBrowserTools` re-runs on every stateless `/mcp` request (O3).
 * Observers are registered by the operator only (in process, or through
 * `loadBrowserObserverModule`), never by a tool call (O2).
 */

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Driver access an observer may use for its own captures (frames, page
 * probes). It exists only on `onAttach`, only for providers that implement the
 * owned-target `screenshot` and `evaluate` primitives, and only for observers
 * the operator registered (O2). It is not reachable from a tool call.
 */
export interface BrowserCaptureHandle {
  screenshot(tabId?: string): Promise<{ data: string; format: "png" | "jpeg"; width?: number; height?: number }>
  /** Evaluates `expression` in the owned tab and returns its value. */
  evaluate(expression: string, tabId?: string): Promise<unknown>
}

export interface BrowserAttachEvent {
  sessionId: string
  provider: string
  instanceId: string
  /** Present when the provider can screenshot and evaluate. */
  capture?: BrowserCaptureHandle
}

export interface BrowserDetachEvent {
  sessionId: string
  reason: "stop" | "crash" | "shutdown"
}

export interface BrowserCallEvent {
  callId: string
  sessionId: string
  /** Tool id without the `browser_` prefix, e.g. `click`. */
  tool: string
  tabId?: string
  /** Locator-style arguments only. Value-bearing fields are removed before observers see them (O7). */
  args: Record<string, unknown>
}

export interface BrowserCallResultEvent extends BrowserCallEvent {
  durationMs: number
  ok: boolean
  error?: { code: string }
}

export interface BrowserScreenshotImage {
  /** Base64, no `data:` prefix. */
  data: string
  mimeType: string
  width?: number
  height?: number
}

export interface BrowserObserver {
  onAttach?(event: BrowserAttachEvent): void | Promise<void>
  onDetach?(event: BrowserDetachEvent): void | Promise<void>
  beforeCall?(event: BrowserCallEvent): void | Promise<void>
  afterCall?(event: BrowserCallResultEvent): void | Promise<void>
  transformScreenshot?(
    ctx: { sessionId: string; tabId?: string },
    image: BrowserScreenshotImage
  ): BrowserScreenshotImage | Promise<BrowserScreenshotImage>
}

export interface BrowserObserverRegistration {
  /** When true, a failing or timed-out `transformScreenshot` fails the tool call instead of passing the original through (O6). */
  requiredTransform?: boolean
}

interface Entry {
  observer: BrowserObserver
  requiredTransform: boolean
}

const observers = new Map<string, Entry>()
const attached = new Set<string>()

/** Budget for onAttach / onDetach / beforeCall / afterCall (O4). */
export const DEFAULT_OBSERVER_TIMEOUT_MS = 1500
/** Budget for one screenshot transform (image work is slower than a notification). */
export const DEFAULT_TRANSFORM_TIMEOUT_MS = 5000

let observerTimeoutMs = DEFAULT_OBSERVER_TIMEOUT_MS
let transformTimeoutMs = DEFAULT_TRANSFORM_TIMEOUT_MS
let observerLog: (msg: string) => void = msg => console.warn(msg)

export function registerBrowserObserver(
  id: string,
  observer: BrowserObserver,
  opts: BrowserObserverRegistration = {}
): void {
  observers.set(id, { observer, requiredTransform: opts.requiredTransform === true })
}

export function unregisterBrowserObserver(id: string): void {
  observers.delete(id)
}

export function hasBrowserObservers(): boolean {
  return observers.size > 0
}

/** Test and shutdown helper: drop every observer and attach bookkeeping. */
export function resetBrowserObservers(): void {
  observers.clear()
  attached.clear()
  observerTimeoutMs = DEFAULT_OBSERVER_TIMEOUT_MS
  transformTimeoutMs = DEFAULT_TRANSFORM_TIMEOUT_MS
}

export function configureBrowserObservers(opts: {
  timeoutMs?: number
  transformTimeoutMs?: number
  log?: (msg: string) => void
}): void {
  if (opts.timeoutMs !== undefined) observerTimeoutMs = opts.timeoutMs
  if (opts.transformTimeoutMs !== undefined) transformTimeoutMs = opts.transformTimeoutMs
  if (opts.log) observerLog = opts.log
}

class ObserverTimeout extends Error {}

async function withBudget<T>(run: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObserverTimeout(`exceeded ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Never log arguments or payloads: only the observer id, the hook and the reason (O4). */
async function notify(
  hook: "onAttach" | "onDetach" | "beforeCall" | "afterCall",
  event: unknown
): Promise<void> {
  const entries = [...observers.entries()]
  for (const [id, { observer }] of entries) {
    const fn = observer[hook] as ((e: unknown) => void | Promise<void>) | undefined
    if (!fn) continue
    try {
      await withBudget(() => fn.call(observer, event), observerTimeoutMs)
    } catch (err) {
      observerLog(
        `[browser-observer:${id}] ${hook} ignored: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export async function notifyBrowserAttach(event: BrowserAttachEvent): Promise<void> {
  if (observers.size === 0) return
  attached.add(event.sessionId)
  await notify("onAttach", event)
}

/** Fires at most once per attached session (O4). */
export async function notifyBrowserDetach(event: BrowserDetachEvent): Promise<void> {
  if (!attached.delete(event.sessionId)) return
  await notify("onDetach", event)
}

// ── Argument redaction (O7) ───────────────────────────────────────────────────

/**
 * Allowlist of argument names an observer may see. Anything else is dropped
 * before the call, notably `fill.value` and `evaluate.expression`: an
 * observer gets neither the value nor its length. An observer that needs to
 * know whether a target is a password field asks the page itself.
 */
const OBSERVABLE_ARG_KEYS = new Set([
  "sessionId",
  "tabId",
  "selector",
  "url",
  "button",
  "clickCount",
  "clear",
  "awaitPromise",
  "x",
  "y",
])

export function redactBrowserCallArgs(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof input !== "object" || input === null) return out
  for (const [k, v] of Object.entries(input)) {
    if (!OBSERVABLE_ARG_KEYS.has(k)) continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v
  }
  return out
}

// ── Call wrapper ──────────────────────────────────────────────────────────────

interface ToolResultLike {
  content?: { type: string; text?: string; [k: string]: unknown }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function transformFailed(message: string): ToolResultLike {
  return {
    content: [{ type: "text", text: `browser_screenshot: browser:transform_failed: ${message}` }],
    isError: true,
  }
}

async function transformScreenshotResult(
  ctx: { sessionId: string; tabId?: string },
  result: ToolResultLike
): Promise<ToolResultLike> {
  const sc = result.structuredContent
  if (!sc || typeof sc.data !== "string") return result
  let image: BrowserScreenshotImage = {
    data: sc.data,
    mimeType: sc.format === "jpeg" ? "image/jpeg" : "image/png",
    ...(typeof sc.width === "number" ? { width: sc.width } : {}),
    ...(typeof sc.height === "number" ? { height: sc.height } : {}),
  }
  for (const [id, { observer, requiredTransform }] of [...observers.entries()]) {
    if (!observer.transformScreenshot) continue
    try {
      image = await withBudget(() => observer.transformScreenshot!(ctx, image), transformTimeoutMs)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      observerLog(`[browser-observer:${id}] transformScreenshot failed: ${reason}`)
      if (requiredTransform) return transformFailed(`observer "${id}" failed`)
    }
  }
  const format = image.mimeType === "image/jpeg" ? "jpeg" : "png"
  const next: Record<string, unknown> = { ...sc, data: image.data, format }
  if (image.width !== undefined) next.width = image.width
  if (image.height !== undefined) next.height = image.height
  return { content: [{ type: "text", text: JSON.stringify(next) }], structuredContent: next }
}

type ToolHandler = (input: any, extra: any) => ToolResultLike | Promise<ToolResultLike>

/** Wrap one `browser_*` tool handler. With no observer registered it calls the handler untouched (O1). */
export function observeBrowserToolHandler(toolName: string, handler: ToolHandler): ToolHandler {
  const tool = toolName.replace(/^browser_/, "")
  return async (input, extra) => {
    if (observers.size === 0) return handler(input, extra)
    const callId = randomUUID()
    const args = redactBrowserCallArgs(input)
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : ""
    const tabId = typeof input?.tabId === "string" ? input.tabId : undefined
    const base: BrowserCallEvent = { callId, sessionId, tool, ...(tabId ? { tabId } : {}), args }
    const started = Date.now()
    await notify("beforeCall", base)
    let result: ToolResultLike
    try {
      result = await handler(input, extra)
    } catch (err) {
      await notify("afterCall", {
        ...base,
        durationMs: Date.now() - started,
        ok: false,
        error: { code: "browser:exception" },
      } satisfies BrowserCallResultEvent)
      throw err
    }
    if (tool === "screenshot" && !result.isError) {
      result = await transformScreenshotResult({ sessionId, ...(tabId ? { tabId } : {}) }, result)
    }
    await notify("afterCall", {
      ...base,
      durationMs: Date.now() - started,
      ok: result.isError !== true,
      ...(result.isError ? { error: { code: "browser:error" } } : {}),
    } satisfies BrowserCallResultEvent)
    return result
  }
}

const UNOBSERVED_TOOLS = new Set(["browser_adapter_list"])

/** Same McpServer, with every `browser_*` tool handler routed through the observer seam. */
export function withBrowserObservers<S extends object>(server: S): S {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== "tool" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value
      }
      return (...args: unknown[]) => {
        const name = args[0]
        const last = args.length - 1
        if (
          typeof name === "string" &&
          name.startsWith("browser_") &&
          !UNOBSERVED_TOOLS.has(name) &&
          typeof args[last] === "function"
        ) {
          args[last] = observeBrowserToolHandler(name, args[last] as ToolHandler)
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

// ── Operator module loader (boot) ─────────────────────────────────────────────

export interface BrowserObserverModuleApi {
  registerBrowserObserver: typeof registerBrowserObserver
  log: (msg: string) => void
}

/**
 * Load the operator-supplied observer module named by
 * `AGENTPROTO_BROWSER_OBSERVER_MODULE`. Trust rules: the path comes from the
 * daemon's own environment only, must be absolute, must resolve to a regular
 * file owned by the current user and not writable by group or others. The
 * module's default export is `(api) => void | Promise<void>`.
 */
export async function loadBrowserObserverModule(
  modulePath: string,
  api: Pick<BrowserObserverModuleApi, "log">
): Promise<void> {
  if (!isAbsolute(modulePath)) {
    throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE must be an absolute path (got "${modulePath}")`)
  }
  const real = await fs.realpath(modulePath).catch(() => {
    throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE: "${modulePath}" does not exist`)
  })
  const st = await fs.stat(real)
  if (!st.isFile()) throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE: "${real}" is not a regular file`)
  if (typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) {
      throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE: "${real}" is not owned by the daemon user`)
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE: "${real}" is writable by group or others`)
    }
  }
  const mod = (await import(pathToFileURL(real).href)) as { default?: unknown }
  if (typeof mod.default !== "function") {
    throw new Error(`AGENTPROTO_BROWSER_OBSERVER_MODULE: "${real}" must default-export a function (api) => void`)
  }
  await (mod.default as (a: BrowserObserverModuleApi) => void | Promise<void>)({
    registerBrowserObserver,
    log: api.log,
  })
  api.log(`[browser-observer] loaded ${real}`)
}
