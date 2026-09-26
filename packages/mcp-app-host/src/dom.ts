/**
 * Browser DOM adapter for {@link createMcpAppHost}: mounts an MCP App's
 * `ui://` html in a sandboxed `srcdoc` iframe and speaks the protocol to it
 * over ext-apps' `PostMessageTransport`.
 *
 * Isolation model (v1): an opaque-origin srcdoc iframe — `sandbox` without
 * `allow-same-origin`, so the view can't touch the host's DOM, storage or
 * cookies — plus a CSP `<meta>` built from the resource's `_meta.ui.csp`,
 * injected as the first child of `<head>` so it governs everything the view
 * loads. The spec's sandbox-proxy double-iframe (a separate origin serving
 * the view) is NOT implemented; see README "Known limits".
 *
 * `buildCspPolicy` / `buildCspMeta` / `injectCsp` are pure string functions,
 * usable (and tested) without a DOM.
 */

import {
  buildAllowAttribute,
  type McpUiResourcePermissions,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge"

import { createMcpAppHost, type McpAppHost, type McpAppHostOptions } from "./host.js"
import type { McpAppUi, McpAppUiCsp } from "./types.js"

export type { McpAppUi, McpAppUiCsp }

/** Never `allow-same-origin`: with it, a srcdoc iframe shares the host's
 *  origin and its scripts could reach straight into the embedding page. */
export const MCP_APP_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"

/**
 * A CSP source token is a single whitespace-free word. Anything else coming
 * from `_meta.ui.csp` — a `;`, a quote, a space — could smuggle an extra
 * directive or keyword into the policy, so it is dropped rather than
 * escaped.
 */
const SAFE_SOURCE = /^[^\s;,'"<>]+$/

function sources(domains: readonly string[] | undefined): string[] {
  return (domains ?? []).filter((d) => SAFE_SOURCE.test(d))
}

function directive(name: string, fixed: readonly string[], domains: readonly string[]): string {
  return [name, ...fixed, ...domains].join(" ")
}

/** The Content-Security-Policy string for a view (CONTRACT §3). */
export function buildCspPolicy(csp: McpAppUiCsp | undefined): string {
  const resource = sources(csp?.resourceDomains)
  const orNone = (domains: string[]) => (domains.length > 0 ? domains : ["'none'"])
  return [
    "default-src 'none'",
    directive("script-src", ["'unsafe-inline'"], resource),
    directive("style-src", ["'unsafe-inline'"], resource),
    directive("img-src", ["data:", "blob:"], resource),
    directive("font-src", ["data:"], resource),
    directive("media-src", ["data:", "blob:"], resource),
    directive("connect-src", [], orNone(sources(csp?.connectDomains))),
    directive("frame-src", [], orNone(sources(csp?.frameDomains))),
    directive("base-uri", [], orNone(sources(csp?.baseUriDomains))),
  ].join("; ")
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/** The `<meta http-equiv="Content-Security-Policy">` tag for a view. */
export function buildCspMeta(csp: McpAppUiCsp | undefined): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildCspPolicy(csp))}">`
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i
const HTML_OPEN = /<html(?:\s[^>]*)?>/i
const DOCTYPE = /^\s*<!doctype[^>]*>/i

/**
 * Inject the CSP meta as the first child of `<head>`, creating `<head>` when
 * the document has none. A CSP meta the view ships itself is left in place:
 * browsers enforce every policy present, so it can only tighten ours.
 */
export function injectCsp(html: string, csp: McpAppUiCsp | undefined): string {
  const meta = buildCspMeta(csp)
  const head = HEAD_OPEN.exec(html)
  if (head) return insertAt(html, head.index + head[0].length, meta)
  const htmlTag = HTML_OPEN.exec(html)
  if (htmlTag) return insertAt(html, htmlTag.index + htmlTag[0].length, `<head>${meta}</head>`)
  const doctype = DOCTYPE.exec(html)
  const at = doctype ? doctype[0].length : 0
  return insertAt(html, at, `<head>${meta}</head>`)
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
}

export interface MountedMcpApp {
  iframe: HTMLIFrameElement
  host: McpAppHost
  /** Tear the view down (`ui/resource-teardown`), then remove the iframe.
   *  Idempotent. */
  dispose(): Promise<void>
}

export async function mountMcpApp(opts: MountMcpAppOptions): Promise<MountedMcpApp> {
  const { container, ui, ...hostOptions } = opts
  const iframe = container.ownerDocument.createElement("iframe")
  iframe.setAttribute("sandbox", MCP_APP_SANDBOX)
  const allow = buildAllowAttribute(toResourcePermissions(ui.permissions))
  if (allow) iframe.setAttribute("allow", allow)
  iframe.style.display = "block"
  iframe.style.width = "100%"
  iframe.style.border = ui.prefersBorder ? "1px solid rgba(127, 127, 127, 0.35)" : "0"
  iframe.srcdoc = injectCsp(ui.html, ui.csp)
  container.appendChild(iframe)

  const view = iframe.contentWindow
  if (!view) {
    iframe.remove()
    throw new Error("mountMcpApp: container is not attached to a document with a browsing context")
  }
  // Pinned both ways: we only post to this iframe, and only accept messages
  // whose `event.source` is this iframe's window.
  const transport = new PostMessageTransport(view, view)
  let host: McpAppHost
  try {
    host = await createMcpAppHost(transport, hostOptions)
  } catch (err) {
    iframe.remove()
    throw err
  }

  let disposed: Promise<void> | undefined
  return {
    iframe,
    host,
    dispose() {
      disposed ??= host.teardown().finally(() => iframe.remove())
      return disposed
    },
  }
}
