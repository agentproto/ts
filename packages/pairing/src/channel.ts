/**
 * One E2E channel to the daemon through the rendezvous: dial the broker, run
 * the `pair/v1` client handshake, and read the daemon's greeting.
 *
 * This is the Node client's `acceptOffer` / `openPairChannel` sequence
 * (`packages/cli/src/util/pair-transport.ts`) — same upgrade URL, same pair/v2
 * hello (static keys pinned, the client name, and the AUTH token sealed to the
 * daemon's key), same verification — built only from the browser-safe
 * entries, so the daemon can't tell the two clients apart. The ROUTE token is
 * the only thing on the broker URL; the auth token never leaves the sealed
 * hello.
 */

import {
  clientHandshakeOverSink,
  wrapWebSocket,
  type E2eFrameSink,
  type ErrorFrame,
  type FrameSink,
  type HelloFrame,
  type TunnelFrame,
  type WebSocketLike,
} from "@agentproto/acp/tunnel/browser"
import {
  decodePairingReply,
  encodePairingMessage,
  startClientHandshake,
  type PairingSession,
} from "@agentproto/secrets/pairing/browser"
import { TunnelClientError } from "./errors.js"

/** The tunnel `error` code the daemon answers a revoked pairing with
 *  (`PAIRING_REVOKED_CODE` in `@agentproto/runtime`'s pairing registry). */
export const PAIRING_REVOKED_CODE = "pairing_revoked"
/** The tunnel `error` code (and `PairingError` code) for a pre-v2 pairing. */
export const PAIRING_PROTOCOL_OUTDATED_CODE = "pairing_protocol_outdated"

/** A WHATWG `WebSocket` constructor (the global one by default). */
export type WebSocketConstructor = new (url: string) => WebSocket

export interface ChannelTimeouts {
  /** Rendezvous dial ceiling. Default 15s (as the CLI). */
  dialTimeoutMs?: number
  /** Handshake ceiling. Default 15s (as the CLI). */
  handshakeTimeoutMs?: number
  /** How long to wait for the daemon's first tunnel frame. Default 10s. */
  greetingTimeoutMs?: number
}

export const DEFAULT_DIAL_TIMEOUT_MS = 15_000
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
export const DEFAULT_GREETING_TIMEOUT_MS = 10_000

function rendezvousClientUrl(base: string, token: string): string {
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}side=client&t=${encodeURIComponent(token)}`
}

/** Open a WebSocket to the broker and adapt it to a `FrameSink`. */
export function dialRendezvous(
  rendezvousUrl: string,
  token: string,
  WebSocketImpl: WebSocketConstructor,
  timeoutMs: number,
): Promise<FrameSink> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocketImpl(rendezvousClientUrl(rendezvousUrl, token))
    } catch (err) {
      reject(err)
      return
    }
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onFail)
      ws.removeEventListener("close", onFail)
      fn()
    }
    const onOpen = (): void =>
      finish(() => {
        // The broker can refuse on arrival (e.g. token in use) in the same
        // tick as the upgrade; a socket that is already closing is a failed
        // dial, not a sink that would silently eat the handshake.
        if (ws.readyState !== 1) reject(new Error("rendezvous closed the connection on arrival"))
        else resolve(wrapWebSocket(ws as unknown as WebSocketLike))
      })
    const onFail = (): void => finish(() => reject(new Error("rendezvous dial failed")))
    const timer = setTimeout(
      () =>
        finish(() => {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          reject(new Error(`rendezvous dial timed out after ${timeoutMs}ms`))
        }),
      timeoutMs,
    )
    ws.addEventListener("open", onOpen)
    ws.addEventListener("error", onFail)
    ws.addEventListener("close", onFail)
  })
}

export interface OpenChannelParams extends ChannelTimeouts {
  rendezvousUrl: string
  /** The ROUTE token: the only value that goes on the broker URL. From the
   *  offer secret (first contact) or the pair root + epoch (reconnect). */
  route: string
  /** The AUTH token: sealed into the hello, never on a URL. */
  auth: string
  daemonX25519Pub: string
  daemonEd25519Pub: string
  clientName: string
  WebSocket: WebSocketConstructor
}

export type Greeting =
  | { kind: "hello"; hello: HelloFrame }
  | { kind: "revoked"; frame: ErrorFrame }
  | { kind: "outdated"; frame: ErrorFrame }

export interface OpenedChannel {
  sink: E2eFrameSink
  session: PairingSession
  /** The daemon's first frame, `hello` — or its `pairing_revoked` refusal. */
  greeting: Greeting
  /** Detach the greeting reader and route every later frame to `handler`.
   *  Frames that arrived after the greeting and before this call are replayed
   *  first, in order. */
  route(handler: (frame: TunnelFrame) => void): void
}

/**
 * Dial, handshake, and read the greeting. Rejects (closing the socket) on any
 * failure; a `pairing_revoked` greeting resolves — the caller decides what it
 * means. The daemon signature is verified against the pinned Ed25519 key by
 * the handshake itself, so a greeting is authenticated.
 */
export async function openChannel(params: OpenChannelParams): Promise<OpenedChannel> {
  const raw = await dialRendezvous(
    params.rendezvousUrl,
    params.route,
    params.WebSocket,
    params.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS,
  )
  let sink: E2eFrameSink
  let session: PairingSession | null = null
  try {
    const started = await startClientHandshake({
      daemonX25519Pub: params.daemonX25519Pub,
      daemonEd25519Pub: params.daemonEd25519Pub,
      authToken: params.auth,
      clientName: params.clientName,
    })
    sink = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      async reply => {
        session = await started.complete(decodePairingReply(reply))
        return session
      },
      { timeoutMs: params.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS },
    )
  } catch (err) {
    raw.close("handshake failed")
    throw err
  }
  if (!session) {
    sink.close("handshake failed")
    throw new Error("handshake did not derive a session")
  }

  // One subscription for the channel's whole life (wrapE2E replays early
  // frames to its FIRST subscriber only): the greeting is read here, the rest
  // is buffered until the caller routes it.
  let router: ((frame: TunnelFrame) => void) | null = null
  const backlog: TunnelFrame[] = []
  let onGreeting: ((frame: TunnelFrame) => void) | null = null
  sink.onFrame(frame => {
    if (onGreeting) {
      const cb = onGreeting
      onGreeting = null
      cb(frame)
      return
    }
    if (router) router(frame)
    else backlog.push(frame)
  })

  const timeoutMs = params.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS
  let greeting: Greeting
  try {
    greeting = await new Promise<Greeting>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no greeting from the daemon")), timeoutMs)
      const offClose = sink.onClose(reason => {
        clearTimeout(timer)
        reject(new Error(`channel closed before the daemon greeted: ${reason ?? "closed"}`))
      })
      onGreeting = frame => {
        clearTimeout(timer)
        offClose()
        if (frame.t === "hello") resolve({ kind: "hello", hello: frame })
        else if (frame.t === "error" && frame.code === PAIRING_REVOKED_CODE)
          resolve({ kind: "revoked", frame })
        else if (frame.t === "error" && frame.code === PAIRING_PROTOCOL_OUTDATED_CODE)
          resolve({ kind: "outdated", frame })
        else reject(new Error(`unexpected first frame from the daemon: "${frame.t}"`))
      }
    })
  } catch (err) {
    sink.close("no greeting")
    throw err
  }

  return {
    sink,
    session,
    greeting,
    route(handler) {
      router = handler
      for (const f of backlog.splice(0)) handler(f)
    },
  }
}

/** Human-friendly daemon name from its hello: the `label`, else the host part
 *  of `daemon.platform` (`<os>/<hostname>`), else the fallback. */
export function daemonNameFromHello(hello: HelloFrame | null, fallback: string): string {
  if (hello?.label) return hello.label
  const platform = hello?.daemon?.platform
  const host = platform?.includes("/") ? platform.slice(platform.indexOf("/") + 1) : undefined
  return host || fallback
}

export function defaultWebSocket(): WebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
  if (!ctor) {
    throw new TunnelClientError("offline", "no WebSocket implementation in this context (pass opts.WebSocket)")
  }
  return ctor
}
