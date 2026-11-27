/**
 * Browser DOM adapter for {@link createMcpAppHost}: mounts an MCP App's
 * `ui://` html in an iframe and speaks the protocol to it over ext-apps'
 * message protocol.
 *
 * Two isolation modes:
 *
 * - **Sandbox origin** (MCP Apps spec, "Rendering the MCP App"): the view is
 *   served as a document by a server the host controls, on an origin that
 *   differs from the host's, with its CSP as an HTTP header, and the iframe
 *   carries `allow-scripts allow-same-origin`. The origin boundary — not an
 *   opaque origin — is what keeps the view away from the host's DOM, storage
 *   and cookies. Resolved by a {@link McpAppSandboxResolver} (by default the
 *   embedding daemon's `POST /mcp-app-sandbox/views`).
 * - **Restricted** (fallback when no sandbox origin is available): an
 *   opaque-origin `srcdoc` iframe (`sandbox` without `allow-same-origin`)
 *   with the CSP as a `<meta>`. Safe, but views that need a real origin
 *   (IndexedDB, emulators, OAuth callbacks) cannot run. Logged as
 *   "restricted mode".
 *
 * `buildCspPolicy` / `buildCspMeta` / `injectCsp` are pure string functions,
 * usable (and tested) without a DOM.
 */

import {
  buildAllowAttribute,
  type McpUiResourcePermissions,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"

import { createMcpAppHost, type McpAppHost, type McpAppHostOptions } from "./host.js"
import { buildCspPolicy } from "./csp.js"
import type { McpAppUi, McpAppUiCsp } from "./types.js"

export { buildCspPolicy }
export type { McpAppUi, McpAppUiCsp }

/** Restricted mode: never `allow-same-origin`. With it, a srcdoc iframe
 *  shares the host's origin and its scripts could reach straight into the
 *  embedding page. */
export const MCP_APP_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"

/** Sandbox-origin mode: `allow-same-origin` is REQUIRED by the spec and safe
 *  only because the document lives on an origin different from the host's. */
export const MCP_APP_SANDBOX_ORIGIN =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

/** Where a view document was registered for serving. */
export interface McpAppSandboxView {
  /** Absolute URL of the view document. */
  url: string
  /** Its origin (`scheme://host[:port]`); must differ from the host's. */
  origin: string
}

/** Registers a view with the server that owns the sandbox origin. Resolve
 *  `null` when none is available (the view then runs in restricted mode). */
export type McpAppSandboxResolver = (
  ui: Pick<McpAppUi, "html" | "csp" | "permissions">,
) => Promise<McpAppSandboxView | null>

export interface DaemonSandboxResolverOptions {
  /** The daemon's base URL (default: nothing — required). */
  baseUrl: string
  fetch?: typeof fetch
  /** Extra headers (e.g. a bearer) for non-same-origin callers. */
  headers?: Record<string, string>
}

/**
 * Resolver for the daemon's `POST /mcp-app-sandbox/views`. Any failure (older
 * daemon: 404, sandbox disabled: 501, network) resolves `null`.
 */
export function createDaemonSandboxResolver(opts: DaemonSandboxResolverOptions): McpAppSandboxResolver {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const endpoint = new URL("/mcp-app-sandbox/views", opts.baseUrl).toString()
  const hostOrigin = new URL(opts.baseUrl).origin
  return async (ui) => {
    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify({ html: ui.html, csp: ui.csp, permissions: ui.permissions }),
      })
    } catch {
      return null
    }
    if (!res.ok) return null
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return null
    }
    const url = (body as { url?: unknown })?.url
    if (typeof url !== "string") return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    // Never trust the server blindly with the one property that matters: the
    // view must NOT share the host's origin.
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin === hostOrigin) {
      return null
    }
    return { url: parsed.toString(), origin: parsed.origin }
  }
}

function isHttpUrlOnOrigin(view: McpAppSandboxView): boolean {
  try {
    const u = new URL(view.url)
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === view.origin
  } catch {
    return false
  }
}

/** Per-host-origin memo of "no sandbox origin here", so a daemon without the
 *  route is probed once a minute, not once per mounted view. */
const unavailableUntil = new Map<string, number>()
const UNAVAILABLE_TTL_MS = 60_000

function autoResolver(doc: Document): McpAppSandboxResolver | undefined {
  const loc = doc.defaultView?.location
  if (!loc || (loc.protocol !== "http:" && loc.protocol !== "https:")) return undefined
  const inner = createDaemonSandboxResolver({ baseUrl: loc.origin })
  return async (ui) => {
    if ((unavailableUntil.get(loc.origin) ?? 0) > Date.now()) return null
    const view = await inner(ui)
    if (!view) unavailableUntil.set(loc.origin, Date.now() + UNAVAILABLE_TTL_MS)
    return view
  }
}

/**
 * Transport to a view on a known origin. Unlike ext-apps' PostMessageTransport
 * (which posts to `"*"` and only checks `event.source`), outgoing messages are
 * addressed to the sandbox origin — so a view that navigates its frame
 * elsewhere cannot receive tool results — and incoming ones must come from
 * both the iframe's window AND that origin.
 */
export class OriginPinnedTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string
  private listener?: (event: MessageEvent) => void

  constructor(
    private readonly view: Window,
    private readonly origin: string,
    private readonly listenOn: Window,
  ) {}

  async start(): Promise<void> {
    if (this.listener) throw new Error("OriginPinnedTransport already started")
    this.listener = (event) => {
      if (event.source !== this.view || event.origin !== this.origin) return
      const parsed = JSONRPCMessageSchema.safeParse(event.data)
      if (!parsed.success) {
        this.onerror?.(new Error("Invalid JSON-RPC message from view"))
        return
      }
      this.onmessage?.(parsed.data)
    }
    this.listenOn.addEventListener("message", this.listener)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.view.postMessage(message, this.origin)
  }

  async close(): Promise<void> {
    if (this.listener) this.listenOn.removeEventListener("message", this.listener)
    this.listener = undefined
    this.onclose?.()
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/** The `<meta http-equiv="Content-Security-Policy">` tag for a view. */
export function buildCspMeta(csp: McpAppUiCsp | undefined): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildCspPolicy(csp))}">`
}

/**
 * Index just past the end of the tag starting at `from` (`<`), honouring
 * quoted attribute values; -1 when it never closes.
 */
function tagEnd(html: string, from: number): number {
  let quote = ""
  for (let j = from + 1; j < html.length; j++) {
    const c = html[j]
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === ">") return j + 1
  }
  return -1
}

/**
 * Where the CSP meta goes. Only the document PROLOGUE is walked: whitespace,
 * comments, the doctype, the `<html>` start tag and, if it comes next, the
 * `<head>` start tag. Nothing after that is interpreted, so author markup
 * (a `<head>` inside a comment, `<noscript>`, `<template>`, a script string,
 * an unclosed element…) can never decide where the meta lands: it is always
 * placed before any author content.
 */
function cspInsertionPoint(html: string): { at: number; wrapInHead: boolean } {
  let i = 0
  let afterHtml = -1
  let afterDoctype = 0
  const skipSpaceAndComments = (): void => {
    for (;;) {
      while (i < html.length && /\s/.test(html[i] ?? "")) i++
      if (html.startsWith("<!--", i)) {
        const close = html.indexOf("-->", i + 4)
        if (close < 0) return
        i = close + 3
        continue
      }
      return
    }
  }
  skipSpaceAndComments()
  const doctype = /^<!doctype[^>]*>/i.exec(html.slice(i, i + 512))
  if (doctype) {
    i += doctype[0].length
    afterDoctype = i
    skipSpaceAndComments()
  }
  const htmlTag = /^<html(?=[\s/>])/i.exec(html.slice(i, i + 16))
  if (htmlTag) {
    const end = tagEnd(html, i)
    if (end > 0) {
      i = end
      afterHtml = end
      skipSpaceAndComments()
    }
  }
  const headTag = /^<head(?=[\s/>])/i.exec(html.slice(i, i + 16))
  if (headTag) {
    const end = tagEnd(html, i)
    if (end > 0) return { at: end, wrapInHead: false }
  }
  if (afterHtml >= 0) return { at: afterHtml, wrapInHead: true }
  return { at: afterDoctype, wrapInHead: true }
}

/**
 * Inject the CSP meta ahead of any author content (see
 * {@link cspInsertionPoint}): as the first child of `<head>` when the document
 * opens with one, else in a `<head>` created right after `<html>` / the
 * doctype. A CSP meta the view ships itself is left in place: browsers enforce
 * every policy present, so it can only tighten ours.
 */
export function injectCsp(html: string, csp: McpAppUiCsp | undefined): string {
  const meta = buildCspMeta(csp)
  const { at, wrapInHead } = cspInsertionPoint(html)
  return insertAt(html, at, wrapInHead ? `<head>${meta}</head>` : meta)
}

function insertAt(html: string, index: number, fragment: string): string {
  return html.slice(0, index) + fragment + html.slice(index)
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const

/** Narrow a verbatim `_meta.ui.permissions` record to the spec's
 *  `McpUiResourcePermissions` — each permission is an (empty) object when
 *  requested; anything else is ignored. */
export function toResourcePermissions(
  permissions: Record<string, unknown> | undefined,
): McpUiResourcePermissions {
  const out: McpUiResourcePermissions = {}
  if (!permissions) return out
  for (const key of PERMISSION_KEYS) {
    const value = permissions[key]
    if (typeof value === "object" && value !== null) out[key] = {}
  }
  return out
}

export interface MountMcpAppOptions extends McpAppHostOptions {
  container: HTMLElement
  ui: Pick<McpAppUi, "html" | "csp" | "permissions" | "prefersBorder">
  /**
   * How to obtain a dedicated sandbox origin for the view. Omitted ⇒ auto:
   * the embedding page's own daemon (`POST <location.origin>/mcp-app-sandbox/views`)
   * when the page is http(s). `false` ⇒ always restricted mode.
   */
  sandbox?: McpAppSandboxResolver | false
}

export interface MountedMcpApp {
  /** `"sandbox-origin"` (spec) or `"restricted"` (opaque-origin fallback). */
  mode: "sandbox-origin" | "restricted"
  iframe: HTMLIFrameElement
  host: McpAppHost
  /** Tear the view down (`ui/resource-teardown`), then remove the iframe.
   *  Idempotent. */
  dispose(): Promise<void>
}

export async function mountMcpApp(opts: MountMcpAppOptions): Promise<MountedMcpApp> {
  const { container, ui, sandbox, ...hostOptions } = opts
  const doc = container.ownerDocument
  const resolver = sandbox === false ? undefined : (sandbox ?? autoResolver(doc))
  let view: McpAppSandboxView | null = null
  if (resolver) {
    try {
      view = await resolver(ui)
    } catch {
      view = null
    }
  }
  // Enforced here, for EVERY resolver, not just the daemon's: a view on the
  // host's own origin with `allow-same-origin` would have the host page.
  if (view && (view.origin === doc.defaultView?.location.origin || !isHttpUrlOnOrigin(view))) {
    console.warn("[mcp-app-host] refused a sandbox view on the host's own origin (or an invalid URL).")
    view = null
  }
  if (!view) {
    console.warn(
      "[mcp-app-host] view in restricted mode: no dedicated sandbox origin available " +
        "(opaque-origin srcdoc; views that need IndexedDB, a real origin or OAuth callbacks may not run).",
    )
  }

  const iframe = doc.createElement("iframe")
  iframe.setAttribute("sandbox", view ? MCP_APP_SANDBOX_ORIGIN : MCP_APP_SANDBOX)
  // The view's URL is a capability: never let it ride in a Referer.
  iframe.referrerPolicy = "no-referrer"
  const allow = buildAllowAttribute(toResourcePermissions(ui.permissions))
  if (allow) iframe.setAttribute("allow", allow)
  iframe.style.display = "block"
  iframe.style.width = "100%"
  iframe.style.border = ui.prefersBorder ? "1px solid rgba(127, 127, 127, 0.35)" : "0"
  if (view) iframe.src = view.url
  else iframe.srcdoc = injectCsp(ui.html, ui.csp)
  container.appendChild(iframe)

  const viewWindow = iframe.contentWindow
  const hostWindow = doc.defaultView
  if (!viewWindow || !hostWindow) {
    iframe.remove()
    throw new Error("mountMcpApp: container is not attached to a document with a browsing context")
  }
  // Pinned both ways: we only post to this iframe, and only accept messages
  // from this iframe's window (and, in sandbox-origin mode, its origin).
  const transport = view
    ? new OriginPinnedTransport(viewWindow, view.origin, hostWindow)
    : new PostMessageTransport(viewWindow, viewWindow)
  let host: McpAppHost
  try {
    host = await createMcpAppHost(transport, hostOptions)
  } catch (err) {
    iframe.remove()
    throw err
  }

  let disposed: Promise<void> | undefined
  return {
    mode: view ? "sandbox-origin" : "restricted",
    iframe,
    host,
    dispose() {
      disposed ??= host.teardown().finally(() => iframe.remove())
      return disposed
    },
  }
}
