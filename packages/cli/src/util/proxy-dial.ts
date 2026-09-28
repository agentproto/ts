/**
 * Corporate-proxy support for the daemon's rendezvous dial (DEVICES-PLAN item
 * 3). `ws`'s `new WebSocket(url)` — unlike Node's own `fetch`, which honours
 * `NODE_USE_ENV_PROXY` — does NOT read `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`
 * env vars on its own: it just opens a raw TCP socket to the target host.
 * Behind an outbound-HTTPS-only corporate proxy (locked-down work laptop, no
 * admin rights) that raw connect never reaches the rendezvous broker at all.
 *
 * {@link resolveProxyDialOptions} decides whether a proxy applies for a given
 * target URL and, if so, returns a `ws`-compatible `agent` — an
 * `HttpsProxyAgent`/`HttpProxyAgent` that CONNECTs through the configured
 * proxy at the socket level (there's no lighter way to tunnel a WS handshake
 * through an HTTP(S) proxy; `ws` itself has no built-in proxy support).
 *
 * Every rendezvous dial the daemon makes should run its target URL through
 * this helper first — see `serve.ts`'s `daemonDialRendezvous` and
 * `pair-transport.ts`'s `dialRendezvous` (the CLI-local equivalent, per its
 * own docblock).
 */

import { HttpsProxyAgent } from "https-proxy-agent"
import { HttpProxyAgent } from "http-proxy-agent"
import type { Agent } from "node:http"

export interface ProxyDialOptions {
  /** A `ws`-compatible agent to pass as `new WebSocket(url, { agent })`.
   *  Absent when dialing direct. */
  agent?: Agent
  /** Which mode was selected — lets a caller (e.g. the doctor step) report
   *  which one actually applied. */
  via: "direct" | "proxy"
}

/**
 * Resolve proxy dial options for `targetUrl` (a `ws://` or `wss://` rendezvous
 * URL) against `env` (defaults to `process.env`).
 *
 * Precedence: `NO_PROXY`/`no_proxy` first — if the target host matches, dial
 * direct regardless of any proxy var. Otherwise pick `HTTPS_PROXY`/`https_proxy`
 * for a `wss://` target, `HTTP_PROXY`/`http_proxy` (falling back to the HTTPS
 * proxy var, since a single corporate proxy commonly fronts both) for a
 * `ws://` target. No matching proxy var → dial direct.
 */
export function resolveProxyDialOptions(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ProxyDialOptions {
  const target = new URL(targetUrl)
  const secure = target.protocol === "wss:"

  if (isNoProxy(target, env)) return { via: "direct" }

  const proxyUrl = secure
    ? env.HTTPS_PROXY ?? env.https_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.HTTPS_PROXY ?? env.https_proxy
  if (!proxyUrl) return { via: "direct" }

  const agent: Agent = secure ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl)
  return { agent, via: "proxy" }
}

/** `NO_PROXY`/`no_proxy`: a comma-separated list of hostnames/suffixes, `*`
 *  meaning "never proxy anything". Matching is case-insensitive and mirrors
 *  Node/curl: an entry matches the target host exactly, or as a `.suffix`
 *  (a leading `.` on the entry is stripped first, so `.example.com` and
 *  `example.com` behave the same). An entry's port, if present, must also
 *  match the target's (default 443 for `wss:`, 80 for `ws:`) — a bare
 *  hostname entry ignores the target's port entirely. */
function isNoProxy(target: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = env.NO_PROXY ?? env.no_proxy
  if (!raw) return false
  const entries = raw
    .split(",")
    .map(e => e.trim())
    .filter(Boolean)
  if (entries.length === 0) return false
  if (entries.includes("*")) return true

  const host = target.hostname.toLowerCase()
  const port = target.port || (target.protocol === "wss:" ? "443" : "80")

  return entries.some(entry => {
    const idx = entry.lastIndexOf(":")
    const hasPort = idx > 0 && /^\d+$/.test(entry.slice(idx + 1))
    const entryHost = (hasPort ? entry.slice(0, idx) : entry).replace(/^\./, "").toLowerCase()
    const entryPort = hasPort ? entry.slice(idx + 1) : undefined
    if (entryPort !== undefined && entryPort !== port) return false
    return host === entryHost || host.endsWith(`.${entryHost}`)
  })
}
