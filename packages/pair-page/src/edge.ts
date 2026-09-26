/**
 * The edge Worker's logic (src/worker.ts is only its entry point), kept free
 * of Worker-runtime types so it runs under vitest with no network.
 *
 * One static bundle is served identically on every
 * `<daemon-fingerprint>.agentproto.cloud` (AIP-59 §5.8). Isolation comes from
 * the browser origin: there is no per-daemon logic here beyond refusing hosts
 * that aren't a daemon origin.
 *
 *   - Host: `<fp>.<PAIR_DOMAIN>` with `fp` = `identityFingerprint` (32
 *     lowercase hex). The apex, any other first label, and deeper names get a
 *     404. Extra hosts are allowed only through `PREVIEW_HOSTS` (the
 *     workers.dev preview, a local run), where the page labels itself as a
 *     preview.
 *   - Routes: `/`, `/pair` and `/d/*` get the one document (index.html); the
 *     rest is static assets (hashed `/assets/*`, `/pair-sw.js`, manifest,
 *     icons).
 *   - Every response carries the security headers below.
 *
 * Responses the service worker synthesizes from the daemon (the Control
 * Center document, its API calls) never pass through here: the daemon UI's
 * CSP is the daemon's own responsibility.
 */

export const DEFAULT_PAIR_DOMAIN = "agentproto.cloud"

/** `identityFingerprint`: the first 32 hex chars (128 bits) of sha256(X25519
 *  pub), lowercase. */
const FINGERPRINT_RE = /^[0-9a-f]{32}$/

export interface EdgeEnv {
  /** Static assets binding (`[assets] binding = "ASSETS"` in wrangler.toml). */
  ASSETS: { fetch(input: Request | string | URL): Promise<Response> }
  /** Registrable domain whose first-level labels are daemon origins. */
  PAIR_DOMAIN?: string
  /** Comma-separated extra hosts served in preview mode (e.g. the
   *  `*.workers.dev` preview, `localhost`). Empty in production. */
  PREVIEW_HOSTS?: string
}

export type HostVerdict =
  | { kind: "daemon"; fingerprint: string; loopback: boolean }
  | { kind: "preview"; loopback: boolean }
  | { kind: "reject" }

export function parsePreviewHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(h => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean)
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")
}

/** Which kind of host this is. `hostname` is `URL.hostname` (no port). */
export function classifyHost(hostname: string, opts: { pairDomain: string; previewHosts: readonly string[] }): HostVerdict {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  const loopback = isLoopbackHost(host)
  if (opts.previewHosts.includes(host)) return { kind: "preview", loopback }
  const domain = opts.pairDomain.toLowerCase().replace(/\.$/, "")
  if (!host.endsWith(`.${domain}`)) return { kind: "reject" }
  const label = host.slice(0, -domain.length - 1)
  // One label, exactly a fingerprint: rejects the apex (no label), deeper
  // names (a dot in `label`), and anything that isn't 32 lowercase hex.
  return FINGERPRINT_RE.test(label) ? { kind: "daemon", fingerprint: label, loopback } : { kind: "reject" }
}

/**
 * The page's CSP. The rendezvous URL comes from the offer and may be
 * self-hosted, hence `wss:` in `connect-src`. Plain `ws:` to loopback (a local
 * broker in a local e2e) is added only for preview and loopback hosts, never
 * for a production daemon origin.
 */
export function contentSecurityPolicy(opts: { loopbackWs: boolean }): string {
  const connect = ["'self'", "wss:", ...(opts.loopbackWs ? ["ws://127.0.0.1:*", "ws://localhost:*"] : [])]
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"

export function securityHeaders(verdict: HostVerdict): Record<string, string> {
  const loopbackWs = verdict.kind === "preview" || (verdict.kind === "daemon" && verdict.loopback)
  return {
    "Content-Security-Policy": contentSecurityPolicy({ loopbackWs }),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Robots-Tag": "noindex, nofollow",
  }
}

/** Routes answered with the single document. */
export function isAppRoute(pathname: string): boolean {
  return pathname === "/" || pathname === "/pair" || pathname === "/pair/" || pathname.startsWith("/d/")
}

export function cacheControl(pathname: string, status: number): string {
  if (status >= 400) return "no-store"
  // Content-hashed file names: safe to cache forever.
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable"
  // The service worker script and the document must pick up a new deploy at
  // once (the browser byte-compares the worker script on every update check).
  if (pathname === "/pair-sw.js" || isAppRoute(pathname)) return "no-cache"
  return "public, max-age=86400"
}

function finish(res: Response, pathname: string, verdict: HostVerdict): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(securityHeaders(verdict))) out.headers.set(k, v)
  out.headers.set("Cache-Control", cacheControl(pathname, out.status))
  return out
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })
}

export async function handleRequest(request: Request, env: EdgeEnv): Promise<Response> {
  const url = new URL(request.url)
  const verdict = classifyHost(url.hostname, {
    pairDomain: env.PAIR_DOMAIN || DEFAULT_PAIR_DOMAIN,
    previewHosts: parsePreviewHosts(env.PREVIEW_HOSTS),
  })
  if (verdict.kind === "reject") return finish(notFound(), url.pathname, verdict)
  if (request.method !== "GET" && request.method !== "HEAD") {
    return finish(new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } }), url.pathname, verdict)
  }
  const target = isAppRoute(url.pathname) ? new Request(new URL("/index.html", url), request) : request
  const res = await env.ASSETS.fetch(target)
  return finish(res.status === 404 ? notFound() : res, url.pathname, verdict)
}
