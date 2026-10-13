import { connect as tcpConnect } from "node:net"
import {
  defineBrowser,
  type BrowserAttachOptions,
  type BrowserCookie,
  type BrowserDriver,
  type BrowserDriverCapabilities,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
  type CDPCommand,
} from "@agentproto/driver-browser"
import { ToolError } from "@agentproto/tool"
import { z } from "zod"
import { CdpConnection } from "./cdp.js"
import { ChromeCdpDriver, chromeDriverCapabilities } from "./driver.js"

/**
 * `chrome-live`: attach to the user's own, already running Chrome through the
 * remote debugging toggle at chrome://inspect/#remote-debugging (Chrome 144+).
 *
 * Nothing is launched, killed or written to the profile. One websocket per
 * endpoint (each new one makes Chrome ask the user for consent again). The
 * agent works in a window it opened itself and only ever addresses targets it
 * created: no `Target.getTargets`, no attach to a foreign tab, no `Browser.close`.
 * The F11 guard of the `chrome` provider (no LAUNCH on the default profile) is
 * untouched; this provider never launches.
 */

export const CHROME_LIVE_PROVIDER_ID = "chrome-live"
export const CHROME_LIVE_DEFAULT_PORT = 9222
export const CHROME_LIVE_DEFAULT_CONSENT_TIMEOUT_MS = 60_000
export const CHROME_LIVE_PORT_ENV = "CHROME_LIVE_PORT"
export const CHROME_LIVE_WS_URL_ENV = "CHROME_LIVE_WS_URL"
export const CHROME_REMOTE_DEBUGGING_PAGE = "chrome://inspect/#remote-debugging"

/** Stable error codes; hosts (Bureau's supervisor) classify launch failures by these. */
export const BROWSER_REMOTE_DEBUGGING_OFF_CODE = "browser:remote-debugging-off" as const
export const BROWSER_CONSENT_TIMEOUT_CODE = "browser:consent-timeout" as const
export const BROWSER_DISCONNECTED_CODE = "browser:disconnected" as const

/** Nothing listens on the debugging port: the toggle is off (or Chrome is not running). */
export class ChromeRemoteDebuggingOffError extends ToolError {
  readonly wsUrl: string
  constructor(wsUrl: string, cause?: unknown) {
    super({
      code: BROWSER_REMOTE_DEBUGGING_OFF_CODE,
      message: `[chrome-live] nothing answers at ${wsUrl}. Enable remote debugging at ${CHROME_REMOTE_DEBUGGING_PAGE}`,
      retryable: false,
      cause,
    })
    this.name = "ChromeRemoteDebuggingOffError"
    this.wsUrl = wsUrl
  }
}

/** The user did not click "Allow" in time, or Chrome refused the connection. */
export class ChromeConsentTimeoutError extends ToolError {
  readonly wsUrl: string
  constructor(wsUrl: string, detail: string, cause?: unknown) {
    super({
      code: BROWSER_CONSENT_TIMEOUT_CODE,
      message: `[chrome-live] Chrome did not accept the debugging connection at ${wsUrl} (${detail}). Click "Allow" in the dialog Chrome shows, then retry`,
      retryable: true,
      cause,
    })
    this.name = "ChromeConsentTimeoutError"
    this.wsUrl = wsUrl
  }
}

/** Chrome was closed or the websocket dropped mid-task. */
export class ChromeDisconnectedError extends ToolError {
  readonly wsUrl: string
  constructor(wsUrl: string, detail: string, cause?: unknown) {
    super({
      code: BROWSER_DISCONNECTED_CODE,
      message: `[chrome-live] lost the connection to Chrome at ${wsUrl} (${detail}). Launch again to reconnect; Chrome will ask for consent again`,
      retryable: true,
      cause,
    })
    this.name = "ChromeDisconnectedError"
    this.wsUrl = wsUrl
  }
}

const blankAsUnset = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v)

/** Typed env: `CHROME_LIVE_PORT` (1-65535) or `CHROME_LIVE_WS_URL` (ws:// or wss://). Blank counts as unset. */
export const chromeLiveEnvSchema = z.object({
  [CHROME_LIVE_PORT_ENV]: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65535).optional()),
  [CHROME_LIVE_WS_URL_ENV]: z.preprocess(blankAsUnset, z.string().regex(/^wss?:\/\//, "must be a ws:// or wss:// URL").optional()),
})

export function readChromeLiveEnv(env: Readonly<Record<string, string | undefined>>): { port?: number; wsUrl?: string } {
  const parsed = chromeLiveEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`[chrome-live] invalid env: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  }
  const port = parsed.data[CHROME_LIVE_PORT_ENV]
  const wsUrl = parsed.data[CHROME_LIVE_WS_URL_ENV]
  return { ...(port !== undefined ? { port } : {}), ...(wsUrl !== undefined ? { wsUrl } : {}) }
}

/** The fixed browser endpoint of the remote debugging toggle (no browser id). */
export function chromeLiveWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/devtools/browser`
}

export interface ChromeLiveProviderConfig {
  /** Full browser websocket URL. Beats `port` and the env. */
  wsUrl?: string
  /** Debugging port on 127.0.0.1. Default `CHROME_LIVE_PORT`, then 9222. */
  port?: number
  /** How long to wait for the user to click "Allow". Default 60s. */
  consentTimeoutMs?: number
  /** Opt-in: try `GET /json/version` for a `webSocketDebuggerUrl` first. Default false: the toggle answers /json/* empty, so the fixed URL is used directly. */
  discover?: boolean
  /** Env read for `CHROME_LIVE_*`. Default `process.env`; `launch({ env })` is merged over it. */
  env?: Readonly<Record<string, string | undefined>>
}

export interface ChromeLiveLaunchOptions extends BrowserLaunchOptions {
  /** Full browser websocket URL for this launch. */
  wsUrl?: string
}

export type ChromeLiveProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: ChromeLiveLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance>
}

export const chromeLiveDriverCapabilities: BrowserDriverCapabilities = {
  ...chromeDriverCapabilities,
  canMultiTarget: true,
  isUserVisible: true,
  // Read-only: Network.getCookies works, nothing is written into the user's profile.
  canCookies: false,
}

/** Domains and methods an agent may not send through `driver.send` (cdp_send) on the user's own Chrome. */
const REFUSED_DOMAINS = ["Target.", "Browser."] as const
const REFUSED_METHODS: ReadonlySet<string> = new Set([
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
])

export function isRefusedLiveCommand(method: string): boolean {
  return REFUSED_METHODS.has(method) || REFUSED_DOMAINS.some((d) => method.startsWith(d))
}

/** A page driver on one tab the provider created, with the guards of the live profile. */
export class ChromeLiveDriver extends ChromeCdpDriver {
  override readonly kind: string = CHROME_LIVE_PROVIDER_ID
  override readonly capabilities: BrowserDriverCapabilities = chromeLiveDriverCapabilities

  constructor(
    conn: CdpConnection,
    targetId: string,
    sessionId: string,
    private readonly wsUrl: string,
    private readonly onClosed: (targetId: string) => void,
  ) {
    super(conn, targetId, sessionId)
  }

  /** Cookies are read-only here: nothing is written into the user's real profile. */
  override async setCookies(cookies: readonly BrowserCookie[]): Promise<void> {
    if (cookies.length === 0) return
    throw new ToolError({ code: "unauthorised", message: "[chrome-live] cookies are read-only on the user's own Chrome profile" })
  }

  override async send<TResult = unknown, TParams = unknown>(command: CDPCommand<TParams>): Promise<TResult> {
    if (isRefusedLiveCommand(command.method)) {
      throw new ToolError({
        code: "unauthorised",
        message: `[chrome-live] ${command.method} is refused: the agent only drives the tabs it opened in the user's Chrome and never writes its cookies`,
      })
    }
    if (this.conn.closed) throw new ChromeDisconnectedError(this.wsUrl, `${command.method} on a closed connection`)
    try {
      return await super.send<TResult, TParams>(command)
    } catch (err) {
      if (this.conn.closed) throw new ChromeDisconnectedError(this.wsUrl, `${command.method} aborted`, err)
      throw err
    }
  }

  override async close(): Promise<void> {
    if (this.closed) return
    // Target.closeTarget on our own targetId only (see ChromeCdpDriver.close).
    await super.close()
    this.onClosed(this.target.id)
  }
}

interface LiveEntry {
  url: string
  conn: CdpConnection
  state: "open" | "dropped" | "stopped"
  /** Every target this provider created on this endpoint and that is still open. */
  targets: Set<string>
  /** The agent window, when `Browser.getWindowForTarget` answers. */
  windowId?: number
  drivers: Set<ChromeLiveDriver>
  /** Serializes attaches so two concurrent ones cannot both open a window. */
  lock: Promise<unknown>
  stopping?: Promise<void>
  log?: (line: string) => void
  owner?: BrowserInstance
}

/** What survives a dropped connection: our own targets, so a reconnect can still close them. */
interface Leftover {
  targets: Set<string>
  windowId?: number
}

const HEALTH_TIMEOUT_MS = 5_000
const DISCOVERY_TIMEOUT_MS = 1_500

function errnoCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string") return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

const DESCRIPTION =
  "Your own running Chrome (your logged-in profile), attached through Chrome's remote debugging toggle at chrome://inspect/#remote-debugging. " +
  "Launches nothing; Chrome asks you to Allow the connection. The agent works in its own window and never touches your tabs."

export function createChromeLiveProvider(config: ChromeLiveProviderConfig = {}): ChromeLiveProvider {
  const consentTimeoutMs = config.consentTimeoutMs ?? CHROME_LIVE_DEFAULT_CONSENT_TIMEOUT_MS
  const entries = new Map<string, LiveEntry>()
  const connecting = new Map<string, Promise<LiveEntry>>()
  const discovering = new Map<number, Promise<string>>()
  const leftovers = new Map<string, Leftover>()
  /** Endpoints that had a connection before: reconnecting there means a new consent dialog. */
  const seen = new Set<string>()

  function endpoint(opts: ChromeLiveLaunchOptions): { wsUrl?: string; port: number } {
    // Launch options, then the provider config, then the env; at each level a ws URL beats a port.
    const env = readChromeLiveEnv({ ...(config.env ?? process.env), ...opts.env })
    for (const level of [{ wsUrl: opts.wsUrl, port: opts.port || undefined }, config, env]) {
      if (level.wsUrl) return { wsUrl: level.wsUrl, port: CHROME_LIVE_DEFAULT_PORT }
      if (level.port) return { port: level.port }
    }
    return { port: CHROME_LIVE_DEFAULT_PORT }
  }

  async function discover(port: number): Promise<string> {
    const fixed = chromeLiveWsUrl(port)
    if (config.discover !== true) return fixed
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
      const text = res.ok ? await res.text() : ""
      const found = text ? (JSON.parse(text) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl : undefined
      return typeof found === "string" && /^wss?:\/\//.test(found) ? found : fixed
    } catch (err) {
      if (errnoCode(err) === "ECONNREFUSED") throw new ChromeRemoteDebuggingOffError(fixed, err)
      // The toggle answers HTTP with nothing; the fixed browser URL is the documented endpoint.
      return fixed
    }
  }

  function resolveUrl(opts: ChromeLiveLaunchOptions): Promise<string> {
    const { wsUrl, port } = endpoint(opts)
    if (wsUrl) return Promise.resolve(wsUrl)
    let pending = discovering.get(port)
    if (!pending) {
      pending = discover(port)
      discovering.set(port, pending)
      // A failed discovery is retried next time, not cached.
      pending.catch(() => {
        if (discovering.get(port) === pending) discovering.delete(port)
      })
    }
    return pending
  }

  /** Open the one websocket, then wait for the user's "Allow" (`Browser.getVersion` answers only after it). */
  async function openConnection(url: string, log?: (line: string) => void): Promise<CdpConnection> {
    const secs = Math.round(consentTimeoutMs / 1000)
    log?.(
      seen.has(url)
        ? `[chrome-live] reconnecting to ${url}: Chrome will ask for consent again, click "Allow" (waiting up to ${secs}s)`
        : `[chrome-live] connecting to ${url}: click "Allow" in Chrome's remote debugging dialog (waiting up to ${secs}s)`,
    )
    seen.add(url)
    const attempt = CdpConnection.connect(url, { timeoutMs: consentTimeoutMs })
    const timedOut = (): Error => new ChromeConsentTimeoutError(url, `no "Allow" within ${secs}s`)
    try {
      const conn = await withTimeout(
        attempt.catch((err: unknown) => {
          if (errnoCode(err) === "ECONNREFUSED") throw new ChromeRemoteDebuggingOffError(url, err)
          throw new ChromeConsentTimeoutError(url, `connection rejected: ${err instanceof Error ? err.message : String(err)}`, err)
        }),
        consentTimeoutMs,
        timedOut,
      )
      try {
        await withTimeout(conn.send("Browser.getVersion"), consentTimeoutMs, timedOut)
      } catch (err) {
        if (err instanceof ToolError) throw err
        throw new ChromeConsentTimeoutError(url, `connection rejected: ${err instanceof Error ? err.message : String(err)}`, err)
      }
      return conn
    } catch (err) {
      // A late open after the deadline must not leave a second live socket behind.
      attempt.then((c) => c.close(), () => {})
      throw err
    }
  }

  async function windowOf(entry: LiveEntry, targetId: string): Promise<number | undefined> {
    try {
      const { windowId } = await entry.conn.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId })
      return windowId
    } catch {
      return undefined
    }
  }

  async function open(url: string, ctx: BrowserHostContext): Promise<LiveEntry> {
    const conn = await openConnection(url, ctx.log)
    const entry: LiveEntry = {
      url,
      conn,
      state: "open",
      targets: new Set(),
      drivers: new Set(),
      lock: Promise.resolve(),
      ...(ctx.log ? { log: ctx.log } : {}),
    }
    // Our sessions are flat: a closed tab of ours shows up as detachedFromTarget on the browser session.
    conn.onEvent((event) => {
      if (event.method !== "Target.detachedFromTarget" || event.sessionId) return
      const targetId = (event.params as { targetId?: string } | undefined)?.targetId
      if (targetId) forget(entry, targetId)
    })
    conn.onClose((reason) => {
      if (entry.state !== "open") return
      entry.state = "dropped"
      if (entries.get(url) === entry) entries.delete(url)
      discovering.clear()
      if (entry.targets.size > 0) leftovers.set(url, { targets: new Set(entry.targets), ...(entry.windowId !== undefined ? { windowId: entry.windowId } : {}) })
      entry.log?.(`[chrome-live] lost the connection to Chrome at ${url} (${reason}); the next launch reconnects, and Chrome will ask for consent again`)
    })
    // Targets we opened before a drop are still ours; keep the ones that still exist.
    const left = leftovers.get(url)
    leftovers.delete(url)
    if (left) {
      for (const targetId of left.targets) {
        const windowId = await windowOf(entry, targetId)
        if (windowId === undefined) continue
        entry.targets.add(targetId)
        entry.windowId ??= windowId
      }
    }
    return entry
  }

  function forget(entry: LiveEntry, targetId: string): void {
    entry.targets.delete(targetId)
    if (entry.targets.size === 0) delete entry.windowId
  }

  async function createTab(entry: LiveEntry, url: string): Promise<string> {
    if (entry.targets.size === 0) {
      // No agent window yet (or the user closed it): open a dedicated one.
      const { targetId } = await entry.conn.send<{ targetId: string }>("Target.createTarget", { url, newWindow: true })
      entry.targets.add(targetId)
      const windowId = await windowOf(entry, targetId)
      if (windowId !== undefined) entry.windowId = windowId
      return targetId
    }
    // CDP cannot address a window in createTarget: it opens the tab in the last active window.
    // Activating one of our tabs first makes that the agent window; the windowId check catches a race.
    for (let attempt = 0; attempt < 2; attempt++) {
      const anchor = entry.targets.values().next().value as string
      await entry.conn.send("Target.activateTarget", { targetId: anchor })
      const { targetId } = await entry.conn.send<{ targetId: string }>("Target.createTarget", { url })
      entry.targets.add(targetId)
      if (entry.windowId === undefined) return targetId
      const windowId = await windowOf(entry, targetId)
      if (windowId === undefined || windowId === entry.windowId) return targetId
      await entry.conn.send("Target.closeTarget", { targetId }).catch(() => {})
      forget(entry, targetId)
      if (entry.targets.size === 0) return createTab(entry, url)
    }
    throw new Error("[chrome-live] the new tab kept opening outside the agent window (another Chrome window has focus); it was closed again, retry")
  }

  function makeInstance(entry: LiveEntry, wasAlreadyRunning: boolean): BrowserInstance {
    const mine = new Set<ChromeLiveDriver>()
    const instance: BrowserInstance = {
      id: `${CHROME_LIVE_PROVIDER_ID}:${new URL(entry.url).host}`,
      endpoints: { cdp: entry.url },
      wasAlreadyRunning,

      async health(): Promise<BrowserHealth> {
        if (entry.state !== "open" || entry.conn.closed) return { ok: false, reason: entry.state === "stopped" ? "stopped" : "disconnected" }
        // Over the existing connection: a new one would make Chrome ask for consent again.
        try {
          await withTimeout(entry.conn.send("Browser.getVersion"), HEALTH_TIMEOUT_MS, () => new Error("Browser.getVersion timed out"))
          return { ok: true }
        } catch (err) {
          return { ok: false, reason: `chrome unresponsive: ${err instanceof Error ? err.message : String(err)}` }
        }
      },

      async attach(attachOpts?: BrowserAttachOptions): Promise<BrowserDriver> {
        if (entry.state === "stopped") throw new Error(`[chrome-live] instance ${instance.id} is stopped`)
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const offered = attachOpts?.sessionPayload !== undefined
        if (offered) entry.log?.("[chrome-live] ignoring the session payload: cookies are read-only on your own Chrome profile")
        const run = entry.lock.then(async () => {
          const url = attachOpts?.initialUrl ?? "about:blank"
          const targetId = await createTab(entry, url)
          let driver: ChromeLiveDriver | undefined
          try {
            const { sessionId } = await entry.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
            driver = new ChromeLiveDriver(entry.conn, targetId, sessionId, entry.url, (id) => {
              forget(entry, id)
              entry.drivers.delete(driver as ChromeLiveDriver)
              mine.delete(driver as ChromeLiveDriver)
            })
            await driver.bootstrap()
            if (attachOpts?.initialUrl) driver.target.url = attachOpts.initialUrl
          } catch (err) {
            if (driver) await driver.close()
            else {
              await entry.conn.send("Target.closeTarget", { targetId }).catch(() => {})
              forget(entry, targetId)
            }
            if (entry.conn.closed && !(err instanceof ToolError)) throw new ChromeDisconnectedError(entry.url, "attach aborted", err)
            throw err
          }
          entry.drivers.add(driver)
          mine.add(driver)
          return driver
        })
        entry.lock = run.catch(() => {})
        return await run
      },

      async stop(): Promise<void> {
        if (entry.owner !== instance) {
          // A reused handle closes only the tabs it opened; the connection belongs to the first launch.
          for (const driver of [...mine]) await driver.close().catch(() => {})
          return
        }
        if (!entry.stopping) {
          entry.stopping = (async () => {
            const wasOpen = entry.state === "open"
            entry.state = "stopped"
            if (entries.get(entry.url) === entry) entries.delete(entry.url)
            if (!wasOpen || entry.conn.closed) {
              if (entry.targets.size > 0) entry.log?.(`[chrome-live] ${entry.targets.size} agent tab(s) stay open in Chrome: the connection is gone`)
              return
            }
            leftovers.delete(entry.url)
            for (const driver of [...entry.drivers]) await driver.close().catch(() => {})
            // Tabs adopted after a reconnect have no driver; close them by their (our own) targetId.
            for (const targetId of [...entry.targets]) {
              await entry.conn.send("Target.closeTarget", { targetId }).catch(() => {})
              forget(entry, targetId)
            }
            // Never Browser.close: that is the user's Chrome. Only our socket goes.
            entry.conn.close()
          })()
        }
        await entry.stopping
      },
    }
    return instance
  }

  async function launch(opts: ChromeLiveLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance> {
    const url = await resolveUrl(opts)
    const live = entries.get(url)
    if (live && live.state === "open" && !live.conn.closed) return makeInstance(live, true)
    const pending = connecting.get(url)
    if (pending) return makeInstance(await pending, true)

    const promise = open(url, ctx)
    connecting.set(url, promise)
    try {
      const entry = await promise
      entries.set(url, entry)
      entry.owner = makeInstance(entry, false)
      return entry.owner
    } finally {
      connecting.delete(url)
    }
  }

  return defineBrowser({
    id: CHROME_LIVE_PROVIDER_ID,
    name: "Chrome (your running browser)",
    description: DESCRIPTION,
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    capabilities: {
      canCaptureResponseBodies: true,
      canDispatchTrustedInput: true,
      canMultiTarget: true,
      isUserVisible: true,
      canFullPageScreenshot: true,
      headed: true,
      cdp: true,
      stealth: false,
      downloads: false,
    },
    install: [{ method: "path" }],
    config: [
      {
        id: "chrome-live-port",
        kind: "prompt",
        prompt: "Remote debugging port of your running Chrome (chrome://inspect/#remote-debugging)",
        type: "text",
        default: String(CHROME_LIVE_DEFAULT_PORT),
        persist: { env: CHROME_LIVE_PORT_ENV },
      },
      {
        id: "chrome-live-ws-url",
        kind: "prompt",
        prompt: "Full browser websocket URL instead of the port (leave blank for ws://127.0.0.1:<port>/devtools/browser)",
        type: "text",
        persist: { env: CHROME_LIVE_WS_URL_ENV },
      },
    ],
    launch,
    /** A bare TCP probe of the port: never a websocket, so it never triggers Chrome's consent dialog. */
    async check(): Promise<boolean> {
      let target: URL
      try {
        const { wsUrl, port } = endpoint({})
        target = new URL(wsUrl ?? chromeLiveWsUrl(port))
      } catch {
        return false
      }
      const port = Number(target.port) || (target.protocol === "wss:" ? 443 : 80)
      return await new Promise<boolean>((resolve) => {
        const socket = tcpConnect({ host: target.hostname, port, timeout: 1_000 })
        const done = (ok: boolean): void => {
          socket.destroy()
          resolve(ok)
        }
        socket.once("connect", () => done(true))
        socket.once("timeout", () => done(false))
        socket.once("error", () => done(false))
      })
    },
  }) as ChromeLiveProvider
}

/** The default chrome-live provider: `CHROME_LIVE_WS_URL`, else 127.0.0.1:`CHROME_LIVE_PORT` (9222). */
export const chromeLive: ChromeLiveProvider = createChromeLiveProvider()
