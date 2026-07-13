/**
 * The rendezvous broker (design: DESIGN §3).
 *
 * A deliberately dumb WebSocket server. It matches two sockets that present the
 * same one-time token on the upgrade URL — one `side=daemon`, one `side=client`
 * — and from then on pipes their messages **byte-for-byte** in both directions,
 * parsing nothing beyond the upgrade URL. The two peers run the `pair/v1`
 * handshake and an AEAD channel end-to-end (see `@agentproto/secrets/pairing`
 * and `@agentproto/acp/tunnel`), so the broker sees only opaque ciphertext: it
 * learns token, IPs, message sizes, and timing, and can neither read nor forge
 * traffic.
 *
 * ## Wire
 *
 *   GET <path>?side=daemon|client&t=<token>   (Upgrade: websocket)
 *
 * ## Hygiene (all configurable)
 *
 *   - **Park timeout**: the first arrival parks waiting for its counterpart; if
 *     none shows within `parkTimeoutMs` it is closed.
 *   - **Idle timeout**: a spliced pair with no traffic in either direction for
 *     `idleTimeoutMs` is torn down.
 *   - **Max message size**: frames larger than `maxMessageBytes` close the
 *     offending socket (ws `maxPayload`).
 *   - **Per-IP rate limit**: token *attempts* are limited per source IP (keyed
 *     by the real socket address, never a client-supplied `X-Forwarded-For`).
 *   - **Concurrency guard** ("single-use"): a token that is currently parked or
 *     actively spliced refuses any third socket — an eavesdropper can never join
 *     a live pair, and a token can't be double-parked. Permanent single-use of
 *     *offer* tokens is the daemon's job (`verifyOfferToken` spends them); the
 *     broker frees a token once its splice closes so day-scoped reconnect tokens
 *     can be reused.
 *   - **Constant-time token compare**: matching is a hash-map lookup, but the
 *     presented token is compared to the parked token in constant time before
 *     splicing (defence-in-depth against a timing oracle).
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js"
import { timingSafeEqualStrings } from "./timing-safe.js"

/** WebSocket close codes the broker uses. 4xxx is the private-use range —
 *  these never collide with the protocol's own 1xxx codes. */
export const RV_CLOSE = {
  /** Malformed upgrade — bad/missing side or token. */
  badRequest: 4400,
  /** Park timeout expired before a counterpart arrived. */
  parkTimeout: 4408,
  /** Token is already parked (same side) or actively spliced. */
  tokenInUse: 4409,
  /** Per-IP rate limit exceeded. */
  rateLimited: 4429,
  /** The spliced counterpart went away. */
  peerClosed: 4410,
  /** Idle timeout after splice — distinct from parkTimeout so a client can
   *  tell "no counterpart ever arrived" from "the pair went quiet". */
  idleTimeout: 4411,
} as const

export interface RendezvousServerOptions {
  /** Upgrade path the broker listens on. Default `/v1`. */
  path?: string
  /** How long a lone arrival waits for its counterpart. Default 120_000. */
  parkTimeoutMs?: number
  /** How long a spliced pair may sit idle before teardown. Default 900_000. */
  idleTimeoutMs?: number
  /** Max size of a single WS message, in bytes. Default 1 MiB. */
  maxMessageBytes?: number
  /** Per-IP token-attempt rate limit. Default 120 attempts / 60_000 ms. */
  rateLimit?: { max: number; windowMs: number; maxKeys?: number }
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number
  /** Optional diagnostic log sink. */
  onLog?: (line: string) => void
}

/** Live counters, exposed for tests + operational introspection. */
export interface RendezvousStats {
  /** Tokens with one side currently parked, waiting for a counterpart. */
  readonly parked: number
  /** Pairs currently spliced. */
  readonly active: number
  /** Total successful splices over the server's lifetime. */
  readonly totalSplices: number
  /** Total connections refused (bad request, rate limit, token-in-use, park/idle timeout). */
  readonly refused: number
}

export interface RendezvousServer {
  /** The underlying Node HTTP server (WS upgrades are attached to it). */
  readonly httpServer: Server
  /** Start listening. Resolves with the bound address. */
  listen(port: number, host?: string): Promise<{ port: number; host: string }>
  /** Stop listening and tear down every parked/spliced socket. */
  close(): Promise<void>
  readonly stats: RendezvousStats
}

const DEFAULTS = {
  path: "/v1",
  parkTimeoutMs: 120_000,
  idleTimeoutMs: 900_000,
  maxMessageBytes: 1024 * 1024,
  rateLimit: { max: 120, windowMs: 60_000 },
} as const

/** A token can carry at most this many characters. A 16-byte token is 22 b64url
 *  chars; day-scoped tokens are the same. Anything much longer is junk and we
 *  refuse it before allocating any per-token state. */
const MAX_TOKEN_LEN = 128

type Side = "daemon" | "client"

interface Parked {
  side: Side
  token: string
  ws: WebSocket
  parkTimer: ReturnType<typeof setTimeout>
}

export function createRendezvousServer(
  opts: RendezvousServerOptions = {},
): RendezvousServer {
  const path = opts.path ?? DEFAULTS.path
  const parkTimeoutMs = opts.parkTimeoutMs ?? DEFAULTS.parkTimeoutMs
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs
  const maxMessageBytes = opts.maxMessageBytes ?? DEFAULTS.maxMessageBytes
  const now = opts.now ?? Date.now
  const log = opts.onLog ?? (() => {})
  const rateLimiter: RateLimiter = createRateLimiter({
    max: opts.rateLimit?.max ?? DEFAULTS.rateLimit.max,
    windowMs: opts.rateLimit?.windowMs ?? DEFAULTS.rateLimit.windowMs,
    ...(opts.rateLimit?.maxKeys ? { maxKeys: opts.rateLimit.maxKeys } : {}),
  })

  /** token → the one side currently parked on it. */
  const waiting = new Map<string, Parked>()
  /** tokens with a live splice — refuse a third socket for these. */
  const active = new Set<string>()

  let totalSplices = 0
  let refused = 0

  const httpServer = createServer((_req, res) => {
    // The broker speaks only WebSocket. A plain HTTP GET (health probe,
    // curiosity) gets a terse 426 rather than hanging.
    res.writeHead(426, { "content-type": "text/plain" })
    res.end("Upgrade Required — this is a WebSocket rendezvous endpoint.\n")
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes })

  httpServer.on("upgrade", (req, socket, head) => {
    // Rate-limit by the REAL socket address — never a forwardable header, which
    // a caller could rotate to defeat the limit. Applied before we allocate any
    // per-token state so a flood can't cost more than the digest of an IP.
    const ip = req.socket.remoteAddress ?? "unknown"
    if (!rateLimiter.allow(ip)) {
      refused++
      log(`[rendezvous] rate-limited upgrade from ${ip}`)
      rejectUpgrade(socket, 429, "rate_limited")
      return
    }

    const parsed = parseUpgrade(req, path)
    if (!parsed) {
      refused++
      rejectUpgrade(socket, 400, "bad_request")
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      onConnection(ws, parsed.side, parsed.token, ip)
    })
  })

  function onConnection(ws: WebSocket, side: Side, token: string, ip: string): void {
    const parked = waiting.get(token)

    if (parked) {
      if (parked.side === side) {
        // Same side already parked on this token — a collision or a hijack
        // attempt. Refuse the newcomer; the legitimate parked socket keeps
        // waiting for its actual counterpart.
        refused++
        log(`[rendezvous] refused ${side} on token in-use (same side) from ${ip}`)
        closeWs(ws, RV_CLOSE.tokenInUse, "token_in_use")
        return
      }
      // Counterpart found. Defence-in-depth constant-time compare before we
      // commit to splicing (the map lookup already matched, but this removes
      // any lookup-timing signal).
      if (!timingSafeEqualStrings(token, parked.token)) {
        refused++
        closeWs(ws, RV_CLOSE.badRequest, "token_mismatch")
        return
      }
      waiting.delete(token)
      clearTimeout(parked.parkTimer)
      splice(parked, { side, ws }, token)
      return
    }

    if (active.has(token)) {
      // A live pair already owns this token — no third wheel.
      refused++
      log(`[rendezvous] refused ${side} on active token from ${ip}`)
      closeWs(ws, RV_CLOSE.tokenInUse, "token_in_use")
      return
    }

    // First arrival: park and wait for the counterpart.
    const parkTimer = setTimeout(() => {
      if (waiting.get(token)?.ws === ws) {
        waiting.delete(token)
        refused++
        log(`[rendezvous] park timeout for ${side} token from ${ip}`)
        closeWs(ws, RV_CLOSE.parkTimeout, "park_timeout")
      }
    }, parkTimeoutMs)
    if (typeof parkTimer.unref === "function") parkTimer.unref()

    const entry: Parked = { side, token, ws, parkTimer }
    waiting.set(token, entry)

    // If the parked socket drops before its counterpart arrives, stop tracking
    // it so a later same-token connect isn't wrongly refused as "in use".
    ws.on("close", () => {
      if (waiting.get(token) === entry) {
        clearTimeout(parkTimer)
        waiting.delete(token)
      }
    })
    ws.on("error", () => {
      if (waiting.get(token) === entry) {
        clearTimeout(parkTimer)
        waiting.delete(token)
      }
    })
  }

  function splice(
    a: { side: Side; ws: WebSocket },
    b: { side: Side; ws: WebSocket },
    token: string,
  ): void {
    active.add(token)
    totalSplices++
    log(`[rendezvous] spliced token (${a.side} ↔ ${b.side})`)

    let torn = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const teardown = (code: number, reason: string): void => {
      if (torn) return
      torn = true
      if (idleTimer) clearTimeout(idleTimer)
      active.delete(token)
      closeWs(a.ws, code, reason)
      closeWs(b.ws, code, reason)
    }

    const bumpIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => teardown(RV_CLOSE.idleTimeout, "idle_timeout"), idleTimeoutMs)
      if (idleTimer && typeof idleTimer.unref === "function") idleTimer.unref()
    }
    bumpIdle()

    // Pipe verbatim. `data` is a Buffer (ws with binary/text); `isBinary`
    // preserves the frame type so we're a faithful byte-splicer, not a
    // JSON-aware proxy. We NEVER inspect the payload.
    const pipe = (from: WebSocket, to: WebSocket): void => {
      from.on("message", (data: Buffer, isBinary: boolean) => {
        bumpIdle()
        if (to.readyState === to.OPEN) {
          to.send(data, { binary: isBinary })
        }
      })
      from.on("close", (code: number, reasonBuf: Buffer) => {
        teardown(RV_CLOSE.peerClosed, reasonBuf.length ? reasonBuf.toString("utf8") : "peer_closed")
      })
      from.on("error", () => teardown(RV_CLOSE.peerClosed, "peer_error"))
    }
    pipe(a.ws, b.ws)
    pipe(b.ws, a.ws)
  }

  async function close(): Promise<void> {
    for (const parked of waiting.values()) {
      clearTimeout(parked.parkTimer)
      closeWs(parked.ws, 1001, "server_shutdown")
    }
    waiting.clear()
    for (const client of wss.clients) {
      closeWs(client, 1001, "server_shutdown")
    }
    active.clear()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) => {
      httpServer.close(err => (err ? reject(err) : resolve()))
    })
  }

  return {
    httpServer,
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        httpServer.once("error", onError)
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError)
          const addr = httpServer.address()
          if (addr && typeof addr === "object") {
            resolve({ port: addr.port, host: addr.address })
          } else {
            resolve({ port, host })
          }
        })
      })
    },
    close,
    stats: {
      get parked() {
        return waiting.size
      },
      get active() {
        return active.size
      },
      get totalSplices() {
        return totalSplices
      },
      get refused() {
        return refused
      },
    },
  }
}

/** Parse + validate the upgrade request. Returns null for anything malformed. */
function parseUpgrade(
  req: IncomingMessage,
  expectedPath: string,
): { side: Side; token: string } | null {
  let url: URL
  try {
    url = new URL(req.url ?? "/", "http://rendezvous.local")
  } catch {
    return null
  }
  if (url.pathname !== expectedPath) return null
  const side = url.searchParams.get("side")
  const token = url.searchParams.get("t")
  if (side !== "daemon" && side !== "client") return null
  if (!token || token.length === 0 || token.length > MAX_TOKEN_LEN) return null
  return { side, token }
}

function closeWs(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Socket may already be closing; a terminate backstop keeps us from
    // leaking a half-open connection.
    try {
      ws.terminate()
    } catch {
      /* nothing more to do */
    }
  }
}

/** Reject a pre-handshake upgrade with a raw HTTP status, then destroy the
 *  socket (matching the pattern in the runtime's http-server upgrade path). */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const statusText =
    status === 429 ? "Too Many Requests" : status === 400 ? "Bad Request" : "Forbidden"
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        `content-type: text/plain\r\n` +
        `connection: close\r\n` +
        `\r\n` +
        `${reason}\n`,
    )
  } catch {
    /* socket already gone */
  }
  socket.destroy()
}
