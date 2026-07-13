/**
 * Shared daemon-side `createTunnelServer` config.
 *
 * The `serve --connect` reverse tunnel and an E2E *pairing* channel both serve
 * the exact same thing — the daemon's local gateway — over a `FrameSink`. The
 * only differences are the transport (a raw WS vs. a `wrapE2E`-wrapped spliced
 * socket) and a couple of connect-only hooks (`onReconnectSoon`). So the bulk of
 * the `createTunnelServer` options — HTTP/WS forwarding to the gateway, the
 * spawn authorize hook, PTY, the sessions-registry adoption hook — is built once
 * here and spread into both call sites. Pairing then gets the spawn-authorization
 * hook "and all" for free (PLAN deliverable 2), rather than a divergent copy.
 */

import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import {
  DEFAULT_WS_DIAL_TIMEOUT_MS,
  DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
  type TunnelServerOptions,
} from "@agentproto/acp/tunnel"
import { loadImportedMcps } from "@agentproto/runtime/mcp-imports"
import type { GatewayHandle } from "@agentproto/runtime"
import type { PtyFactory } from "./pty-factory.js"

/** The `createTunnelServer` options common to `serve --connect` and pairing —
 *  everything except `sink` and the connect-only `onReconnectSoon`. */
export type CommonTunnelServerOptions = Omit<TunnelServerOptions, "sink" | "onReconnectSoon">

export interface BuildTunnelServerOptionsInput {
  gateway: GatewayHandle
  /** Label surfaced in the hello frame + sessions rows. */
  label: string
  /** node-pty factory (or null when unavailable). */
  spawnPty: PtyFactory | null
  /** Capabilities advertised in the hello frame. */
  announcedTools?: readonly string[]
  /**
   * Injected into every forwarded `http_request` (design DESIGN §5): traffic
   * arriving over a peer-authenticated channel enters the daemon's HTTP layer
   * with the gateway's own bearer token, so mutating `/sessions/*` routes (which
   * have no loopback bypass) pass `checkSessionsToken`. Omit for the trusted
   * `serve --connect` host, which drives `/mcp` (loopback-bypassed) and doesn't
   * need it. Set it for a pairing so the whole daemon HTTP surface works.
   */
  injectAuthToken?: string
  /** Prefix for the sessions-registry label of adopted spawns. `serve --connect`
   *  uses "tunnel"; a pairing uses "pair". Default "pair". */
  childLabelPrefix?: string
}

export function buildDaemonTunnelServerOptions(
  input: BuildTunnelServerOptionsInput,
): CommonTunnelServerOptions {
  const { gateway, label, spawnPty, announcedTools, injectAuthToken } = input
  const childLabelPrefix = input.childLabelPrefix ?? "pair"

  return {
    label,
    pty: spawnPty !== null,
    ...(spawnPty ? { spawnPty } : {}),
    ...(announcedTools && announcedTools.length ? { tools: announcedTools } : {}),
    // Generic HTTP-relay upstream for `http_request` frames — the daemon's own
    // gateway, where /mcp, /sessions, /events, /permissions live.
    httpUpstream: gateway.url,
    ...(injectAuthToken
      ? { httpInjectHeaders: { authorization: `Bearer ${injectAuthToken}` } }
      : {}),
    httpForwardTimeoutMs: DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
    wsDialTimeoutMs: DEFAULT_WS_DIAL_TIMEOUT_MS,
    httpStreamIdleTimeoutMs: 120_000,
    // WS forwarding: the daemon dials its local gateway's WS endpoints
    // (/sessions/:id/pty, …) and pipes frames back through the tunnel.
    dialUpstreamWs: async ({ url, protocols, headers, signal }) => {
      // The gateway requires a trusted Origin on WS routes; self-dialing here
      // (no browser in the path) sets a loopback Origin matching the URL.
      const upstreamHeaders: Record<string, string> = {
        ...(headers as Record<string, string> | undefined),
      }
      if (!upstreamHeaders["origin"] && !upstreamHeaders["Origin"]) {
        try {
          const u = new URL(url)
          const httpScheme = u.protocol === "wss:" ? "https:" : "http:"
          upstreamHeaders["Origin"] = `${httpScheme}//${u.host}`
        } catch {
          /* malformed url — daemon will reject with a clear error */
        }
      }
      return await new Promise((resolve, reject) => {
        const sock = new WebSocket(url, protocols ? [...protocols] : undefined, {
          headers: upstreamHeaders,
        })
        const onAbort = (): void => {
          sock.off("open", onceOpen)
          sock.off("error", onceError)
          sock.off("unexpected-response", onceUnexpected)
          try {
            sock.terminate()
          } catch {
            /* already closing */
          }
          reject(signal?.reason instanceof Error ? signal.reason : new Error("ws dial aborted"))
        }
        const detachAbort = (): void => signal?.removeEventListener("abort", onAbort)
        const onceOpen = (): void => {
          detachAbort()
          sock.off("error", onceError)
          sock.off("unexpected-response", onceUnexpected)
          resolve({
            protocol: sock.protocol ?? "",
            send: (data, sendOpts) => {
              sock.send(data, { binary: sendOpts.binary })
            },
            close: (code, reason) => {
              try {
                sock.close(code, reason)
              } catch {
                /* already closed */
              }
            },
            onMessage: handler => {
              sock.on("message", (raw: Buffer, isBinary: boolean) => handler(raw, isBinary))
            },
            onClose: handler => {
              sock.on("close", (code: number, reason: Buffer) =>
                handler(code, reason.toString("utf8")),
              )
            },
            onError: handler => {
              sock.on("error", (err: Error) => handler(err))
            },
          })
        }
        const onceError = (err: Error): void => {
          detachAbort()
          sock.off("open", onceOpen)
          reject(err)
        }
        const onceUnexpected = (_req: unknown, res: { statusCode?: number }): void => {
          detachAbort()
          sock.off("open", onceOpen)
          reject(new Error(`Unexpected server response: ${res.statusCode ?? 0}`))
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
        sock.once("open", onceOpen)
        sock.once("error", onceError)
        sock.once("unexpected-response", onceUnexpected)
      })
    },
    // Resolve a named WS upstream (an import alias) to its origin.
    resolveWsUpstream: async alias => {
      const cfg = await loadImportedMcps()
      const entry = cfg.imports.find(e => e.alias === alias)
      const url = entry?.snapshot.url
      if (!url) return undefined
      try {
        return new URL(url).origin
      } catch {
        return undefined
      }
    },
    // v0 authorize hook: trust the peer-authenticated caller. Per-spawn policy
    // filtering will land alongside policy.toml — same as serve --connect.
    authorize: req => req,
    // Adopt tunnel spawns into the gateway's sessions registry so they show up
    // in /sessions + the CLI TUI alongside locally-originated spawns.
    onChildSpawned: ({ execId, child, request }) => {
      gateway.sessions.register({
        id: execId,
        child,
        workspaceSlug: label,
        command: [request.command, ...request.args].join(" "),
        kind: "agent-cli",
        label: `${childLabelPrefix}: ${request.command.split("/").pop() ?? request.command}`,
      })
    },
  }
}

/** A keepalive ping every 30s over `sink` — used by both serving paths to keep
 *  idle proxied connections from being reaped. Returns a stop fn. */
export function startKeepalive(send: (nonce: string) => void, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    try {
      send(randomUUID())
    } catch {
      /* sink closing */
    }
  }, intervalMs)
  if (typeof timer.unref === "function") timer.unref()
  return () => clearInterval(timer)
}
