import { connect as tcpConnect } from "node:net"
import {
  cookiesFromSessionPayload,
  defineBrowser,
  type BrowserAttachOptions,
  type BrowserCookie,
  type BrowserCookieSource,
  type BrowserDriver,
  type BrowserDriverCapabilities,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
  type CDPCommand,
  type CDPEventListener,
  type ClickOptions,
  type EvaluateOptions,
  type EvaluateResult,
  type FillOptions,
  type Unsubscribe,
} from "@agentproto/driver-browser"
import { ToolError } from "@agentproto/tool"
import { z } from "zod"
import { resolve as resolvePath } from "node:path"
import { CdpConnection } from "./cdp.js"
import { ChromeCdpDriver, chromeDriverCapabilities, toCdpCookieParams } from "./driver.js"
import { CHROME_LIVE_LAUNCH_PROFILE, launchDetachedChrome, type LaunchedChrome, type LiveLaunchDeps } from "./live-launch.js"

/**
 * `chrome-live`: either a DEDICATED, headful Chrome this provider launches
 * itself on a free port with its own persisted user-data-dir (never the
 * user's default profile, zero consent clicks), or an attach to the user's
 * own, already running Chrome through the remote debugging toggle at
 * chrome://inspect/#remote-debugging (Chrome 144+, port `CHROME_LIVE_PORT` /
 * 9222 by default).
 *
 * DEDICATED IS THE DEFAULT: with nothing pinned and no explicit ask, `launch()`
 * reuses the dedicated Chrome it already started (hot) or starts a fresh one —
 * no attach attempt, no consent wait, the user's Chrome is never touched or
 * even dialed. Attaching to the user's own Chrome only happens on an EXPLICIT
 * ask: a pinned endpoint (launch `wsUrl`/`port`, provider config, or
 * `CHROME_LIVE_*` env), or `opts.attachIntent: true` (a caller that
 * specifically wants the user's real, logged-in profile). An attach failure
 * (nothing listening, or no consent) is always surfaced with an actionable
 * message; silently falling back to a blank dedicated Chrome would mislead an
 * agent into believing it drove the user's real one. The child this provider
 * launches is recorded and only THAT pid is ever killed by `stop()` — the
 * user's own Chrome is never signalled.
 *
 * The agent works in a window it opened itself and only ever addresses targets
 * it created: no `Target.getTargets`, no attach to a foreign tab, no
 * `Browser.close`. The F11 guard of the `chrome` provider (no LAUNCH on the
 * default profile) is untouched — the dedicated Chrome launches on its own
 * profile, never the user's default one.
 *
 * `navigateOwnedTarget`/`domOwnedTarget` are the read path for an owned tab:
 * navigate reuses an existing owned tab (or opens one via `attach`) and
 * `ChromeCdpDriver.navigate` under the hood; `domOwnedTarget` serializes it
 * with `driver.getDom()`. `clickOwnedTarget`/`fillOwnedTarget`/
 * `evaluateOwnedTarget`/`scrollOwnedTarget` are the control path, each a thin
 * dispatch onto the same owned driver's `click`/`fill`/`evaluate` (scroll has
 * no driver primitive of its own — it's an `evaluate` of a generated
 * `scrollIntoView`/`scrollTo` expression). All six go through the same
 * `requireOwnedDriver` ownership guard as `screenshotOwnedTarget` — never a
 * foreign tab.
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
      message:
        `[chrome-live] nothing answers at ${wsUrl}. Enable remote debugging at ${CHROME_REMOTE_DEBUGGING_PAGE} ` +
        `and click "Allow" in the dialog Chrome shows, then retry. No dedicated browser was started.`,
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
      message:
        `[chrome-live] Chrome did not accept the debugging connection at ${wsUrl} (${detail}). ` +
        `Enable remote debugging at ${CHROME_REMOTE_DEBUGGING_PAGE}, click "Allow" in the dialog Chrome shows, then retry. ` +
        `No dedicated browser was started.`,
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
  /**
   * Read `GET /json/version` and connect to the advertised
   * `webSocketDebuggerUrl` (Chrome 155+ exposes a per-launch browser UUID:
   * `ws://127.0.0.1:9222/devtools/browser/<uuid>`; the id-less URL answers
   * 404). Default true. `false` is a legacy escape hatch that connects to the
   * fixed id-less URL, only useful for a Chrome whose `/json/version` is
   * unreachable but whose fixed endpoint still answers (pre-155 toggles).
   */
  discover?: boolean
  /** Env read for `CHROME_LIVE_*`. Default `process.env`; `launch({ env })` is merged over it. */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * May this provider ever launch a dedicated Chrome at all. Default `true`.
   * `false` means attach is the ONLY path: the default-dedicated-first
   * preference below is moot (there is nothing to prefer), and an attach
   * failure is surfaced as-is. It was never a fallback for attach failures.
   */
  autoLaunch?: boolean
  /**
   * `false` restores the OLD global default (attach preferred, dedicated only
   * when no attach is attempted) for every call this provider instance makes,
   * without touching call sites. Default `true` (unset counts as `true`): a bare
   * `launch({})` goes straight to the dedicated Chrome, no attach attempt.
   * A pinned endpoint or `opts.attachIntent` still forces attach-first
   * regardless of this flag (see `wantsAttachFirst`).
   */
  preferDedicated?: boolean
  /** Seams for the auto-launched Chrome (binary, spawn, free port, `/json/version`, dir, timeout). */
  launchDeps?: LiveLaunchDeps
  /**
   * Supplies cookies injected through `Network.setCookies` into the DEDICATED
   * Chrome this provider auto-launches — never the user's own, attached-to
   * Chrome (that path stays read-only, see `ChromeLiveDriver.setCookies`).
   * Called on every `attach()` of a dedicated instance; purely a seam — this
   * package has no opinion on where cookies come from or who may grant them.
   * `@agentproto/browser-profiles` builds a consent-gated implementation.
   */
  cookieSource?: BrowserCookieSource
}

export interface ChromeLiveLaunchOptions extends BrowserLaunchOptions {
  /** Full browser websocket URL for this launch. */
  wsUrl?: string
  /**
   * Test/dev seam: explicitly ask for the dedicated Chrome even when an
   * endpoint is pinned. This is an intentional dedicated launch, never a
   * reaction to an attach failure.
   */
  forceAutoLaunch?: boolean
  /**
   * Explicit ask: prefer attaching to the user's own Chrome (the remote
   * debugging toggle) over the dedicated-first default, for THIS call — for a
   * caller that specifically needs the user's real, logged-in profile. A
   * consent timeout or nothing listening surfaces an actionable error; it does
   * NOT silently fall back to the dedicated Chrome.
   */
  attachIntent?: boolean
  /**
   * The real Chrome profile directory (`Default`, `Profile 1`, …) the
   * injected cookies should trace back to — forwarded verbatim to
   * `config.cookieSource`'s `chromeProfile` field. Purely a passthrough:
   * this package does not read or validate it itself.
   */
  chromeProfile?: string
  /**
   * Narrow which domains' cookies get injected into the dedicated Chrome on
   * top of whatever `config.cookieSource` already scopes to — an AND, never
   * a widening. Omit to take everything the source returns.
   */
  domains?: readonly string[]
}

/** True when `host` is `domain` or one of its subdomains (same rule AIP-63 grants use). */
function cookieDomainMatches(host: string, domain: string): boolean {
  const h = host.replace(/^\./, "").toLowerCase()
  const d = domain.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

/** True when an endpoint was pinned (launch opts, provider config, or `CHROME_LIVE_*` env) — a literal ask to use THAT endpoint. */
export function pinnedEndpoint(config: ChromeLiveProviderConfig, opts: ChromeLiveLaunchOptions): boolean {
  if (opts.wsUrl || opts.port) return true
  if (config.wsUrl || config.port) return true
  const env = readChromeLiveEnv({ ...(config.env ?? process.env), ...opts.env })
  return env.wsUrl !== undefined || env.port !== undefined
}

/**
 * Whether `launch()` should try attaching to the user's own Chrome before the
 * dedicated one — true only on an explicit ask:
 * - a pinned endpoint (`pinnedEndpoint`) — a literal "use THIS Chrome",
 * - `opts.attachIntent` — a caller that specifically wants the user's real,
 *   logged-in profile,
 * - `config.preferDedicated === false` — restores the old global default for
 *   every call this provider instance makes,
 * - `config.autoLaunch === false` — dedicated launching is disabled outright,
 *   so attach is the only path left.
 *
 * Otherwise (the common case: nothing pinned, no explicit ask) the dedicated,
 * zero-consent Chrome comes first — `launch()` never dials the user's Chrome
 * at all. If an explicit attach is requested and fails, the error is surfaced
 * with an actionable message; there is NO silent fallback to the dedicated
 * Chrome.
 */
export function wantsAttachFirst(config: ChromeLiveProviderConfig, opts: ChromeLiveLaunchOptions): boolean {
  if (config.autoLaunch === false) return true
  if (opts.attachIntent === true) return true
  if (config.preferDedicated === false) return true
  return pinnedEndpoint(config, opts)
}

export type ChromeLiveProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: ChromeLiveLaunchOptions, ctx: BrowserHostContext): Promise<ChromeLiveInstance>
}

export interface ChromeLiveInstance extends BrowserInstance {
  screenshotOwnedTarget(targetId?: string): Promise<Awaited<ReturnType<BrowserDriver["screenshot"]>>>
  /**
   * Navigate one OWNED agent tab to `url` — reuses an existing owned tab
   * (any one, or the one named by `targetId`) via `driver.navigate()`, or
   * opens a fresh one via `attach({ initialUrl: url })` when none exists yet.
   * Never addresses a tab this instance didn't create.
   */
  navigateOwnedTarget(url: string, targetId?: string): Promise<{ targetId: string; url: string }>
  /**
   * Serialized DOM (`driver.getDom()`) of one OWNED agent tab — the same
   * "first active agent tab, or `targetId`" anchor rule as
   * `screenshotOwnedTarget`. Throws when no owned tab is open yet (navigate
   * first).
   */
  domOwnedTarget(targetId?: string): Promise<{ targetId: string; url: string; html: string }>
  /** Click an element by CSS selector on one OWNED agent tab — trusted CDP input at the element's center. */
  clickOwnedTarget(options: ClickOptions, targetId?: string): Promise<void>
  /** Fill an input element by CSS selector on one OWNED agent tab (focus + CDP `Input.insertText`). */
  fillOwnedTarget(options: FillOptions, targetId?: string): Promise<void>
  /** Evaluate a JS expression on one OWNED agent tab and return its value. */
  evaluateOwnedTarget<T = unknown>(options: EvaluateOptions, targetId?: string): Promise<EvaluateResult<T>>
  /** Scroll one OWNED agent tab: a CSS selector into view, or the window to an absolute `{x, y}`. */
  scrollOwnedTarget(options: ChromeLiveScrollOptions, targetId?: string): Promise<{ targetId: string }>
  /** Press one key (Enter, Tab, Escape, arrows, …) on one OWNED agent tab via trusted CDP input. */
  pressKeyOwnedTarget(options: ChromeLivePressKeyOptions, targetId?: string): Promise<{ targetId: string; key: string }>
  /** Select an option in a `<select>` by value, label or index on one OWNED agent tab. */
  selectOptionOwnedTarget(options: ChromeLiveSelectOptionOptions, targetId?: string): Promise<{ targetId: string; value: string; label: string; index: number }>
  /** Poll one OWNED agent tab until an element is attached/visible/enabled or its text appears. */
  waitForOwnedTarget(options: ChromeLiveWaitForOptions, targetId?: string): Promise<ChromeLiveWaitResult>
  /** Attach local files to one `<input type=file>` on an OWNED agent tab (CDP DOM.setFileInputFiles). */
  uploadFileOwnedTarget(options: ChromeLiveUploadFileOptions, targetId?: string): Promise<{ targetId: string; files: readonly string[] }>
  /** Open a FRESH tab in the agent's own window (never reusing an existing one) and navigate it to `url`. */
  newTabOwnedTarget(url?: string): Promise<{ targetId: string; url: string }>
  /** Every tab this provider created on this endpoint (targets it owns), with the window they live in. */
  listOwnedTabs(): Promise<{ targetId: string; url: string; windowId?: number }[]>
  /** Start Page.startScreencast on one OWNED agent tab (reused if one exists; attach() opens a fresh one otherwise). Idempotent per driver. */
  screencastStart(opts?: ChromeLiveScreencastOptions): Promise<{ targetId: string; index: number }>
  /** Latest buffered frame, or null before the first frame lands / after a stop. */
  screencastFrame(): Promise<ChromeLiveScreencastFrame | null>
  /** Stop the screencast and hand back every frame buffered since start (for the runtime's mp4 encoder). */
  screencastStop(): Promise<{ targetId: string | undefined; frameCount: number; total: number; frames: ChromeLiveScreencastFrame[] }>
}

/** `scrollOwnedTarget` options: either a selector to scroll into view, or an absolute window position. */
export interface ChromeLiveScrollOptions {
  /** CSS selector to scroll into view (centered). Takes precedence over `x`/`y` when both are given. */
  selector?: string
  /** Absolute horizontal scroll position in CSS px, when no `selector` is given. Default 0. */
  x?: number
  /** Absolute vertical scroll position in CSS px, when no `selector` is given. Default 0. */
  y?: number
}

/** Modifier keys accepted by `pressKeyOwnedTarget` (CDP `modifiers` bit flags). */
export type ChromeLiveKeyModifier = "Alt" | "Control" | "Meta" | "Shift"

/** `pressKeyOwnedTarget` options: one key (optionally focused on a selector first). */
export interface ChromeLivePressKeyOptions {
  /** Key name: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, or a single printable character. */
  key: string
  /** CSS selector to focus before pressing. Omit to press on whatever has focus. */
  selector?: string
  /** How many times to press it. Default 1. */
  count?: number
  /** Held modifier keys for this press. */
  modifiers?: readonly ChromeLiveKeyModifier[]
}

/** `selectOptionOwnedTarget` options: exactly one of `value`, `label` or `index`. */
export interface ChromeLiveSelectOptionOptions {
  /** CSS selector of the `<select>` element. */
  selector: string
  /** Match an option by its `value`. */
  value?: string
  /** Match an option by its visible label/text. */
  label?: string
  /** Match an option by its zero-based index. */
  index?: number
}

/** What `waitForOwnedTarget` polls for. */
export type ChromeLiveWaitState = "attached" | "visible" | "enabled" | "text"

/** `waitForOwnedTarget` options: a selector and/or text, a state, and a deadline. */
export interface ChromeLiveWaitForOptions {
  /** CSS selector of the element to wait for. Required unless `state` is `text` (page-wide text). */
  selector?: string
  /** Condition to wait for. Default `visible` when a selector is given, else `text`. */
  state?: ChromeLiveWaitState
  /** Text that must be present (element text when `selector` is set, page text otherwise). Required for `state: "text"`. */
  text?: string
  /** Give up after this many ms. Default 10_000. */
  timeoutMs?: number
  /** Poll interval in ms. Default 100. */
  pollMs?: number
}

/** Result of `waitForOwnedTarget`: matched condition + how long it took. */
export interface ChromeLiveWaitResult {
  targetId: string
  state: ChromeLiveWaitState
  matched: true
  elapsedMs: number
}

/** CDP key metadata for `pressKeyOwnedTarget`, keyed by canonical name. */
const KEY_TABLE: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
}

const KEY_ALIASES: Record<string, string> = {
  Return: "Enter",
  Esc: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  " ": "Space",
}

const MODIFIER_BITS: Record<ChromeLiveKeyModifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** DOM `KeyboardEvent.code` for printable non-letter characters (shifted forms map to their base key). */
const PRINTABLE_CODES: Record<string, string> = {
  "`": "Backquote",
  "~": "Backquote",
  "-": "Minus",
  "_": "Minus",
  "=": "Equal",
  "+": "Equal",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  "\\": "Backslash",
  "|": "Backslash",
  ";": "Semicolon",
  ":": "Semicolon",
  "'": "Quote",
  '"': "Quote",
  ",": "Comma",
  "<": "Comma",
  ".": "Period",
  ">": "Period",
  "/": "Slash",
  "?": "Slash",
  "!": "Digit1",
  "@": "Digit2",
  "#": "Digit3",
  $: "Digit4",
  "%": "Digit5",
  "^": "Digit6",
  "&": "Digit7",
  "*": "Digit8",
  "(": "Digit9",
  ")": "Digit0",
}

function codeForPrintable(ch: string): string {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`
  if (ch === " ") return "Space"
  return PRINTABLE_CODES[ch] ?? ch
}

function keyInfoOf(name: string): { key: string; code: string; vk: number; text?: string } | undefined {
  const canonical = KEY_ALIASES[name] ?? name
  const known = KEY_TABLE[canonical]
  if (known) return known
  if ([...canonical].length === 1) {
    const ch = canonical
    const upper = ch.toUpperCase()
    const vk = /^[a-z]$/i.test(ch) ? upper.charCodeAt(0) : ch.charCodeAt(0)
    return { key: ch, code: codeForPrintable(ch), vk, text: ch }
  }
  return undefined
}

/** Key presses with a held modifier never carry `text` (Chrome would insert a literal character). */
function keyEventParams(info: { key: string; code: string; vk: number; text?: string }, type: "keyDown" | "keyUp", modifiers: number): Record<string, unknown> {
  return {
    type,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    ...(modifiers ? { modifiers } : {}),
    ...(type === "keyDown" && info.text !== undefined && modifiers === 0
      ? { text: info.text, unmodifiedText: info.text }
      : {}),
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Parameters of `Page.startScreencast` the provider exposes. */
export interface ChromeLiveScreencastOptions {
  /** Frame encoding. Default `jpeg` (what CDP frames arrive as; png is CDP-legit but heavier). */
  format?: "jpeg" | "png"
  /** JPEG quality 1-100. Default 60. */
  quality?: number
  /** Only every Nth frame is sent. Default 3. Higher = fewer/lower-rate frames. */
  everyNthFrame?: number
  /** Stream width cap. Default 1280. */
  maxWidth?: number
  /** Stream height cap. Default 720. */
  maxHeight?: number
}

/** One `Page.screencastFrame` payload, normalized. `data` is base64 (no data: prefix). */
export interface ChromeLiveScreencastFrame {
  data: string
  format: "jpeg" | "png"
  timestampMs: number
  /** Monotonic frame counter since this screencast start (0-based) — the viewer/stream uses it to dedupe. */
  index: number
  /** Image size in px when Chrome reported it (`metadata.deviceWidth/deviceHeight`). */
  width?: number
  height?: number
}

/** Buffer for frames — generous but bounded: what a recording session turns into mp4. */
const MAX_SCREENCAST_FRAMES = 2000

export const chromeLiveDriverCapabilities: BrowserDriverCapabilities = {
  ...chromeDriverCapabilities,
  canMultiTarget: true,
  isUserVisible: true,
  // Read-only: Network.getCookies works, nothing is written into the user's profile.
  canCookies: false,
  // Page.startScreencast runs inside the driver's OWN flat session, on a tab
  // the provider opened — the same ownership story as Page.captureScreenshot.
  canScreencast: true,
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
    /**
     * Set once, at construction, from `entry.ownedChrome !== undefined` —
     * never from anything a caller passes later. This is the ONE thing
     * `setCookies` below trusts to tell the DEDICATED, zero-consent Chrome
     * this provider itself launched apart from the user's own, attached-to
     * Chrome: there is no public setter, and no other method ever flips it.
     */
    private readonly dedicated: boolean = false,
  ) {
    super(conn, targetId, sessionId)
  }

  /**
   * Writable ONLY on the dedicated Chrome this provider itself auto-launched
   * (`dedicated` — set once at construction, never by a caller). On an
   * attach to the user's own Chrome it stays exactly what it always was:
   * refused, nothing written into their real profile. Note this goes
   * straight to `this.conn.send`, not `this.send` — the `send` override's
   * `isRefusedLiveCommand` guard below exists to stop an AGENT writing
   * cookies through `cdp_send` on ANY chrome-live driver; it would refuse
   * `Network.setCookies` here too if routed through it, dedicated or not.
   * Values are never logged, only a count (by `attach()`'s caller).
   */
  override async setCookies(cookies: readonly BrowserCookie[]): Promise<void> {
    if (cookies.length === 0) return
    if (!this.dedicated) {
      throw new ToolError({ code: "unauthorised", message: "[chrome-live] cookies are read-only on the user's own Chrome profile" })
    }
    await this.conn.send<void>("Network.setCookies", { cookies: toCdpCookieParams(cookies) }, this.sessionId)
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
    this.disposeScreencast()
    // Target.closeTarget on our own targetId only (see ChromeCdpDriver.close).
    await super.close()
    this.onClosed(this.target.id)
  }

  /**
   * Attach local files to one `<input type=file>` on THIS target — CDP
   * `DOM.setFileInputFiles` (the same mechanism devtools uses; nothing is
   * ever written back out through it). Paths MUST already be absolute; the
   * selector's target is verified to be a real file input first.
   */
  async uploadFile(options: { selector: string; paths: readonly string[] }): Promise<{ files: readonly string[] }> {
    const files = options.paths.map((p) => resolvePath(p))
    const isFileInput = await this.evalRaw(
      `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return !!el && el.tagName === "INPUT" && el.type === "file" })()`,
      false,
      true,
    )
    if (isFileInput.result.value !== true) {
      throw new Error(`no <input type=file> matches selector ${options.selector}`)
    }
    const { root } = await this.send<{ root: { nodeId: number } }>(
      { method: "DOM.getDocument", params: { depth: 0 } },
    )
    const { nodeId } = await this.send<{ nodeId: number }>(
      { method: "DOM.querySelector", params: { nodeId: root.nodeId, selector: options.selector } },
    )
    if (!nodeId) throw new Error(`no <input type=file> matches selector ${options.selector}`)
    await this.send<void>({ method: "DOM.setFileInputFiles", params: { files, nodeId } })
    return { files }
  }

  // ── screencast ──────────────────────────────────────────────────────────────
  // Page.* only, on a tab the provider opened — the ownership guard of
  // isRefusedLiveCommand is untouched: frames come to us, we ack them, nothing
  // foreign is attached. The cast rides a DEDICATED flat session of its own
  // (freshly attached per start on the SAME owned target), because Chrome
  // stops delivering frames once a session has been through stop → start; a
  // fresh session sidesteps that quirk without churning tabs.
  // Target.detachFromTarget/attachToTarget go out through the BROWSER-level
  // connection directly (our own target only) — the driver's `send` guard is
  // not involved, and no event from another session can reach the listener.

  private screencastActive = false
  private screencastFormat: "jpeg" | "png" = "jpeg"
  private screencastIndex = 0
  private readonly screencastBuffer: ChromeLiveScreencastFrame[] = []
  private screencastSessionId?: string
  private screencastUnsubscribe?: Unsubscribe

  private screencastListener = (event: { params: unknown }): void => {
    if (!this.screencastActive) return
    const ev = event.params as {
      data?: string
      sessionId?: string
      metadata?: { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number }
    }
    if (!ev.data) return
    this.screencastBuffer.push({
      data: ev.data,
      format: this.screencastFormat,
      timestampMs: Date.now(),
      index: this.screencastIndex++,
      ...(ev.metadata?.deviceWidth !== undefined ? { width: ev.metadata.deviceWidth } : {}),
      ...(ev.metadata?.deviceHeight !== undefined ? { height: ev.metadata.deviceHeight } : {}),
    })
    if (this.screencastBuffer.length > MAX_SCREENCAST_FRAMES) this.screencastBuffer.shift()
    // Chrome throttles screencast delivery until each frame is acked: the ack
    // echoes the FRAME's own id (params.sessionId — not the flat session's).
    if (ev.sessionId) {
      void this.conn
        .send<void>("Page.screencastFrameAck", { sessionId: ev.sessionId }, this.screencastSessionId)
        .catch(() => {})
    }
  }

  /**
   * Cap the amount of screencast buffered frames; the same ring-buffer rule
   * the chromium provider applies. The runtime's recording path reads these
   * frames back with `screencastStop`/`getScreencastFrames` well inside the
   * window (an mp4 encode happens right after a `browser_screencast_stop`).
   */
  get screencastMaxFrames(): number {
    return MAX_SCREENCAST_FRAMES
  }

  get screencastRunning(): boolean {
    return this.screencastActive
  }

  /** The format the active (or most recent) screencast was started with. */
  screencastFormatNow(): "jpeg" | "png" {
    return this.screencastFormat
  }

  /** The monotonic index counter (what the next frame will carry). */
  lastScreencastIndex(): number {
    return this.screencastIndex
  }

  /** The flat session id the screencast runs in (its own, mp4-invisible). */
  screencastSessionNow(): string | undefined {
    return this.screencastSessionId
  }

  async startScreencast(opts?: ChromeLiveScreencastOptions): Promise<void> {
    if (this.conn.closed) throw new ChromeDisconnectedError(this.wsUrl, "startScreencast on a closed connection")
    if (this.screencastActive) return
    this.screencastIndex = 0
    this.screencastBuffer.length = 0
    this.screencastFormat = opts?.format ?? "jpeg"
    const params = {
      format: this.screencastFormat,
      quality: opts?.quality ?? 60,
      maxWidth: opts?.maxWidth ?? 1280,
      maxHeight: opts?.maxHeight ?? 720,
      everyNthFrame: opts?.everyNthFrame ?? 3,
    }
    try {
      // Fresh flat session per start (releasing the previous one first, when
      // there is one) — see the block comment above for why.
      if (this.screencastSessionId) {
        await this.conn
          .send<void>("Target.detachFromTarget", { sessionId: this.screencastSessionId })
          .catch(() => {})
        this.screencastSessionId = undefined
      }
      const sessionId = (await this.conn.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: this.target.id, flatten: true },
      )).sessionId
      this.screencastSessionId = sessionId
      this.screencastActive = true
      this.screencastUnsubscribe = this.conn.onEvent((event) => {
        if (event.sessionId !== sessionId || event.method !== "Page.screencastFrame") return
        this.screencastListener(event)
      })
      await this.conn.send<void>("Page.startScreencast", params, sessionId)
    } catch (err) {
      this.screencastActive = false
      this.screencastUnsubscribe?.()
      this.screencastUnsubscribe = undefined
      this.screencastSessionId = undefined
      if (this.conn.closed) throw new ChromeDisconnectedError(this.wsUrl, "startScreencast aborted", err)
      throw err
    }
  }

  async stopScreencast(): Promise<{ frameCount: number; frames: ChromeLiveScreencastFrame[]; total: number }> {
    const frames = [...this.screencastBuffer]
    if (!this.screencastActive) {
      return { frameCount: frames.length, frames, total: this.screencastIndex }
    }
    this.screencastActive = false
    this.screencastUnsubscribe?.()
    this.screencastUnsubscribe = undefined
    await this.conn
      .send<void>("Page.stopScreencast", {}, this.screencastSessionId)
      .catch(() => {})
    // The (fresh) cast session is released on the NEXT start; the current
    // session stays up so buffer reads keep being possible between stop and
    // the runtime's encode call.
    return { frameCount: frames.length, frames, total: this.screencastIndex }
  }

  /** Latest buffered frame (null before the first `Page.screencastFrame` lands). */
  getScreencastFrame(): ChromeLiveScreencastFrame | null {
    return this.screencastBuffer.length > 0 ? (this.screencastBuffer[this.screencastBuffer.length - 1] as ChromeLiveScreencastFrame) : null
  }

  getScreencastFrames(opts?: { limit?: number }): { frames: ChromeLiveScreencastFrame[]; total: number } {
    const limit = opts?.limit ?? this.screencastBuffer.length
    return {
      frames: this.screencastBuffer.slice(Math.max(0, this.screencastBuffer.length - limit)),
      total: this.screencastIndex,
    }
  }

  disposeScreencast(): void {
    this.screencastActive = false
    this.screencastUnsubscribe?.()
    this.screencastUnsubscribe = undefined
    if (this.screencastSessionId) {
      void this.conn
        .send<void>("Target.detachFromTarget", { sessionId: this.screencastSessionId })
        .catch(() => {})
      this.screencastSessionId = undefined
    }
    this.screencastBuffer.length = 0
    this.screencastIndex = 0
  }
}

/** `uploadFileOwnedTarget` options: attach local files to one `<input type=file>`. */
export interface ChromeLiveUploadFileOptions {
  /** CSS selector of the `<input type=file>` element to fill. */
  selector: string
  /** ABSOLUTE local paths on the SAME machine Chrome runs on. Gone through the runtime's allowlist. */
  paths: readonly string[]
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
  /** The driver currently screencasting this endpoint, when one does. */
  screencast?: { driver: ChromeLiveDriver; format: "jpeg" | "png" }
  /** Serializes attaches so two concurrent ones cannot both open a window. */
  lock: Promise<unknown>
  stopping?: Promise<void>
  log?: (line: string) => void
  owner?: ChromeLiveInstance
  /** Set only when THIS provider auto-launched the Chrome behind this endpoint; `stop()` kills it (and only it). */
  ownedChrome?: LaunchedChrome
}

/** What survives a dropped connection: our own targets, so a reconnect can still close them. */
interface Leftover {
  targets: Set<string>
  windowId?: number
}

const HEALTH_TIMEOUT_MS = 5_000
const DISCOVERY_TIMEOUT_MS = 1_500
/** Grace before SIGKILL when stopping a Chrome this provider auto-launched. */
const OWNED_STOP_GRACE_MS = 5_000

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
  "A dedicated headful Chrome on its own profile (no consent click) by default — fast, and your own browser is never touched. " +
  "Attaching to your real, logged-in Chrome (chrome://inspect/#remote-debugging) only happens on an explicit ask (a pinned endpoint, or attachIntent). " +
  "The agent works in its own window and never touches your tabs."

export function createChromeLiveProvider(config: ChromeLiveProviderConfig = {}): ChromeLiveProvider {
  const consentTimeoutMs = config.consentTimeoutMs ?? CHROME_LIVE_DEFAULT_CONSENT_TIMEOUT_MS
  const entries = new Map<string, LiveEntry>()
  const connecting = new Map<string, Promise<LiveEntry>>()
  const discovering = new Map<number, Promise<string>>()
  const leftovers = new Map<string, Leftover>()
  /** Endpoints that had a connection before: reconnecting there means a new consent dialog. */
  const seen = new Set<string>()
  /** The entry behind the Chrome THIS provider auto-launched, reused across launches so we never leak instances. */
  let autoEntry: LiveEntry | undefined

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
    if (config.discover === false) return fixed
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
      const text = res.ok ? await res.text() : ""
      const found = text ? (JSON.parse(text) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl : undefined
      return typeof found === "string" && /^wss?:\/\//.test(found) ? found : fixed
    } catch (err) {
      if (errnoCode(err) === "ECONNREFUSED") throw new ChromeRemoteDebuggingOffError(fixed, err)
      // A pre-155 toggle answers /json/* empty (or non-JSON); its fixed browser
      // URL is still the documented endpoint, so keep it as the fallback.
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
  async function openConnection(url: string, log?: (line: string) => void, launched = false): Promise<CdpConnection> {
    const secs = Math.round(consentTimeoutMs / 1000)
    log?.(
      launched
        ? `[chrome-live] connecting to the auto-launched Chrome at ${url} (no consent needed)`
        : seen.has(url)
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

  async function open(url: string, ctx: BrowserHostContext, owned?: LaunchedChrome): Promise<LiveEntry> {
    const conn = await openConnection(url, ctx.log, owned !== undefined)
    const entry: LiveEntry = {
      url,
      conn,
      state: "open",
      targets: new Set(),
      drivers: new Set(),
      lock: Promise.resolve(),
      ...(ctx.log ? { log: ctx.log } : {}),
      ...(owned ? { ownedChrome: owned } : {}),
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
      if (autoEntry === entry) autoEntry = undefined
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

  function makeInstance(entry: LiveEntry, wasAlreadyRunning: boolean, launchOpts: ChromeLiveLaunchOptions = {}): ChromeLiveInstance {
    const mine = new Set<ChromeLiveDriver>()
    // Captured once per `makeInstance` call (i.e. per `start_browser`), not
    // mutated on a hot-reused entry — a later caller that asks for different
    // domains/chromeProfile gets its OWN scoped view of the shared dedicated
    // Chrome, without touching what an earlier caller already injected.
    const cookieDomains = launchOpts.domains
    const cookieChromeProfile = launchOpts.chromeProfile

    /** The same "named targetId, else the first active agent tab" anchor rule as `screenshotOwnedTarget`/`domOwnedTarget`. */
    function requireOwnedDriver(targetId: string | undefined, verb: string): ChromeLiveDriver {
      const ownedTargetId = targetId ?? entry.targets.values().next().value
      if (!ownedTargetId) throw new Error(`[chrome-live] no agent-owned tab is open to ${verb}`)
      if (!entry.targets.has(ownedTargetId)) throw new Error(`[chrome-live] target "${ownedTargetId}" is not owned by this provider instance`)
      const driver = [...entry.drivers].find(candidate => candidate.target.id === ownedTargetId)
      if (!driver || driver.closed) throw new Error(`[chrome-live] agent-owned tab "${ownedTargetId}" has no active driver`)
      return driver
    }

    const instance: ChromeLiveInstance = {
      id: `${CHROME_LIVE_PROVIDER_ID}:${new URL(entry.url).host}`,
      endpoints: { cdp: entry.url },
      ...(entry.ownedChrome?.pid !== undefined ? { pid: entry.ownedChrome.pid } : {}),
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

      async screenshotOwnedTarget(targetId?: string) {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const ownedTargetId = targetId ?? entry.targets.values().next().value
        if (!ownedTargetId) throw new Error("[chrome-live] no agent-owned tab is open to screenshot")
        if (!entry.targets.has(ownedTargetId)) throw new Error(`[chrome-live] target "${ownedTargetId}" is not owned by this provider instance`)
        const driver = [...entry.drivers].find(candidate => candidate.target.id === ownedTargetId)
        if (!driver || driver.closed) throw new Error(`[chrome-live] agent-owned tab "${ownedTargetId}" has no active driver`)
        return driver.screenshot({ format: "png", fullPage: false })
      },

      async navigateOwnedTarget(url: string, targetId?: string): Promise<{ targetId: string; url: string }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        let driver: ChromeLiveDriver | undefined
        if (targetId) {
          if (!entry.targets.has(targetId)) throw new Error(`[chrome-live] target "${targetId}" is not owned by this provider instance`)
          driver = [...entry.drivers].find(candidate => candidate.target.id === targetId)
          if (!driver || driver.closed) throw new Error(`[chrome-live] agent-owned tab "${targetId}" has no active driver`)
        } else {
          // Reuse any live owned tab rather than opening a second one — the
          // same "first active agent tab" anchor as screenshotOwnedTarget.
          driver = [...entry.drivers].find(candidate => !candidate.closed)
        }
        if (driver) await driver.navigate({ url, waitUntil: "load" })
        else driver = (await this.attach({ initialUrl: url })) as ChromeLiveDriver
        // `driver.navigate`/`attach` only ever record the REQUESTED url on
        // `target.url` — a redirect (http->https, a canonical-url bounce,
        // ?slug params stripped) leaves it stale. Read back the committed
        // location; best-effort, since a page that navigates away again
        // immediately (or blocks script execution) can still fail this.
        try {
          const loc = await driver.evaluate<string>({ expression: "document.location.href", awaitPromise: false, returnByValue: true, maxResultBytes: 10_000 })
          if (typeof loc.value === "string" && loc.value) driver.target.url = loc.value
        } catch {
          // Keep the requested url below rather than fail the navigation over this.
        }
        return { targetId: driver.target.id, url: driver.target.url ?? url }
      },

      async domOwnedTarget(targetId?: string): Promise<{ targetId: string; url: string; html: string }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const ownedTargetId = targetId ?? entry.targets.values().next().value
        if (!ownedTargetId) throw new Error("[chrome-live] no agent-owned tab is open to read")
        if (!entry.targets.has(ownedTargetId)) throw new Error(`[chrome-live] target "${ownedTargetId}" is not owned by this provider instance`)
        const driver = [...entry.drivers].find(candidate => candidate.target.id === ownedTargetId)
        if (!driver || driver.closed) throw new Error(`[chrome-live] agent-owned tab "${ownedTargetId}" has no active driver`)
        const html = await driver.getDom()
        return { targetId: driver.target.id, url: driver.target.url ?? "", html }
      },

      async clickOwnedTarget(options: ClickOptions, targetId?: string): Promise<void> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        await requireOwnedDriver(targetId, "click").click(options)
      },

      async fillOwnedTarget(options: FillOptions, targetId?: string): Promise<void> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        await requireOwnedDriver(targetId, "fill").fill(options)
      },

      async evaluateOwnedTarget<T = unknown>(options: EvaluateOptions, targetId?: string): Promise<EvaluateResult<T>> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        return requireOwnedDriver(targetId, "evaluate").evaluate<T>(options)
      },

      async scrollOwnedTarget(options: ChromeLiveScrollOptions, targetId?: string): Promise<{ targetId: string }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const driver = requireOwnedDriver(targetId, "scroll")
        const expression = options.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return false; el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); return true })()`
          : `(() => { window.scrollTo({ left: ${Number(options.x ?? 0)}, top: ${Number(options.y ?? 0)}, behavior: "instant" }); return true })()`
        const result = await driver.evaluate<boolean>({ expression, awaitPromise: false, returnByValue: true, maxResultBytes: 1_000 })
        if (options.selector && result.value !== true) throw new Error(`[chrome-live] no element matches selector ${options.selector}`)
        return { targetId: driver.target.id }
      },

      async pressKeyOwnedTarget(options: ChromeLivePressKeyOptions, targetId?: string): Promise<{ targetId: string; key: string }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const driver = requireOwnedDriver(targetId, "press a key on")
        const info = keyInfoOf(options.key)
        if (!info) {
          throw new Error(
            `[chrome-live] unsupported key "${options.key}"; use Enter, Tab, Escape, Backspace, Delete, an Arrow key, Home, End, PageUp/PageDown, Space, or one printable character`,
          )
        }
        if (options.selector) {
          const focused = await driver.evaluate<boolean>({
            expression: `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return false; el.focus(); return true })() /* __chromeLiveFocus */`,
            awaitPromise: false,
            returnByValue: true,
            maxResultBytes: 1_000,
          })
          if (focused.value !== true) throw new Error(`[chrome-live] no element matches selector ${options.selector}`)
        }
        const count = options.count ?? 1
        if (!Number.isInteger(count) || count < 1) throw new Error("[chrome-live] count must be a positive integer")
        const modifiers = (options.modifiers ?? []).reduce((bits, m) => bits | (MODIFIER_BITS[m] ?? 0), 0)
        for (let i = 0; i < count; i++) {
          await driver.send({ method: "Input.dispatchKeyEvent", params: keyEventParams(info, "keyDown", modifiers) })
          await driver.send({ method: "Input.dispatchKeyEvent", params: keyEventParams(info, "keyUp", modifiers) })
        }
        return { targetId: driver.target.id, key: info.key }
      },

      async selectOptionOwnedTarget(options: ChromeLiveSelectOptionOptions, targetId?: string): Promise<{ targetId: string; value: string; label: string; index: number }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const driver = requireOwnedDriver(targetId, "select an option on")
        const given = [options.value !== undefined, options.label !== undefined, options.index !== undefined].filter(Boolean).length
        if (given !== 1) throw new Error("[chrome-live] browser_select needs exactly one of value, label or index")
        const matcher =
          options.value !== undefined
            ? `o.value === ${JSON.stringify(options.value)}`
            : options.label !== undefined
              ? `(o.label ?? o.text) === ${JSON.stringify(options.label)}`
              : `i === ${Number(options.index)}`
        const expression = `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)})
          if (!el) return { ok: false, reason: "no-selector" }
          if (el.tagName !== "SELECT") return { ok: false, reason: "not-select" }
          const options = Array.from(el.options)
          const index = options.findIndex((o, i) => ${matcher})
          if (index < 0) return { ok: false, reason: "no-option", options: options.map(o => ({ value: o.value, label: o.label ?? o.text })) }
          el.selectedIndex = index
          el.dispatchEvent(new Event("input", { bubbles: true }))
          el.dispatchEvent(new Event("change", { bubbles: true }))
          const chosen = options[index]
          return { ok: true, value: el.value, label: chosen.label ?? chosen.text, index }
        })() /* __chromeLiveSelect */`
        const result = await driver.evaluate<{
          ok: boolean
          reason?: string
          value?: string
          label?: string
          index?: number
          options?: Array<{ value: string; label: string }>
        }>({ expression, awaitPromise: false, returnByValue: true, maxResultBytes: 32_000 })
        const value = result.value
        if (!value) throw new Error(`[chrome-live] no element matches selector ${options.selector}`)
        if (!value.ok) {
          if (value.reason === "no-selector") throw new Error(`[chrome-live] no element matches selector ${options.selector}`)
          if (value.reason === "not-select") throw new Error(`[chrome-live] ${options.selector} is not a <select> element`)
          const wanted =
            options.value !== undefined ? `value "${options.value}"` : options.label !== undefined ? `label "${options.label}"` : `index ${options.index}`
          const available = (value.options ?? []).map((o) => `${o.value}=${o.label}`).join(", ")
          throw new Error(`[chrome-live] no option matching ${wanted} in ${options.selector}${available ? ` (available: ${available})` : ""}`)
        }
        return { targetId: driver.target.id, value: value.value ?? "", label: value.label ?? "", index: value.index ?? -1 }
      },

      async waitForOwnedTarget(options: ChromeLiveWaitForOptions, targetId?: string): Promise<ChromeLiveWaitResult> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const driver = requireOwnedDriver(targetId, "wait on")
        const state: ChromeLiveWaitState = options.state ?? (options.text !== undefined ? "text" : "visible")
        if (state !== "text" && !options.selector) throw new Error("[chrome-live] browser_wait_for needs a selector unless state is \"text\"")
        if (state === "text" && (options.text === undefined || options.text === "")) {
          throw new Error("[chrome-live] browser_wait_for with state \"text\" needs the text to look for")
        }
        const timeoutMs = options.timeoutMs ?? 10_000
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("[chrome-live] timeoutMs must be a non-negative number")
        const pollMs = Math.max(1, options.pollMs ?? 100)
        const stateExpr = JSON.stringify(state)
        const textExpr = JSON.stringify(options.text ?? "")
        // A text wait without a selector is a PAGE-WIDE wait: read
        // document.body.innerText instead of short-circuiting on a missing
        // element. Everything else needs the selected element.
        const check = options.selector
          ? `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)})
          if (el === null) return { ok: false, reason: "no-selector" }
          if (${stateExpr} === "text") {
            const haystack = el.textContent ?? ""
            return { ok: haystack.includes(${textExpr}) }
          }
          if (${stateExpr} === "attached") return { ok: true }
          if (${stateExpr} === "enabled") return { ok: !el.disabled }
          const rects = el.getClientRects()
          const style = getComputedStyle(el)
          return { ok: rects.length > 0 && style.visibility !== "hidden" && style.display !== "none" }
        })() /* __chromeLiveWait */`
          : `(() => {
          if (${stateExpr} !== "text") return { ok: false, reason: "no-selector" }
          return { ok: (document.body?.innerText ?? "").includes(${textExpr}) }
        })() /* __chromeLiveWait */`
        const started = Date.now()
        const deadline = started + timeoutMs
        const label = state === "text" ? `text ${JSON.stringify(options.text)} to appear` : `${options.selector} to become ${state}`
        for (;;) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw new Error(`[chrome-live] timed out after ${timeoutMs}ms waiting for ${label}`)
          // Bound each evaluation by the remaining deadline so a hung
          // renderer cannot push the wait past `timeoutMs`.
          const result = await withTimeout(
            driver.evaluate<{ ok: boolean }>({
              expression: check,
              awaitPromise: false,
              returnByValue: true,
              maxResultBytes: 4_000,
            }),
            Math.max(1, remaining),
            () => new Error(`[chrome-live] timed out after ${timeoutMs}ms waiting for ${label}`),
          )
          if (result.value?.ok === true) return { targetId: driver.target.id, state, matched: true, elapsedMs: Date.now() - started }
          const left = deadline - Date.now()
          if (left <= 0) throw new Error(`[chrome-live] timed out after ${timeoutMs}ms waiting for ${label}`)
          await sleep(Math.min(pollMs, left))
        }
      },

      async uploadFileOwnedTarget(options: ChromeLiveUploadFileOptions, targetId?: string): Promise<{ targetId: string; files: readonly string[] }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        const driver = requireOwnedDriver(targetId, "attach a file to")
        const { files } = await driver.uploadFile({ selector: options.selector, paths: options.paths })
        return { targetId: driver.target.id, files }
      },

      async newTabOwnedTarget(url?: string): Promise<{ targetId: string; url: string }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        // attach() always opens a FRESH tab (createTab: activate one of our
        // tabs first, so the new one lands in the agent window; driver-less
        // initialUrl still records the url).
        const driver = (await this.attach({ ...(url ? { initialUrl: url } : {}) })) as ChromeLiveDriver
        return { targetId: driver.target.id, url: driver.target.url ?? url ?? "about:blank" }
      },

      async listOwnedTabs(): Promise<{ targetId: string; url: string; windowId?: number }[]> {
        const tabs: { targetId: string; url: string; windowId?: number }[] = []
        for (const driver of entry.drivers) {
          if (driver.closed) continue
          const windowId = await windowOf(entry, driver.target.id)
          tabs.push({
            targetId: driver.target.id,
            url: driver.target.url ?? "",
            ...(windowId !== undefined ? { windowId } : {}),
          })
        }
        return tabs
      },

      async screencastStart(opts?: ChromeLiveScreencastOptions): Promise<{ targetId: string; index: number }> {
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        // The screencast follows the agent window: the driver already
        // screencasting wins, else any live driver (the "first active agent
        // tab" — the same anchor rule screenshotOwnedTarget uses), else
        // attach() opens one of our own tabs and casts it.
        let driver = entry.screencast?.driver && !entry.screencast.driver.closed ? entry.screencast.driver : undefined
        if (!driver) driver = [...entry.drivers].find(candidate => !candidate.closed)
        if (!driver) driver = (await this.attach()) as ChromeLiveDriver
        const before = driver.screencastRunning
        await driver.startScreencast(opts)
        entry.screencast = { driver, format: driver.screencastFormatNow() }
        return { targetId: driver.target.id, index: before ? driver.lastScreencastIndex() : 0 }
      },

      async screencastFrame(): Promise<ChromeLiveScreencastFrame | null> {
        // Deliberately tolerant of a missing/teared-down entry pointer: the
        // HTTP stream polls this fast and treats null as "no new frame yet";
        // a null while NO screencast is running is the caller's signal to 404.
        if (!entry.screencast) return null
        return entry.screencast.driver.getScreencastFrame()
      },

      async screencastStop(): Promise<{ targetId: string | undefined; frameCount: number; total: number; frames: ChromeLiveScreencastFrame[] }> {
        const active = entry.screencast
        if (!active) {
          return { targetId: undefined, frameCount: 0, total: 0, frames: [] }
        }
        const stopped = await active.driver.stopScreencast()
        // Frames stay buffered in the driver until its next startScreencast,
        // but the registry pointer clears: polling sees "no screencast".
        entry.screencast = undefined
        return { targetId: active.driver.target.id, frameCount: stopped.frameCount, total: stopped.total, frames: stopped.frames }
      },

      async attach(attachOpts?: BrowserAttachOptions): Promise<BrowserDriver> {
        if (entry.state === "stopped") throw new Error(`[chrome-live] instance ${instance.id} is stopped`)
        if (entry.state !== "open" || entry.conn.closed) throw new ChromeDisconnectedError(entry.url, "the connection dropped")
        // Injection only ever applies to the DEDICATED Chrome this provider
        // auto-launched (`entry.ownedChrome` set) — an attach-to-the-user's-
        // own-Chrome entry has none, so it keeps the read-only behaviour
        // below unconditionally, same as before this option existed.
        const dedicated = entry.ownedChrome !== undefined
        const offered = attachOpts?.sessionPayload !== undefined
        if (offered && !dedicated) entry.log?.("[chrome-live] ignoring the session payload: cookies are read-only on your own Chrome profile")
        const run = entry.lock.then(async () => {
          const url = attachOpts?.initialUrl ?? "about:blank"
          const targetId = await createTab(entry, url)
          let driver: ChromeLiveDriver | undefined
          try {
            const { sessionId } = await entry.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
            driver = new ChromeLiveDriver(
              entry.conn,
              targetId,
              sessionId,
              entry.url,
              (id) => {
                forget(entry, id)
                entry.drivers.delete(driver as ChromeLiveDriver)
                mine.delete(driver as ChromeLiveDriver)
              },
              dedicated,
            )
            await driver.bootstrap()
            if (dedicated) {
              // `config.cookieSource` may be unset (e.g. the default
              // `chromeLiveAdapter` singleton) — that's zero source cookies,
              // NOT a reason to also drop a session payload the caller
              // explicitly offered; a dedicated instance honors one either way.
              const sourced = config.cookieSource
                ? await config.cookieSource({
                    providerId: CHROME_LIVE_PROVIDER_ID,
                    profile: CHROME_LIVE_LAUNCH_PROFILE,
                    ...(cookieChromeProfile !== undefined ? { chromeProfile: cookieChromeProfile } : {}),
                    ...(cookieDomains !== undefined ? { domains: cookieDomains } : {}),
                  })
                : []
              const combined = [...sourced, ...cookiesFromSessionPayload(attachOpts?.sessionPayload)]
              // Belt and suspenders: narrow to `cookieDomains` ourselves too
              // (regardless of whether the source already did), and apply the
              // SAME ceiling to the session payload — `domains` is a hard cap
              // on what reaches the dedicated Chrome, not just on the source.
              const granted = cookieDomains ? combined.filter((c) => cookieDomains.some((d) => cookieDomainMatches(c.domain, d))) : combined
              if (granted.length > 0) {
                entry.log?.(`[chrome-live] injecting ${granted.length} granted cookie(s) via Network.setCookies (dedicated profile)`)
                await driver.setCookies(granted)
              }
            }
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
            const wasOpen = entry.state === "open" && !entry.conn.closed
            entry.state = "stopped"
            if (entries.get(entry.url) === entry) entries.delete(entry.url)
            if (!wasOpen && entry.targets.size > 0) {
              entry.log?.(`[chrome-live] ${entry.targets.size} agent tab(s) stay open in Chrome: the connection is gone`)
            }
            if (wasOpen) {
              leftovers.delete(entry.url)
              for (const driver of [...entry.drivers]) await driver.close().catch(() => {})
              // Tabs adopted after a reconnect have no driver; close them by their (our own) targetId.
              for (const targetId of [...entry.targets]) {
                await entry.conn.send("Target.closeTarget", { targetId }).catch(() => {})
                forget(entry, targetId)
              }
              // Never Browser.close: that could be the user's Chrome. Only our socket goes.
              entry.conn.close()
            }
            // Pid scissors: kill ONLY the Chrome this provider auto-launched.
            // An attach-only entry has no `ownedChrome`, so the user's own
            // Chrome (which we merely attached to) is never signalled.
            await stopOwnedChrome(entry.ownedChrome)
            entry.ownedChrome = undefined
            if (autoEntry === entry) autoEntry = undefined
          })()
        }
        await entry.stopping
      },
    }
    return instance
  }

  /** SIGTERM → (grace) SIGKILL a Chrome we spawned. No-op when we did not spawn it, or it already exited. */
  async function stopOwnedChrome(owned: LaunchedChrome | undefined): Promise<void> {
    if (!owned || owned.hasExited()) return
    const gone = new Promise<void>((resolve) => owned.process.once("exit", resolve))
    owned.process.kill("SIGTERM")
    const killer = setTimeout(() => owned.process.kill("SIGKILL"), OWNED_STOP_GRACE_MS)
    try {
      // Bounded: a child that never emits `exit` must not hang stop() forever.
      await withTimeout(gone, OWNED_STOP_GRACE_MS + 2_000, () => new Error("owned Chrome did not exit"))
    } catch {
      // Best-effort teardown: we already sent SIGKILL; move on.
    } finally {
      clearTimeout(killer)
    }
  }

  async function connectEntry(url: string, ctx: BrowserHostContext, owned?: LaunchedChrome, launchOpts: ChromeLiveLaunchOptions = {}): Promise<ChromeLiveInstance> {
    const live = entries.get(url)
    if (live && live.state === "open" && !live.conn.closed) return makeInstance(live, true, launchOpts)
    const pending = connecting.get(url)
    if (pending) return makeInstance(await pending, true, launchOpts)

    const promise = open(url, ctx, owned)
    connecting.set(url, promise)
    try {
      const entry = await promise
      entries.set(url, entry)
      entry.owner = makeInstance(entry, false, launchOpts)
      return entry.owner
    } finally {
      connecting.delete(url)
    }
  }

  /** Reuse the dedicated Chrome this provider already launched (hot), else launch a fresh one and connect to it. */
  async function launchDedicated(ctx: BrowserHostContext, launchOpts: ChromeLiveLaunchOptions = {}): Promise<ChromeLiveInstance> {
    const existing = autoEntry
    if (existing && existing.state === "open" && !existing.conn.closed) return makeInstance(existing, true, launchOpts)
    ctx.log?.(`[chrome-live] launching the dedicated Chrome`)
    const launched = await launchDetachedChrome({ ...config.launchDeps, ...(ctx.log ? { log: ctx.log } : {}) })
    try {
      const instance = await connectEntry(launched.wsUrl, ctx, launched, launchOpts)
      autoEntry = entries.get(launched.wsUrl)
      return instance
    } catch (connectErr) {
      // We launched it, so we clean it up ourselves before surfacing the error.
      await stopOwnedChrome(launched)
      throw connectErr
    }
  }

  async function launch(opts: ChromeLiveLaunchOptions, ctx: BrowserHostContext): Promise<ChromeLiveInstance> {
    // `forceAutoLaunch` is an explicit test/dev ask for the dedicated Chrome,
    // never a reaction to an attach failure.
    if (config.autoLaunch !== false && opts.forceAutoLaunch === true) return await launchDedicated(ctx, opts)
    if (!wantsAttachFirst(config, opts)) return await launchDedicated(ctx, opts)
    // Attach-only from here. A failure surfaces the typed error with an
    // actionable message; it NEVER silently switches to a blank dedicated
    // browser (that made an agent believe it drove the user's real Chrome).
    try {
      return await connectEntry(await resolveUrl(opts), ctx)
    } catch (err) {
      // The discovered URL now carries a per-launch browser UUID. If the
      // attach/connect fails (e.g. Chrome restarted before any onClose), drop
      // the cached value so the next launch rediscovers instead of dialing a
      // dead endpoint forever.
      discovering.delete(endpoint(opts).port)
      throw err
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
