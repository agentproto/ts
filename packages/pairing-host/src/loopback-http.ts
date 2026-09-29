import {
  createTunnelServer,
  DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
  type E2eFrameSink,
  type TunnelFrame,
} from "@agentproto/acp/tunnel"
import type { PairingChannelContext, PairingChannelHandle } from "./pairing-registry.js"

export interface ServeLoopbackHttpOptions {
  /** The local HTTP app the paired channel is forwarded to. Must be a
   *  loopback http(s) URL (127.0.0.0/8, ::1 or localhost): a paired peer must
   *  never be able to steer the host at another machine. */
  target: URL | string
  /** Headers set on EVERY forwarded request, overriding any same-named header
   *  the peer sent (e.g. the host app's own bearer). */
  injectHeaders?: Readonly<Record<string, string>>
  /** Pathnames a peer may request. `"/mcp"` matches exactly, `"/api/*"`
   *  matches `/api` and everything below it, a RegExp is tested against the
   *  pathname. Omitted: any path. `[]`: nothing. A denied request gets a 403
   *  `path_not_allowed` response and never reaches the target. */
  allowPaths?: readonly (string | RegExp)[]
  /** Label in the tunnel hello. Default "loopback-http". */
  label?: string
  httpForwardTimeoutMs?: number
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
}

/** Pathname of a frame path, or null when it must be refused outright (the
 *  tunnel server already rejects `..` and non-rooted paths; encoded dot/slash
 *  forms are refused here because the target may decode them). */
function safePathname(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null
  if (/%2e|%2f|%5c/i.test(path)) return null
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

function pathAllowed(pathname: string, allow: readonly (string | RegExp)[]): boolean {
  return allow.some(rule => {
    if (rule instanceof RegExp) {
      rule.lastIndex = 0
      return rule.test(pathname)
    }
    if (rule.endsWith("/*")) {
      const base = rule.slice(0, -2)
      return pathname === base || pathname.startsWith(`${base}/`)
    }
    return pathname === rule
  })
}

/**
 * Build a `PairingRegistryDeps.serve` that forwards the paired, E2E-wrapped
 * channel to a local HTTP app: `http_request` frames become fetches against
 * `target` (with `injectHeaders` applied), responses stream back. Spawn, PTY
 * and WebSocket frames are not served.
 */
export function serveLoopbackHttp(
  opts: ServeLoopbackHttpOptions,
): (sink: E2eFrameSink, ctx: PairingChannelContext) => PairingChannelHandle {
  const target = typeof opts.target === "string" ? new URL(opts.target) : opts.target
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`serveLoopbackHttp: target must be http(s), got ${target.protocol}`)
  }
  if (!isLoopback(target)) {
    throw new Error(`serveLoopbackHttp: target must be a loopback address, got ${target.hostname}`)
  }
  const httpUpstream = target.origin + target.pathname.replace(/\/$/, "")
  const allow = opts.allowPaths

  return sink => {
    const guarded = allow ? guardSink(sink, allow) : sink
    const server = createTunnelServer({
      sink: guarded,
      label: opts.label ?? "loopback-http",
      pty: false,
      authorize: () => null,
      httpUpstream,
      ...(opts.injectHeaders && Object.keys(opts.injectHeaders).length > 0
        ? { httpInjectHeaders: opts.injectHeaders }
        : {}),
      httpForwardTimeoutMs: opts.httpForwardTimeoutMs ?? DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
      httpStreamIdleTimeoutMs: 120_000,
    })
    return { close: () => server.close() }
  }
}

/** A view of `sink` whose inbound `http_request` frames outside `allow` are
 *  answered 403 here instead of being delivered to the tunnel server. */
function guardSink(sink: E2eFrameSink, allow: readonly (string | RegExp)[]): E2eFrameSink {
  const denied = new Set<string>()
  const deny = (reqId: string, path: string): void => {
    denied.add(reqId)
    sink.send({
      t: "http_response",
      reqId,
      status: 403,
      error: { code: "path_not_allowed", message: `path '${path}' is not allowed on this host` },
    })
  }
  return {
    send: frame => sink.send(frame),
    close: reason => sink.close(reason),
    onClose: handler => sink.onClose(handler),
    get isOpen() {
      return sink.isOpen
    },
    get sentCount() {
      return sink.sentCount
    },
    get recvCount() {
      return sink.recvCount
    },
    onFrame: handler =>
      sink.onFrame((frame: TunnelFrame) => {
        if (frame.t === "http_request") {
          const pathname = safePathname(frame.path)
          if (pathname === null || !pathAllowed(pathname, allow)) {
            deny(frame.reqId, pathname ?? "(invalid)")
            return
          }
        } else if (frame.t === "http_request_chunk" && denied.has(frame.reqId)) {
          if (frame.end) denied.delete(frame.reqId)
          return
        }
        handler(frame)
      }),
  }
}
