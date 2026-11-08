/**
 * The bridge from the daemon's `browser_*` tools to Bureau, the local browser
 * service imported as an MCP. `defaults.browser.builtin` decides what the
 * daemon registers:
 *
 *   - `"off"`   only `fetch_page` (a plain HTTP read); no browser tool at all.
 *   - `"proxy"` (the default) the daemon browser tools forward to Bureau.
 *
 * A legacy `"on"` (the retired chrome-live path) is read as `"proxy"` with a
 * one-line warning, never refused, so an old config file still boots.
 * `defaults.browser.proxyImport` names the imported MCP alias and defaults
 * to `"bureau"`. When that import is absent, every relayed tool answers an
 * error naming Bureau.
 *
 * Two tools are relays adapted on the daemon side, since Bureau has no twin:
 * `browser_extract_text` reads Bureau's `browser_get_dom` and runs the
 * daemon's own `extractPageText`, and `browser_scroll` sends Bureau's
 * `browser_evaluate` a FIXED script built here (the selector rides in as
 * JSON data, never as code).
 *
 * The argument shapes below are copied from Bureau's tool catalogue, not from
 * this file's own schemas. Since agentproto/bureau#41 every Bureau page tool
 * takes `tabId` and an optional `instance`, so both are forwarded as-is.
 * `sessionId` is the retired daemon browser-session selector and is consumed
 * here without being forwarded (the result notes it was ignored). A daemon
 * field Bureau has no twin for is dropped and listed in the result's `notes`
 * (`browser_screencast_start` drops `quality`, `everyNthFrame`, `maxWidth` and
 * `maxHeight`; Bureau's recorder is driven by `fps` and `format`).
 *
 * Every successful proxied result carries the `deprecated` marker in `_meta`
 * (never in a `structuredContent` the upstream did not send); a Bureau tool error
 * is returned unchanged (a caller relies on its own code, e.g.
 * `browser:not_owner`).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ProxyCallContext, ProxyCallOutcome } from "./mcp-proxy.js"
import { extractPageText } from "./page-text.js"

export const BROWSER_PROXY_DEPRECATED =
  "Answered by Bureau through the daemon's deprecated browser_* proxy. " +
  "Prefer calling Bureau's own tools (bureau MCP or the Bureau app's exposed tools)."

/** The `_meta` key carrying the deprecation marker on a proxied result. */
export const BROWSER_PROXY_META_KEY = "agentproto/deprecated"

/** How much of the built-in browser surface the daemon registers. */
export type BrowserBuiltinMode = "off" | "proxy"

/** The imported MCP alias the tools forward to when `proxyImport` is unset. */
export const DEFAULT_BROWSER_PROXY_IMPORT = "bureau"

/** The one-line warning a legacy `builtin: "on"` produces. */
export const LEGACY_BUILTIN_ON_WARNING =
  'defaults.browser.builtin "on" is retired and read as "proxy": the daemon browser tools forward to Bureau. ' +
  'Set it to "proxy" or "off" to silence this warning.'

let warnedLegacyOn = false

function warnLegacyOnOnce(message: string): void {
  if (warnedLegacyOn) return
  warnedLegacyOn = true
  console.warn(`[browser] ${message}`)
}

/**
 * Resolve `defaults.browser.builtin`. Only an explicit `"off"` turns the
 * browser surface off; anything else is `"proxy"`. A legacy `"on"` is read
 * as `"proxy"` and reported through `warn` (by default once per process on
 * the daemon log, since this runs once per `/mcp` session).
 */
export function resolveBrowserBuiltin(
  browser: { builtin?: string | undefined } | undefined,
  warn: (message: string) => void = warnLegacyOnOnce,
): BrowserBuiltinMode {
  if (browser?.builtin === "off") return "off"
  if (browser?.builtin === "on") warn(LEGACY_BUILTIN_ON_WARNING)
  return "proxy"
}

/** Resolve `defaults.browser.proxyImport`, `"bureau"` when unset. */
export function resolveBrowserProxyImport(
  browser: { proxyImport?: string | undefined } | undefined,
): string {
  return browser?.proxyImport || DEFAULT_BROWSER_PROXY_IMPORT
}

/** The daemon browser tools this proxy covers. */
export type ProxiedBrowserToolName =
  | "browser_navigate"
  | "browser_click"
  | "browser_fill"
  | "browser_evaluate"
  | "browser_get_dom"
  | "browser_screenshot"
  | "browser_press_key"
  | "browser_list_tabs"
  | "browser_screencast_start"
  | "browser_screencast_frame"
  | "browser_screencast_stop"
  | "list_browsers"

interface BrowserToolMapping {
  /** The Bureau tool this daemon tool maps to. */
  target: string
  /** Daemon input fields forwarded to the Bureau tool under the same name. */
  forward: readonly string[]
  /** Daemon input fields consumed here: never forwarded, never reported. */
  consumed: readonly string[]
  /** Daemon input fields with no Bureau equivalent: dropped and noted. */
  dropped: readonly string[]
  /** Extra notes carried on a successful proxied result. */
  extraNotes?: readonly string[]
}

/**
 * Copy of Bureau's input schemas, reduced to the fields the daemon's own
 * schemas can carry:
 *   browser_navigate   { url, tabId?, instance?, waitUntil?, timeoutMs?, session? } → url/tabId/instance
 *   browser_click      { selector, tabId?, instance?, button?, clickCount?, trusted? }
 *   browser_fill       { selector, value, tabId?, instance?, clear? }
 *   browser_evaluate   { expression, tabId?, instance?, awaitPromise?, returnByValue?, maxResultBytes?, session? }
 *   browser_get_dom    { tabId?, instance?, selector?, path? }
 *   browser_screenshot { tabId?, instance?, format?, quality?, fullPage?, selector?, path?, session? }
 *   browser_press_key  { key, tabId?, instance?, selector?, count?, modifiers? }
 *   browser_list_owned_tabs  { instance? }
 *   browser_record_start  { tabId, instance?, fps?, format? }
 *   browser_record_frame  { tabId, instance? }
 *   browser_record_stop   { tabId, instance?, encode? }
 *   browser_list_instances   { instance? }
 */
const MAPPINGS: Record<ProxiedBrowserToolName, BrowserToolMapping> = {
  browser_navigate: {
    target: "browser_navigate",
    forward: ["url", "tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_click: {
    target: "browser_click",
    forward: ["selector", "button", "clickCount", "tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_fill: {
    target: "browser_fill",
    forward: ["selector", "value", "clear", "tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_evaluate: {
    target: "browser_evaluate",
    forward: [
      "expression",
      "awaitPromise",
      "returnByValue",
      "maxResultBytes",
      "tabId",
      "instance",
    ],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_get_dom: {
    target: "browser_get_dom",
    forward: ["tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_screenshot: {
    target: "browser_screenshot",
    forward: ["tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_press_key: {
    target: "browser_press_key",
    forward: ["key", "selector", "count", "modifiers", "tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_list_tabs: {
    target: "browser_list_owned_tabs",
    forward: ["instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_screencast_start: {
    target: "browser_record_start",
    forward: ["tabId", "instance", "fps", "format"],
    consumed: ["sessionId"],
    dropped: ["quality", "everyNthFrame", "maxWidth", "maxHeight"],
  },
  browser_screencast_frame: {
    target: "browser_record_frame",
    forward: ["tabId", "instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
  browser_screencast_stop: {
    target: "browser_record_stop",
    forward: ["tabId", "instance", "encode"],
    consumed: ["sessionId"],
    dropped: [],
  },
  list_browsers: {
    target: "browser_list_instances",
    forward: ["instance"],
    consumed: [],
    dropped: ["onlyAlive"],
    extraNotes: [
      "Bureau browser_list_instances returns instances, not the daemon's browser-session descriptors",
    ],
  },
}

export function isProxiedBrowserTool(name: string): name is ProxiedBrowserToolName {
  return Object.prototype.hasOwnProperty.call(MAPPINGS, name)
}

/** The Bureau tool a daemon tool maps to. */
export function bureauToolName(toolName: ProxiedBrowserToolName): string {
  return MAPPINGS[toolName].target
}

/** Map one daemon tool input to the Bureau argument object + drop notes. */
export function mapBrowserProxyArgs(
  toolName: ProxiedBrowserToolName,
  input: Record<string, unknown>,
): { args: Record<string, unknown>; notes: string[] } {
  const mapping = MAPPINGS[toolName]
  const args: Record<string, unknown> = {}
  for (const key of mapping.forward) {
    if (input[key] !== undefined) args[key] = input[key]
  }
  const notes = [
    ...(mapping.extraNotes ?? []),
    ...mapping.dropped
      .filter(key => input[key] !== undefined)
      .map(key => `dropped "${key}" (no Bureau equivalent)`),
    // The daemon's browser-session selector means nothing to Bureau, which
    // identifies the caller session itself: say so instead of ignoring it.
    ...mapping.consumed
      .filter(key => input[key] !== undefined)
      .map(key => `ignored "${key}": Bureau identifies the caller session itself`),
  ]
  return { args, notes }
}

/** Minimal structural view of `McpProxyRegistry` - lets tests pass a double. */
export interface BrowserProxyCaller {
  callTool(
    alias: string,
    toolName: string,
    args: unknown,
    context?: ProxyCallContext,
  ): Promise<ProxyCallOutcome>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Mark a successful upstream result as proxied without hiding it. The marker
 * always rides in `_meta`. When upstream answered with `structuredContent` it
 * is merged there too; otherwise no `structuredContent` is created (a client
 * that reads it first would show only the marker) and the notice is a trailing
 * text block after the untouched upstream `content`.
 */
function markDeprecated(result: unknown, notes: readonly string[]): Record<string, unknown> {
  const base = isRecord(result) ? result : {}
  const marker: Record<string, unknown> = {
    deprecated: BROWSER_PROXY_DEPRECATED,
    ...(notes.length > 0 ? { notes: [...notes] } : {}),
  }
  const meta = { ...(isRecord(base._meta) ? base._meta : {}), [BROWSER_PROXY_META_KEY]: marker }
  if (isRecord(base.structuredContent)) {
    return { ...base, _meta: meta, structuredContent: { ...base.structuredContent, ...marker } }
  }
  const content = Array.isArray(base.content) ? base.content : []
  const notice = [BROWSER_PROXY_DEPRECATED, ...notes.map(n => `note: ${n}`)].join("\n")
  return { ...base, _meta: meta, content: [...content, { type: "text", text: notice }] }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

/** The error a relayed tool answers when the Bureau import cannot serve it. */
export function bureauUnavailableMessage(toolName: string, alias: string, error: string): string {
  if (error.startsWith("unknown alias")) {
    return (
      `${toolName}: Bureau is not imported: no imported MCP is named "${alias}" ` +
      "(defaults.browser.proxyImport). The daemon browser tools only forward to Bureau: " +
      `import the Bureau MCP under "${alias}" (mcp_import) or point defaults.browser.proxyImport at its alias.`
    )
  }
  return `${toolName}: Bureau (imported MCP "${alias}") is unavailable: ${error}`
}

type BureauCall =
  | { ok: true; result: unknown }
  | { ok: false; error: CallToolResult }

/**
 * Call one Bureau tool on behalf of a daemon tool. A transport failure (no
 * import, not connected) becomes an error naming Bureau; a Bureau tool error
 * is handed back unchanged as `error`.
 */
async function callBureau(input: {
  proxy: BrowserProxyCaller
  alias: string
  toolName: string
  target: string
  args: Record<string, unknown>
  callerSessionId?: string | undefined
}): Promise<BureauCall> {
  const outcome = await input.proxy.callTool(
    input.alias,
    input.target,
    input.args,
    input.callerSessionId ? { callerSessionId: input.callerSessionId } : undefined,
  )
  if (!outcome.ok) {
    return { ok: false, error: errorResult(bureauUnavailableMessage(input.toolName, input.alias, outcome.error)) }
  }
  // A Bureau tool error is the caller's evidence (browser:not_owner,
  // browser:awaiting_consent, ...): return it exactly as received.
  if (isRecord(outcome.result) && outcome.result.isError === true) {
    return { ok: false, error: outcome.result as CallToolResult }
  }
  return { ok: true, result: outcome.result }
}

/** Call the Bureau tool and return an MCP tool result for the daemon tool. */
export async function callProxiedBrowserTool(input: {
  proxy: BrowserProxyCaller
  alias: string
  toolName: ProxiedBrowserToolName
  toolInput: Record<string, unknown>
  callerSessionId?: string
}): Promise<CallToolResult> {
  const { args, notes } = mapBrowserProxyArgs(input.toolName, input.toolInput)
  const call = await callBureau({
    proxy: input.proxy,
    alias: input.alias,
    toolName: input.toolName,
    target: bureauToolName(input.toolName),
    args,
    callerSessionId: input.callerSessionId,
  })
  if (!call.ok) return call.error
  return markDeprecated(call.result, notes) as CallToolResult
}

/** The `tabId`/`instance` pair every Bureau page tool takes. */
function pageTarget(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof input.tabId === "string") out.tabId = input.tabId
  if (typeof input.instance === "string") out.instance = input.instance
  return out
}

/**
 * One field of a Bureau tool result: `structuredContent` first, else the
 * first text block parsed as JSON.
 */
function resultField(result: unknown, key: string): unknown {
  if (!isRecord(result)) return undefined
  if (isRecord(result.structuredContent) && key in result.structuredContent) {
    return result.structuredContent[key]
  }
  const content = Array.isArray(result.content) ? result.content : []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isRecord(parsed) && key in parsed) return parsed[key]
    } catch {
      // Not JSON: try the next block.
    }
  }
  return undefined
}

function okResult(value: Record<string, unknown>, notes: readonly string[]): CallToolResult {
  return markDeprecated(
    { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    notes,
  ) as CallToolResult
}

function sessionIdNotes(input: Record<string, unknown>): string[] {
  return input.sessionId !== undefined
    ? ['ignored "sessionId": Bureau identifies the caller session itself']
    : []
}

/**
 * `browser_extract_text`: read the tab's DOM through Bureau's
 * `browser_get_dom`, then purify it with the daemon's `extractPageText` (the
 * same extractor `fetch_page` uses). The page URL comes from a second, fixed
 * `location.href` read and is best-effort.
 */
export async function callBureauExtractText(input: {
  proxy: BrowserProxyCaller
  alias: string
  toolInput: Record<string, unknown>
  callerSessionId?: string
}): Promise<CallToolResult> {
  const toolName = "browser_extract_text"
  const target = pageTarget(input.toolInput)
  const dom = await callBureau({
    proxy: input.proxy,
    alias: input.alias,
    toolName,
    target: "browser_get_dom",
    args: target,
    callerSessionId: input.callerSessionId,
  })
  if (!dom.ok) return dom.error
  const html = resultField(dom.result, "html")
  if (typeof html !== "string") {
    return errorResult(`${toolName}: Bureau browser_get_dom returned no html`)
  }
  const location = await callBureau({
    proxy: input.proxy,
    alias: input.alias,
    toolName,
    target: "browser_evaluate",
    args: { ...target, expression: "location.href", returnByValue: true },
    callerSessionId: input.callerSessionId,
  })
  const href = location.ok ? resultField(location.result, "value") : undefined
  const url = typeof href === "string" ? href : ""
  try {
    const { title, text } = await extractPageText(html, url || "about:blank")
    return okResult({ title, text, url }, sessionIdNotes(input.toolInput))
  } catch (err) {
    return errorResult(`${toolName}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The fixed `browser_scroll` script. Its only variable part is one JSON
 * literal of data: a selector is a JSON string, x/y are finite numbers, and
 * nothing a caller sends is ever spliced in as code.
 */
export function buildScrollExpression(input: { selector?: string; x?: number; y?: number }): string {
  const finite = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0)
  const data =
    typeof input.selector === "string"
      ? { selector: input.selector }
      : { x: finite(input.x), y: finite(input.y) }
  return (
    "(() => {" +
    ` const a = ${JSON.stringify(data)};` +
    ' if (typeof a.selector === "string") {' +
    " const el = document.querySelector(a.selector);" +
    ' if (!el) throw new Error("browser_scroll: no element matches selector " + JSON.stringify(a.selector));' +
    ' el.scrollIntoView({ block: "center", inline: "center" });' +
    " } else {" +
    " window.scrollBy(a.x, a.y);" +
    " }" +
    " return { scrollX: window.scrollX, scrollY: window.scrollY };" +
    " })()"
  )
}

/**
 * `browser_scroll`: Bureau's `browser_evaluate` with the fixed script from
 * `buildScrollExpression`. No caller-supplied expression reaches Bureau.
 */
export async function callBureauScroll(input: {
  proxy: BrowserProxyCaller
  alias: string
  toolInput: Record<string, unknown>
  callerSessionId?: string
}): Promise<CallToolResult> {
  const t = input.toolInput
  const call = await callBureau({
    proxy: input.proxy,
    alias: input.alias,
    toolName: "browser_scroll",
    target: "browser_evaluate",
    args: {
      ...pageTarget(t),
      expression: buildScrollExpression({
        ...(typeof t.selector === "string" ? { selector: t.selector } : {}),
        ...(typeof t.x === "number" ? { x: t.x } : {}),
        ...(typeof t.y === "number" ? { y: t.y } : {}),
      }),
      awaitPromise: false,
      returnByValue: true,
    },
    callerSessionId: input.callerSessionId,
  })
  if (!call.ok) return call.error
  return markDeprecated(call.result, sessionIdNotes(t)) as CallToolResult
}
