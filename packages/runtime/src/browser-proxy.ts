/**
 * One-version bridge from the daemon's `browser_*` tools to a Bureau MCP
 * import. When `defaults.browser.proxyImport` names an imported MCP alias
 * that serves the Browser Fabric tools, `browser-tools.ts` forwards the six
 * tools below to the Bureau tool of the same name instead of running the
 * daemon's own adapter path.
 *
 * The argument shapes are copied from Bureau's tool catalogue, not from this
 * file's own schemas: a daemon input the Bureau tool has no field for (for
 * example a chrome-live `tabId`) is dropped and named in the result's
 * `notes`. `sessionId` is the daemon's own browser-session selector and is
 * consumed here without being forwarded or reported.
 *
 * Every successful proxied result carries `deprecated`; a Bureau tool error
 * is returned unchanged (a caller relies on its own code, e.g.
 * `browser:not_owner`).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ProxyCallContext, ProxyCallOutcome } from "./mcp-proxy.js"

export const BROWSER_PROXY_DEPRECATED =
  "The daemon browser_* tools proxy to Bureau for one version; mount the Bureau MCP and call its tools directly."

/** The only daemon browser tools this one-version proxy covers. */
export type ProxiedBrowserToolName =
  | "browser_navigate"
  | "browser_click"
  | "browser_fill"
  | "browser_evaluate"
  | "browser_get_dom"
  | "browser_screenshot"

interface BrowserToolMapping {
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
 *   browser_navigate   { url, waitUntil?, timeoutMs?, session? }        → url
 *   browser_click      { selector, button?, clickCount?, trusted? }     → selector/button/clickCount
 *   browser_fill       { selector, value, clear? }                      → selector/value/clear
 *   browser_evaluate   { expression, awaitPromise?, returnByValue?, maxResultBytes?, session? }
 *   browser_get_dom    { selector?, path? }                             → (nothing the daemon carries)
 *   browser_screenshot { format?, quality?, fullPage?, selector?, path?, session? } → (nothing)
 */
const MAPPINGS: Record<ProxiedBrowserToolName, BrowserToolMapping> = {
  browser_navigate: {
    forward: ["url"],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
  browser_click: {
    forward: ["selector", "button", "clickCount"],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
  browser_fill: {
    forward: ["selector", "value", "clear"],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
  browser_evaluate: {
    forward: ["expression", "awaitPromise", "returnByValue", "maxResultBytes"],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
  browser_get_dom: {
    forward: [],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
  browser_screenshot: {
    forward: [],
    consumed: ["sessionId"],
    dropped: ["tabId"],
  },
}

export function isProxiedBrowserTool(name: string): name is ProxiedBrowserToolName {
  return Object.prototype.hasOwnProperty.call(MAPPINGS, name)
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
  const notes = mapping.dropped
    .filter(key => input[key] !== undefined)
    .map(key => `dropped "${key}" (no Bureau equivalent)`)
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
    input.toolName,
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
