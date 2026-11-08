/**
 * The daemon's browser tools. Every one forwards to Bureau, the local
 * browser service imported as an MCP (`defaults.browser.proxyImport`,
 * `"bureau"` by default); the daemon no longer drives a browser of its own.
 *
 *   fetch_page              plain HTTP read (no browser) -> { title, text, url, blocked }
 *   list_browsers           -> Bureau browser_list_instances
 *   browser_navigate        -> Bureau browser_navigate
 *   browser_screenshot      -> Bureau browser_screenshot
 *   browser_get_dom         -> Bureau browser_get_dom
 *   browser_click           -> Bureau browser_click
 *   browser_fill            -> Bureau browser_fill
 *   browser_evaluate        -> Bureau browser_evaluate
 *   browser_press_key       -> Bureau browser_press_key
 *   browser_list_tabs       -> Bureau browser_list_owned_tabs
 *   browser_screencast_*    -> Bureau browser_record_start/frame/stop
 *   browser_extract_text    Bureau browser_get_dom, then the daemon's extractPageText
 *   browser_scroll          Bureau browser_evaluate with a fixed scroll script
 *
 * `defaults.browser.builtin: "off"` registers `fetch_page` alone.
 *
 * Retired, with no Bureau twin: `browser_select`, `browser_wait_for`,
 * `browser_upload_file`, `browser_new_tab`, `start_browser`, `stop_browser`,
 * `browser_status`, `browser_adapter_list`. Bureau gives every caller session
 * its own tab on first use, so `browser_navigate` replaces `start_browser` +
 * `browser_new_tab`.
 *
 * The calling session id rides on every forwarded call, so Bureau's tab
 * ownership applies per agent session.
 *
 * P4b: the chrome-live implementation (browser-screencast.ts,
 * browser-adapters.ts, @agentproto/adapter-browser, the `agentproto browser`
 * CLI, the bureau-sessions panel) is no longer reachable from any MCP tool.
 * The structural types and the live-instance map below survive only for the
 * HTTP chrome-live routes in http-server.ts and are deleted with them.
 *
 * Auth: same as every other daemon tool, gated by the gateway's auth source.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { loadConfig } from "./config.js"
import {
  callBureauExtractText,
  callBureauScroll,
  callProxiedBrowserTool,
  resolveBrowserProxyImport,
  type BrowserBuiltinMode,
  type BrowserProxyCaller,
  type ProxiedBrowserToolName,
} from "./browser-proxy.js"
import { extractPageText, looksBlocked } from "./page-text.js"
import { withBrowserObservers } from "./browser-observers.js"

// ── Minimal structural types (no dep on @agentproto/adapter-browser) ──────────
// P4b: these serve the HTTP chrome-live routes (http-server.ts) and
// browser-adapters.ts only; no MCP tool uses them.

/**
 * Minimal shape of a BrowserAdapterInstance — structurally compatible with
 * @agentproto/adapter-browser's BrowserAdapterInstance. Kept local so the
 * runtime package stays free of a hard dependency on the adapter package.
 */
interface BrowserInstanceLike {
  id: string
  port: number
  baseUrl: string
  pid?: number
  wasAlreadyRunning: boolean
  navigate?(url: string, tabId?: string): Promise<{ targetId: string; url: string }>
  getDom?(tabId?: string): Promise<{ targetId: string; url: string; html: string }>
  click?(
    options: { selector: string; button?: "left" | "middle" | "right"; clickCount?: number },
    tabId?: string
  ): Promise<void>
  fill?(options: { selector: string; value: string; clear?: boolean }, tabId?: string): Promise<void>
  evaluate?<T = unknown>(
    options: { expression: string; awaitPromise?: boolean; returnByValue?: boolean; maxResultBytes?: number },
    tabId?: string
  ): Promise<{ value: T | undefined; truncated: boolean }>
  scroll?(options: { selector?: string; x?: number; y?: number }, tabId?: string): Promise<{ targetId: string }>
  /** Press one key via trusted CDP input, optionally focusing a selector first (chrome-live). */
  pressKey?(
    options: { key: string; selector?: string; count?: number; modifiers?: readonly ("Alt" | "Control" | "Meta" | "Shift")[] },
    tabId?: string
  ): Promise<{ targetId: string; key: string }>
  /** Select a `<select>` option by value, label or index (chrome-live). */
  selectOption?(
    options: { selector: string; value?: string; label?: string; index?: number },
    tabId?: string
  ): Promise<{ targetId: string; value: string; label: string; index: number }>
  /** Wait for an element to be attached/visible/enabled, or for text (chrome-live). */
  waitFor?(
    options: { selector?: string; state?: "attached" | "visible" | "enabled" | "text"; text?: string; timeoutMs?: number; pollMs?: number },
    tabId?: string
  ): Promise<{ targetId: string; state: "attached" | "visible" | "enabled" | "text"; matched: true; elapsedMs: number }>
  /** Attach local files to one `<input type=file>` on an owned tab (CDP DOM.setFileInputFiles; paths absolute). */
  uploadFileOntoFileInput?(
    options: { selector: string; paths: readonly string[] },
    tabId?: string
  ): Promise<{ targetId: string; files: readonly string[] }>
  /** Open a FRESH tab (never reusing an existing one) and navigate it to `url`. */
  openNewTab?(url?: string): Promise<{ targetId: string; url: string }>
  /** Tabs owned by this provider instance on its endpoint. */
  listOwnedTabs?(): Promise<{ targetId: string; url: string; windowId?: number }[]>
  /** False when a non-blocking cold start returned before the service
   *  finished converging (background health-wait still running). */
  healthy: boolean
  health?(): Promise<{ ok: boolean; reason?: string }>
  screenshot?(tabId?: string): Promise<{ data: string; format: "png" | "jpeg"; width?: number; height?: number }>
  stop(): Promise<void>
}

/**
 * Minimal shape of a BrowserAdapterHandle — structurally compatible with
 * @agentproto/adapter-browser's BrowserAdapterHandle.
 */
interface BrowserAdapterLike {
  id: string
  name: string
  description: string
  defaultPort: number
  healthPath: string
  /** Where this adapter runs — "local" (default) or "cloud". */
  location?: "local" | "cloud"
  ensure(opts: {
    port?: number
    /** forwarded to dependent adapters (e.g. bureau→camofox) */
    camofoxPort?: number
    launchCmd?: string
    env?: Record<string, string>
    timeoutMs?: number
    /** Opt-in non-blocking cold start: wait only this long for a freshly
     *  spawned service before returning `healthy:false` and converging
     *  in the background. */
    initialWaitMs?: number
    log?: (s: string) => void
    /** Override execution location ("local" or "cloud"). */
    location?: "local" | "cloud"
    /** Base URL of the remote service when location="cloud". */
    baseUrl?: string
    /** Override the binary path for a local spawn. */
    binPath?: string
    /** chrome-live only: "dedicated" (default) or "personal" (attachIntent). Every other adapter ignores this. */
    profile?: "dedicated" | "personal"
    /** chrome-live only: the real Chrome profile directory a configured cookie source should trace injected cookies back to. Every other adapter ignores this. */
    chromeProfile?: string
    /** chrome-live only: narrows which domains' cookies a configured cookie source injects. Every other adapter ignores this. */
    domains?: readonly string[]
  }): Promise<BrowserInstanceLike>
}

export type BrowserAdapterResolver = (id: string) => BrowserAdapterLike | undefined
export type BrowserAdapterLister = () => {
  id: string
  name: string
  description: string
  defaultPort: number
  /** Where this adapter runs — "local" (default) or "cloud". */
  location?: "local" | "cloud"
  /** Install methods — informational metadata from the adapter manifest. */
  install?: unknown[]
  /** Config prompts — informational metadata from the adapter manifest. */
  config?: unknown[]
}[]

/**
 * Family-specific descriptor of one browser adapter (the kit-path lister in
 * browser-adapters.ts). P4b: dead with the adapter lister.
 */
export interface BrowserAdapterInfo {
  id: string
  name: string
  description: string
  defaultPort: number
}

// ── Live chrome-live instances (HTTP routes only) ────────────────────────────

// P4b: dead once the HTTP chrome-live surface goes. No MCP tool reaches this
// map any more; only `POST /sessions/browser` and the screencast routes in
// http-server.ts still read and write it. It lives at module scope because
// those routes and the per-request `/mcp` registration are separate passes.
const liveInstances = new Map<string, BrowserInstanceLike>()

export function setLiveBrowserInstance(
  sessionId: string,
  instance: BrowserInstanceLike
): void {
  liveInstances.set(sessionId, instance)
}

export function getLiveBrowserInstance(
  sessionId: string
): BrowserInstanceLike | undefined {
  return liveInstances.get(sessionId)
}

export function forgetLiveBrowserInstance(sessionId: string): void {
  liveInstances.delete(sessionId)
}


// ── Registration ──────────────────────────────────────────────────────────────

const okResult = (r: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(r) }],
  structuredContent: r,
})

const errResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
})

interface RegisterBrowserToolsOptions {
  /** Imported-MCP registry the browser tools forward through. Unset: every
   *  relayed tool answers an error naming Bureau. */
  mcpProxy?: BrowserProxyCaller
  /** Calling session id of this `/mcp` request, threaded into every Bureau
   *  call so Bureau's tab ownership applies and the imported-call guard can
   *  stamp the subsession token headers. */
  callerSessionId?: string
  /** Resolves the Bureau import alias (tests inject a stub; the default reads
   *  `defaults.browser.proxyImport` at call time, `"bureau"` when unset, so a
   *  `config_set` takes effect on the next tool call). */
  loadProxyImport?: () => Promise<string>
  /** `defaults.browser.builtin` as resolved by the caller's registration
   *  pass: `"off"` registers only `fetch_page`, `"proxy"` (the default)
   *  registers the relayed tools. The tool LIST is fixed at registration
   *  (once per `/mcp` request), so a config change applies on the next MCP
   *  session. */
  builtin?: BrowserBuiltinMode
}

const sessionIdField = z
  .string()
  .optional()
  .describe("Retired daemon browser-session id. Ignored: Bureau identifies the caller session itself.")
const tabIdField = z
  .string()
  .optional()
  .describe("Bureau tab id this session owns (default: the session's own tab, opened on first use).")
const instanceField = z
  .string()
  .optional()
  .describe("Bureau instance id (see list_browsers), forwarded as-is.")

const BUREAU_NOTE = " Forwarded to Bureau (defaults.browser.proxyImport, default `bureau`)."

export function registerBrowserTools(
  rawServer: McpServer,
  opts: RegisterBrowserToolsOptions = {}
): void {
  const server = withBrowserObservers(rawServer)
  const builtin: BrowserBuiltinMode = opts.builtin ?? "proxy"
  const loadProxyImport =
    opts.loadProxyImport ??
    (async () => resolveBrowserProxyImport((await loadConfig()).defaults?.browser))

  /** The Bureau alias plus the registry to reach it, or an error naming Bureau. */
  const bureau = async (
    toolName: string
  ): Promise<{ proxy: BrowserProxyCaller; alias: string } | ReturnType<typeof errResult>> => {
    if (!opts.mcpProxy) {
      return errResult(
        `${toolName}: Bureau is not reachable: the daemon has no imported-MCP registry wired, ` +
          "and the daemon browser tools only forward to Bureau."
      )
    }
    return { proxy: opts.mcpProxy, alias: await loadProxyImport() }
  }

  const caller = opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}

  const relay = (toolName: ProxiedBrowserToolName) => async (input: Record<string, unknown>) => {
    const target = await bureau(toolName)
    if ("isError" in target) return target
    return callProxiedBrowserTool({ ...target, toolName, toolInput: input, ...caller })
  }

  // ── fetch_page ───────────────────────────────────────────────────────────────
  // The only browser-family tool that stays in `"off"` mode: a plain HTTP
  // read, no browser involved.
  server.tool(
    "fetch_page",
    "Read a URL over plain HTTP — no browser, instant. Returns clean text: " +
      "{ title, text (markdown, boilerplate stripped), url (after redirects), blocked }. " +
      "`blocked: true` means the response looks anti-bot-gated (403/429/503, or a " +
      "known challenge page from Cloudflare/Akamai/PerimeterX/Datadome/Incapsula) — " +
      "`text` is omitted in that case; escalate to `browser_navigate` " +
      "+ `browser_extract_text` (or `browser_click`/`browser_fill`/`browser_scroll` if the " +
      "page needs interaction first) instead of retrying the same fetch. Try this FIRST for " +
      "any public page — instant, no browser — and only reach for the browser tools when " +
      "`blocked: true` or the content needs JS/interaction to appear.",
    {
      url: z.string().min(1).describe("URL to fetch."),
      timeoutMs: z.number().int().positive().max(60_000).optional().describe("Default 15000."),
    },
    async input => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? 15_000)
      try {
        const res = await fetch(input.url, { signal: ac.signal, redirect: "follow" })
        const html = await res.text()
        if (looksBlocked(res.status, html)) {
          return okResult({ url: res.url, blocked: true, status: res.status })
        }
        if (!res.ok) return errResult(`fetch_page: HTTP ${res.status} fetching ${input.url}`)
        const { title, text } = await extractPageText(html, res.url)
        return okResult({ title, text, url: res.url, blocked: false })
      } catch (err) {
        return errResult(`fetch_page: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(timer)
      }
    }
  )

  // `"off"`: no browser tool at all beyond the plain HTTP read above.
  if (builtin === "off") return

  // ── list_browsers ────────────────────────────────────────────────────────────
  server.tool(
    "list_browsers",
    "List the browser instances Bureau can drive (Bureau's browser_list_instances)." + BUREAU_NOTE,
    {
      onlyAlive: z
        .boolean()
        .optional()
        .describe("Retired daemon filter. Dropped (listed in `notes`): Bureau lists instances, not sessions."),
      instance: instanceField,
    },
    relay("list_browsers")
  )

  // ── browser_navigate ─────────────────────────────────────────────────────────
  server.tool(
    "browser_navigate",
    "Navigate this session's own Bureau tab to `url` (Bureau opens it on first use; " +
      "never a tab another session owns). Follow with `browser_extract_text`/`browser_get_dom` " +
      "to read the page, `browser_click`/`browser_fill`/`browser_scroll` to interact, or " +
      "`browser_screenshot` to see it." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      url: z.string().min(1).describe("URL to navigate to."),
      tabId: tabIdField,
      instance: instanceField,
    },
    relay("browser_navigate")
  )

  // ── browser_screenshot ───────────────────────────────────────────────────────
  server.tool(
    "browser_screenshot",
    "Capture a screenshot of this session's own Bureau tab; returns Bureau's result " +
      "(base64 image and its format)." + BUREAU_NOTE,
    { sessionId: sessionIdField, tabId: tabIdField, instance: instanceField },
    relay("browser_screenshot")
  )

  // ── browser_extract_text ─────────────────────────────────────────────────────
  server.tool(
    "browser_extract_text",
    "Read this session's own Bureau tab as clean text: strips boilerplate (nav/ads/scripts) " +
      "and returns { title, text (markdown), url }. Reads the DOM through Bureau's " +
      "browser_get_dom and purifies it on the daemon (the `fetch_page` extractor). Call " +
      "`browser_navigate` first. Prefer this over `browser_get_dom` unless you need raw HTML " +
      "(e.g. to find a CSS selector for `browser_click`/`browser_fill`)." + BUREAU_NOTE,
    { sessionId: sessionIdField, tabId: tabIdField, instance: instanceField },
    async input => {
      const target = await bureau("browser_extract_text")
      if ("isError" in target) return target
      return callBureauExtractText({ ...target, toolInput: input, ...caller })
    }
  )

  // ── browser_get_dom ───────────────────────────────────────────────────────────
  server.tool(
    "browser_get_dom",
    "Read this session's own Bureau tab as RAW serialized DOM (outerHTML). Use " +
      "`browser_extract_text` to read content; reach for this when you need exact markup " +
      "(e.g. to find a CSS selector for `browser_click`/`browser_fill`)." + BUREAU_NOTE,
    { sessionId: sessionIdField, tabId: tabIdField, instance: instanceField },
    relay("browser_get_dom")
  )

  // ── browser_click ──────────────────────────────────────────────────────────────
  server.tool(
    "browser_click",
    "Click a CSS selector on this session's own Bureau tab. Find a selector with " +
      "`browser_get_dom` if you don't already know one." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: tabIdField,
      instance: instanceField,
      selector: z.string().min(1).describe("CSS selector of the element to click."),
      button: z.enum(["left", "middle", "right"]).optional().describe("Default left."),
      clickCount: z.number().int().min(1).max(3).optional().describe("Default 1 (2 for a double-click)."),
    },
    relay("browser_click")
  )

  // ── browser_fill ───────────────────────────────────────────────────────────────
  server.tool(
    "browser_fill",
    "Fill a CSS selector on this session's own Bureau tab with `value` (clearing the " +
      "existing value first by default)." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: tabIdField,
      instance: instanceField,
      selector: z.string().min(1).describe("CSS selector of the input/textarea element."),
      value: z.string().describe("Text to type."),
      clear: z.boolean().optional().describe("Clear the existing value first. Default true."),
    },
    relay("browser_fill")
  )

  // ── browser_evaluate ───────────────────────────────────────────────────────────
  server.tool(
    "browser_evaluate",
    "Run a JavaScript expression on this session's own Bureau tab and return its value." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: tabIdField,
      instance: instanceField,
      expression: z.string().min(1).describe("JavaScript expression to evaluate."),
      awaitPromise: z.boolean().optional().describe("Await the expression if it returns a promise. Default true."),
      returnByValue: z.boolean().optional().describe("Serialize the result by value. Default true."),
      maxResultBytes: z.number().int().positive().optional().describe("Cap on the serialized result size."),
    },
    relay("browser_evaluate")
  )

  // ── browser_scroll ─────────────────────────────────────────────────────────────
  server.tool(
    "browser_scroll",
    "Scroll this session's own Bureau tab: pass `selector` to scroll that element into view " +
      "(centered), or `x`/`y` to scroll the window BY that many CSS px (relative). Runs a fixed " +
      "daemon-built script through Bureau's browser_evaluate; it never runs caller code." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: tabIdField,
      instance: instanceField,
      selector: z.string().optional().describe("CSS selector to scroll into view. Takes precedence over x/y."),
      x: z.number().finite().optional().describe("Horizontal scroll delta in CSS px. Default 0. Ignored if `selector` is set."),
      y: z.number().finite().optional().describe("Vertical scroll delta in CSS px. Default 0. Ignored if `selector` is set."),
    },
    async input => {
      const target = await bureau("browser_scroll")
      if ("isError" in target) return target
      return callBureauScroll({ ...target, toolInput: input, ...caller })
    }
  )

  // ── browser_press_key ──────────────────────────────────────────────────────────
  server.tool(
    "browser_press_key",
    "Press one key on this session's own Bureau tab: Enter, Tab, Escape, Backspace, Delete, " +
      "ArrowUp/Down/Left/Right, Home, End, PageUp/PageDown, Space, or a single printable " +
      "character. Optionally focus a `selector` first, repeat with `count`, and hold `modifiers`." +
      BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: tabIdField,
      instance: instanceField,
      key: z.string().min(1).describe("Key name (Enter, Tab, Escape, ArrowDown, …) or one printable character."),
      selector: z.string().optional().describe("CSS selector to focus before pressing. Default: whatever has focus."),
      count: z.number().int().min(1).max(100).optional().describe("How many times to press. Default 1."),
      modifiers: z
        .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
        .optional()
        .describe("Modifier keys held for this press."),
    },
    relay("browser_press_key")
  )

  // ── browser_list_tabs ───────────────────────────────────────────────────────
  server.tool(
    "browser_list_tabs",
    "List the Bureau tabs this session owns (Bureau's browser_list_owned_tabs): the ids every " +
      "other browser tool accepts as `tabId`." + BUREAU_NOTE,
    { sessionId: sessionIdField, instance: instanceField },
    relay("browser_list_tabs")
  )

  // ── browser_screencast_* ─────────────────────────────────────────────────────
  server.tool(
    "browser_screencast_start",
    "Start recording this session's own Bureau tab (Bureau's browser_record_start). Pass the " +
      "owned `tabId` (Bureau requires it), optionally `instance`, `fps` and `format`; `quality`, " +
      "`everyNthFrame`, `maxWidth` and `maxHeight` are dropped and listed in `notes`. " +
      "`browser_screencast_frame` grabs the latest frame; `browser_screencast_stop` ends the " +
      "recording and returns Bureau's result." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      everyNthFrame: z.number().int().min(1).optional(),
      maxWidth: z.number().int().min(1).optional(),
      maxHeight: z.number().int().min(1).optional(),
      tabId: z.string().optional().describe("Owned tab to record. Bureau requires it."),
      instance: instanceField,
      fps: z.number().optional().describe("Frames per second Bureau keeps (default 3, clamped to [1, 10])."),
    },
    relay("browser_screencast_start")
  )

  server.tool(
    "browser_screencast_frame",
    "Return the latest recorded frame of this session's own Bureau tab (Bureau's " +
      "browser_record_frame). Pass the owned `tabId`." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: z.string().optional().describe("Owned tab being recorded. Bureau requires it."),
      instance: instanceField,
    },
    relay("browser_screencast_frame")
  )

  server.tool(
    "browser_screencast_stop",
    "Stop the recording started with `browser_screencast_start` (Bureau's browser_record_stop). " +
      "Pass the owned `tabId`, optionally `instance` and `encode`; returns Bureau's result." + BUREAU_NOTE,
    {
      sessionId: sessionIdField,
      tabId: z.string().optional().describe("Owned tab being recorded. Bureau requires it."),
      instance: instanceField,
      encode: z.boolean().optional().describe("Encode the frames into video.mp4 (default true)."),
    },
    relay("browser_screencast_stop")
  )
}
