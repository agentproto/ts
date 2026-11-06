/**
 * One-version bridge from the daemon's `browser_*` tools to a Bureau MCP
 * import. `defaults.browser.builtin` decides what the daemon registers:
 *
 *   - `"off"`   only `fetch_page` (a plain HTTP read); no browser tool at all.
 *   - `"proxy"` the daemon browser tools forward to Bureau; a tool Bureau has
 *               no twin for refuses with `browser:use_bureau` instead of
 *               falling back to the daemon's own chrome-live path.
 *   - `"on"`    today's behaviour (the default).
 *
 * A config that only names `defaults.browser.proxyImport` (no `builtin`)
 * resolves to `"on"`, so existing installs keep exactly their old behaviour:
 * the six legacy tools proxy and every other tool keeps its local path.
 * `"proxy"` is opt-in through `builtin: "proxy"`.
 *
 * The argument shapes below are copied from Bureau's tool catalogue, not from
 * this file's own schemas. Since agentproto/bureau#41 every Bureau page tool
 * takes `tabId` and an optional `instance`, so both are forwarded as-is.
 * `sessionId` is the daemon's own browser-session selector and is consumed
 * here without being forwarded or reported. Nothing else is dropped.
 *
 * Every successful proxied result carries `deprecated`; a Bureau tool error
 * is returned unchanged (a caller relies on its own code, e.g.
 * `browser:not_owner`).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ProxyCallContext, ProxyCallOutcome } from "./mcp-proxy.js"

export const BROWSER_PROXY_DEPRECATED =
  "The daemon browser_* tools proxy to Bureau; \"off\" (defaults.browser.builtin) is the end state: mount the Bureau MCP and call its tools directly."

/** How much of the built-in browser surface the daemon registers. */
export type BrowserBuiltinMode = "off" | "proxy" | "on"

/**
 * Resolve `defaults.browser.builtin`. Backward compatibility wins: a config
 * that only sets `proxyImport` keeps today's `"on"` behaviour (the six legacy
 * tools proxy, everything else keeps its local path), and an absent value is
 * `"on"` too. `"proxy"` is opt-in through an explicit `builtin: "proxy"`.
 * Unknown values are treated as `"on"` rather than silently disabling a
 * browser tool surface.
 */
export function resolveBrowserBuiltin(
  browser:
    | { builtin?: string | undefined; proxyImport?: string | undefined }
    | undefined,
): BrowserBuiltinMode {
  if (browser?.builtin === "off" || browser?.builtin === "proxy" || browser?.builtin === "on") {
    return browser.builtin
  }
  return "on"
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
  | "list_browsers"
  | "browser_status"

interface BrowserToolMapping {
  /** The Bureau tool this daemon tool maps to. */
  target: string
  /** Daemon input fields forwarded to the Bureau tool under the same name. */
  forward: readonly string[]
  /** Daemon input fields consumed here: never forwarded, never reported. */
  consumed: readonly string[]
  /** Daemon input fields with no Bureau equivalent: dropped and noted. */
  dropped: readonly string[]
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
  list_browsers: {
    target: "browser_list_instances",
    forward: ["instance"],
    consumed: [],
    dropped: ["onlyAlive"],
  },
  browser_status: {
    target: "browser_list_instances",
    forward: ["instance"],
    consumed: ["sessionId"],
    dropped: [],
  },
}

export function isProxiedBrowserTool(name: string): name is ProxiedBrowserToolName {
  return Object.prototype.hasOwnProperty.call(MAPPINGS, name)
}

/** The Bureau tool a daemon tool maps to. */
export function bureauToolName(toolName: ProxiedBrowserToolName): string {
  return MAPPINGS[toolName].target
}

/**
 * Daemon browser tools Bureau has no twin for, mapped to the Bureau tool a
 * caller should use instead. In `"proxy"` mode these refuse with
 * `browser:use_bureau` rather than falling back to the daemon's chrome-live
 * path.
 */
export const BROWSER_USE_BUREAU: Readonly<Record<string, string>> = {
  browser_adapter_list: "browser_list_instances",
  browser_extract_text: "browser_evaluate",
  browser_new_tab: "browser_navigate",
  browser_scroll: "browser_evaluate",
  browser_select: "browser_evaluate",
  browser_screencast_frame: "browser_screenshot",
  browser_screencast_start: "browser_screenshot",
  browser_screencast_stop: "browser_screenshot",
  browser_upload_file: "browser_act",
  browser_wait_for: "browser_evaluate",
  start_browser: "browser_list_instances",
  stop_browser: "browser_close_tab",
}

export function isBureauOnlyTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BROWSER_USE_BUREAU, name)
}

/** The `browser:use_bureau` message for a tool with no Bureau twin. */
export function browserUseBureauMessage(toolName: string): string {
  const target = BROWSER_USE_BUREAU[toolName] ?? "browser_list_instances"
  return (
    `browser:use_bureau: ${toolName} is not proxied to Bureau; ` +
    `call Bureau's ${target} instead.`
  )
}

/** The `browser:use_bureau` refusal for a tool with no Bureau twin. */
export function browserUseBureauResult(toolName: string): CallToolResult {
  return {
    content: [{ type: "text", text: browserUseBureauMessage(toolName) }],
    isError: true,
  }
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
 * Mark a successful upstream result as proxied. The marker rides on the
 * top level and on `structuredContent` (what a modern client reads); the
 * original `content` blocks are preserved.
 */
function markDeprecated(result: unknown, notes: readonly string[]): Record<string, unknown> {
  const base = isRecord(result) ? result : {}
  const marker: Record<string, unknown> = {
    deprecated: BROWSER_PROXY_DEPRECATED,
    ...(notes.length > 0 ? { notes: [...notes] } : {}),
  }
  return {
    ...base,
    ...marker,
    ...(isRecord(base.structuredContent)
      ? { structuredContent: { ...base.structuredContent, ...marker } }
      : { structuredContent: marker }),
  }
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
  const outcome = await input.proxy.callTool(
    input.alias,
    bureauToolName(input.toolName),
    args,
    input.callerSessionId ? { callerSessionId: input.callerSessionId } : undefined,
  )
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: `${input.toolName}: ${outcome.error}` }],
      isError: true,
    }
  }
  // A Bureau tool error is the caller's evidence (browser:not_owner,
  // browser:awaiting_consent, …): return it exactly as received.
  if (isRecord(outcome.result) && outcome.result.isError === true) {
    return outcome.result as CallToolResult
  }
  return markDeprecated(outcome.result, notes) as CallToolResult
}
