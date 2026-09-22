import type { IncomingHttpHeaders } from "node:http"

const HTTP_PROTOCOLS = new Set(["http:", "https:"])
const WS_PROTOCOLS = new Set(["ws:", "wss:"])

function normalizeOrigin(
  value: string | undefined,
  protocols: ReadonlySet<string>,
): string | undefined {
  const candidate = value?.trim().replace(/\/+$/, "")
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (!protocols.has(url.protocol)) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    if (url.pathname !== "/") return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Resolve the daemon HTTP origin as seen by one proxied request. */
export function resolveRequestHttpBaseUrl(
  headers: IncomingHttpHeaders,
  configuredOrigin = process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN,
): string {
  const configured = normalizeOrigin(configuredOrigin, HTTP_PROTOCOLS)
  if (configured) return configured

  const forwarded = headers["x-forwarded-proto"]
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
  const protocol = firstForwarded === "https" ? "https" : "http"
  return (
    normalizeOrigin(`${protocol}://${headers.host ?? "127.0.0.1"}`, HTTP_PROTOCOLS) ??
    `${protocol}://127.0.0.1`
  )
}

/** Resolve the public HTTP + PTY WebSocket origins used at gateway boot. */
export function resolvePublicAppOrigins(
  port: number,
  configuredHttpOrigin = process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN,
  configuredWsOrigin = process.env.AGENTPROTO_PUBLIC_WS_ORIGIN,
): { httpOrigin: string; wsOrigin: string } {
  const httpOrigin =
    normalizeOrigin(configuredHttpOrigin, HTTP_PROTOCOLS) ??
    `http://127.0.0.1:${port}`
  const configuredWs = normalizeOrigin(configuredWsOrigin, WS_PROTOCOLS)
  if (configuredWs) return { httpOrigin, wsOrigin: configuredWs }

  const http = new URL(httpOrigin)
  http.protocol = http.protocol === "https:" ? "wss:" : "ws:"
  return { httpOrigin, wsOrigin: http.origin }
}
