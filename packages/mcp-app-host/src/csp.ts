/**
 * Pure CSP builders for MCP App views (no DOM, no ext-apps import — also
 * consumed by the daemon, which serves the sandbox-origin document with the
 * policy as an HTTP header).
 *
 * Two shapes, same inputs (`_meta.ui.csp`):
 * - {@link buildCspPolicy}: for an opaque-origin `srcdoc` document (restricted
 *   mode): no `'self'` (the origin is opaque), delivered as a `<meta>`.
 * - {@link buildSandboxCspHeader}: for a document served from a dedicated
 *   sandbox origin (MCP Apps spec, "Rendering the MCP App"): `'self'` is the
 *   sandbox origin, `base-uri 'self'` by default, plus `frame-ancestors`
 *   pinned to the embedding host. Delivered as an HTTP header so the view
 *   cannot tamper with it.
 */

import type { McpAppUiCsp } from "./types.js"

export type { McpAppUiCsp }

/**
 * A CSP source token is a single whitespace-free word. Anything else coming
 * from `_meta.ui.csp` — a `;`, a quote, a space — could smuggle an extra
 * directive or keyword into the policy, so it is dropped rather than
 * escaped.
 */
// eslint-disable-next-line no-control-regex
const SAFE_SOURCE_CHARS = /^[\u0021-\u007e]+$/
const SAFE_SOURCE = { test: (d: string) => SAFE_SOURCE_CHARS.test(d) && !/[;,'"<>]/.test(d) }

function safeSources(domains: readonly string[] | undefined): string[] {
  return (domains ?? []).filter((d) => SAFE_SOURCE.test(d))
}

function directive(name: string, fixed: readonly string[], domains: readonly string[]): string {
  return [name, ...fixed, ...domains].join(" ")
}

const sources = safeSources

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
    "object-src 'none'",
    // The opaque origin sends `Origin: null`: forms must not post anywhere.
    "form-action 'none'",
    directive("base-uri", [], orNone(sources(csp?.baseUriDomains))),
  ].join("; ")
}


/** Reduce a value to a bare `scheme://host[:port]` origin, or undefined. Used
 *  for the `frame-ancestors` source: nothing but an origin may reach it. */
export function toOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const u = new URL(value)
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    return u.origin
  } catch {
    return undefined
  }
}

/**
 * The Content-Security-Policy HEADER for a view served from its own sandbox
 * origin. `frameAncestor` is the embedding host's origin; anything that is
 * not a bare http(s) origin collapses to `'none'` (nobody may embed it).
 */
export function buildSandboxCspHeader(
  csp: McpAppUiCsp | undefined,
  frameAncestor: string | undefined,
  opts: { dropSource?: (source: string) => boolean } = {},
): string {
  const drop = opts.dropSource
  const sources = (domains: readonly string[] | undefined): string[] =>
    safeSources(domains).filter((d) => !drop?.(d))
  const resource = sources(csp?.resourceDomains)
  const orNone = (domains: string[]) => (domains.length > 0 ? domains : ["'none'"])
  const ancestor = toOrigin(frameAncestor)
  return [
    "default-src 'none'",
    directive("script-src", ["'self'", "'unsafe-inline'"], resource),
    directive("style-src", ["'self'", "'unsafe-inline'"], resource),
    directive("img-src", ["'self'", "data:", "blob:"], resource),
    directive("font-src", ["'self'", "data:"], resource),
    directive("media-src", ["'self'", "data:", "blob:"], resource),
    directive("connect-src", ["'self'"], sources(csp?.connectDomains)),
    directive("frame-src", [], orNone(sources(csp?.frameDomains))),
    "object-src 'none'",
    // Forms would otherwise POST anywhere with `Origin: null` (the sandbox allows forms).
    "form-action 'self'",
    directive("base-uri", [], sources(csp?.baseUriDomains).length > 0 ? sources(csp?.baseUriDomains) : ["'self'"]),
    `frame-ancestors ${ancestor ?? "'none'"}`,
  ].join("; ")
}
