/**
 * `connect(credential)` — a long-lived, self-healing tunnel to a paired
 * daemon, with a WHATWG `fetch` on top.
 *
 * Connection: the CLI's `openPairChannel` sequence (epoch routing token for
 * today, then yesterday's to bridge clock skew; a fresh handshake each time),
 * kept up with jittered, capped exponential backoff. A live channel is watched
 * with ping/pong so a half-open socket is noticed.
 *
 * State (for a UI): `connecting` → `open`; on failure or drop → `offline`
 * (while waiting to retry) → `connecting` …; `revoked`, `outdated` and
 * `closed` are terminal. `revoked` is only ever entered on the daemon's
 * authenticated `pairing_revoked` frame — never on anything the broker could
 * fake — and stops all retries. `outdated` means the credential predates
 * pair/v2 (it is never dialed) or the daemon said so, authenticated, the same
 * way.
 *
 * Tokens (pair/v2): each attempt derives the epoch ROUTE — the only value on
 * the broker URL — and the epoch AUTH, which is sealed into the hello and
 * never leaves it.
 *
 * Requests: `http_request` frames multiplexed over the one channel by `reqId`.
 * The response resolves at the daemon's `http_response` (buffered) or
 * `http_response_head` (streamed: SSE / NDJSON), whose body is then a
 * `ReadableStream` fed chunk by chunk as `http_response_chunk` frames arrive.
 * Aborting (the request's signal, or cancelling the body) sends
 * `http_cancel`. In-flight requests fail with `disconnected` when the channel
 * drops; new ones wait for the (re)connection, up to `requestWaitMs`.
 */

import {
  MAX_FRAME_PAYLOAD_BYTES,
  decodeData,
  encodeData,
  splitPayload,
  type E2eFrameSink,
  type HelloFrame,
  type TunnelFrame,
} from "@agentproto/acp/tunnel/browser"
import { currentEpoch, deriveEpochTokens, PAIR_VERSION } from "@agentproto/secrets/pairing/browser"
import {
  defaultWebSocket,
  openChannel,
  PAIRING_REVOKED_CODE,
  type ChannelTimeouts,
  type WebSocketConstructor,
} from "./channel.js"
import type { CredentialStore, PairCredential } from "./credential.js"
import { errMsg, outdatedError, revokedError, TunnelClientError } from "./errors.js"

export type ConnectionState = "connecting" | "open" | "offline" | "revoked" | "outdated" | "closed"

export interface ConnectOptions extends ChannelTimeouts {
  /** WebSocket constructor. Default: the global `WebSocket`. */
  WebSocket?: WebSocketConstructor
  /** When set, `lastSeen` is refreshed there after each (re)connect
   *  (best-effort, as the CLI does). */
  store?: CredentialStore
  /** First retry delay. Default 500ms. */
  reconnectMinMs?: number
  /** Retry delay ceiling. Default 30s. */
  reconnectMaxMs?: number
  /** How long a request waits for a connection before failing `offline`.
   *  Default 20s. */
  requestWaitMs?: number
  /** Ping interval on a live channel. Default 25s; `0` disables. */
  keepAliveMs?: number
  /** A ping unanswered this long drops the channel (and reconnects).
   *  Default 10s. */
  pongTimeoutMs?: number
  /** Map a request URL to the daemon path (path + query, must start with `/`).
   *  Default: `url.pathname + url.search`. A service worker uses this to strip
   *  its scope prefix. */
  mapPath?: (url: URL) => string
  /** Clock (ms). Default `Date.now`. */
  now?: () => number
  /** Random source for backoff jitter, in [0, 1). Default `Math.random`. */
  random?: () => number
}

export interface StateChange {
  state: ConnectionState
  /** Why we're `offline` / `revoked` / `outdated` / `closed` (the last failure). */
  error?: TunnelClientError
}

export interface TunnelClient {
  /** The pairing this client serves. */
  readonly credential: PairCredential
  readonly state: ConnectionState
  /** The daemon's hello on the current (or last) channel. */
  readonly hello: HelloFrame | null
  /** The most recent connection failure, if any. */
  readonly lastError: TunnelClientError | null
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: (change: StateChange) => void): () => void
  /** Resolves once connected; rejects with `revoked` / `protocol_outdated` /
   *  `closed`, or `offline`
   *  when no connection came up within `requestWaitMs`. */
  ready(): Promise<void>
  /** A WHATWG `fetch` through the daemon. Relative URLs are fine: only the
   *  path + query (see `mapPath`) is sent. Rejects with `TunnelClientError`
   *  (`offline` / `disconnected` / `revoked` / `protocol_outdated` / `closed`)
   *  where `fetch` would
   *  reject with a network error, or with the signal's reason on abort. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  /** Skip the current backoff wait and retry now (e.g. on `online`). */
  reconnect(): void
  /** Close the channel and stop reconnecting. Pending requests fail `closed`.
   *  The state becomes `closed`, except that a terminal `revoked` / `outdated`
   *  is kept (with its `lastError`). */
  close(): void
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])
/** Response headers that describe the daemon↔upstream hop, not this body. */
const DROP_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "content-encoding", "content-length", "keep-alive"])
const BASE = "http://tunnel.invalid"

interface Pending {
  /** Before the head: settle the `fetch` promise. */
  resolve(res: Response): void
  reject(err: unknown): void
  /** After a streamed head: the body's controller. */
  controller: ReadableStreamDefaultController<Uint8Array> | null
  settled: boolean
  detach(): void
}

interface Live {
  sink: E2eFrameSink
  pending: Map<string, Pending>
}

/**
 * Connect to a paired daemon. Returns immediately; the client connects in the
 * background (watch `state` / `onStateChange`, or `await client.ready()`).
 * One client per credential: the daemon keeps one standing channel per epoch
 * slot, so share this instance rather than connecting twice.
 */
export function connect(credential: PairCredential, opts: ConnectOptions = {}): TunnelClient {
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const WebSocketImpl = opts.WebSocket ?? defaultWebSocket()
  const minMs = opts.reconnectMinMs ?? 500
  const maxMs = opts.reconnectMaxMs ?? 30_000
  const requestWaitMs = opts.requestWaitMs ?? 20_000
  const keepAliveMs = opts.keepAliveMs ?? 25_000
  const pongTimeoutMs = opts.pongTimeoutMs ?? 10_000
  const mapPath = opts.mapPath ?? ((url: URL) => `${url.pathname}${url.search}`)
  const reqPrefix = Math.floor(random() * 0x100000000).toString(36)

  let state: ConnectionState = "connecting"
  let lastError: TunnelClientError | null = null
  let hello: HelloFrame | null = null
  let live: Live | null = null
  let stopped = false
  let seq = 0
  const listeners = new Set<(change: StateChange) => void>()
  /** Wakes the backoff sleep early (reconnect() / close()). */
  let wake: (() => void) | null = null

  const notify = (change: StateChange): void => {
    for (const l of [...listeners]) {
      try {
        l(change)
      } catch {
        /* a listener must not break the client */
      }
    }
  }

  const setState = (next: ConnectionState, error?: TunnelClientError): void => {
    if (error) lastError = error
    if (next === state && !error) return
    state = next
    notify(error ? { state, error } : { state })
  }

  const failPending = (l: Live, err: TunnelClientError): void => {
    for (const [, p] of l.pending) {
      p.detach()
      if (!p.settled) {
        p.settled = true
        p.reject(err)
      } else if (p.controller) {
        try {
          p.controller.error(err)
        } catch {
          /* already closed */
        }
      }
    }
    l.pending.clear()
  }

  // ── connection loop ──────────────────────────────────────────────

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        wake = null
        resolve()
      }
      wake = done
    })

  /** One attempt: today's epoch token, then yesterday's. */
  async function establish(): Promise<{ sink: E2eFrameSink; hello: HelloFrame; route: (h: (f: TunnelFrame) => void) => void }> {
    const epoch = currentEpoch(now())
    let lastErr: unknown
    for (const e of [epoch, epoch - 1]) {
      if (stopped) break
      try {
        const { route, auth } = await deriveEpochTokens(credential.pairRoot, e)
        const ch = await openChannel({
          rendezvousUrl: credential.rendezvousUrl,
          route,
          auth,
          daemonX25519Pub: credential.daemonX25519Pub,
          daemonEd25519Pub: credential.daemonEd25519Pub,
          clientName: credential.clientName,
          WebSocket: WebSocketImpl,
          ...(opts.dialTimeoutMs !== undefined ? { dialTimeoutMs: opts.dialTimeoutMs } : {}),
          ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
          ...(opts.greetingTimeoutMs !== undefined ? { greetingTimeoutMs: opts.greetingTimeoutMs } : {}),
        })
        if (ch.greeting.kind === "revoked") {
          ch.sink.close("revoked")
          throw revokedError(credential.name)
        }
        if (ch.greeting.kind === "outdated") {
          ch.sink.close("outdated")
          throw outdatedError(`this device's pairing with ${credential.name}`)
        }
        return { sink: ch.sink, hello: ch.greeting.hello, route: ch.route }
      } catch (err) {
        if (err instanceof TunnelClientError && (err.code === "revoked" || err.code === "protocol_outdated")) throw err
        lastErr = err
      }
    }
    throw new TunnelClientError(
      "offline",
      `could not reach ${credential.name} via ${credential.rendezvousUrl}: ${errMsg(lastErr)}`,
      { cause: lastErr },
    )
  }

  /** Serve one live channel until it closes. Resolves with the revocation
   *  error if the daemon revoked us mid-channel. */
  function serve(ch: Awaited<ReturnType<typeof establish>>): Promise<TunnelClientError | null> {
    const l: Live = { sink: ch.sink, pending: new Map() }
    live = l
    hello = ch.hello
    let revoked: TunnelClientError | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pongTimer: ReturnType<typeof setTimeout> | null = null
    let pingSeq = 0

    return new Promise(resolve => {
      ch.route(frame => {
        switch (frame.t) {
          case "http_response":
          case "http_response_head":
          case "http_response_chunk":
            onHttpFrame(l, frame)
            return
          case "pong":
            if (pongTimer) clearTimeout(pongTimer)
            pongTimer = null
            return
          case "ping":
            l.sink.send({ t: "pong", nonce: frame.nonce })
            return
          case "error":
            if (frame.code === PAIRING_REVOKED_CODE) {
              revoked = revokedError(credential.name)
              l.sink.close("revoked")
            }
            return
          default:
            return
        }
      })
      if (keepAliveMs > 0) {
        pingTimer = setInterval(() => {
          if (pongTimer) return
          l.sink.send({ t: "ping", nonce: `ka-${++pingSeq}` })
          pongTimer = setTimeout(() => l.sink.close("keepalive timeout"), pongTimeoutMs)
        }, keepAliveMs)
      }
      l.sink.onClose(() => {
        if (pingTimer) clearInterval(pingTimer)
        if (pongTimer) clearTimeout(pongTimer)
        if (live === l) live = null
        failPending(
          l,
          revoked ??
            (stopped
              ? new TunnelClientError("closed", "the tunnel client was closed")
              : new TunnelClientError("disconnected", `lost the connection to ${credential.name}`)),
        )
        resolve(revoked)
      })
      if (!l.sink.isOpen) {
        // Closed between the greeting and now: onClose already fired.
        failPending(l, new TunnelClientError("disconnected", `lost the connection to ${credential.name}`))
        resolve(revoked)
      }
    })
  }

  async function run(): Promise<void> {
    let attempt = 0
    while (!stopped) {
      setState("connecting")
      let ch: Awaited<ReturnType<typeof establish>>
      try {
        ch = await establish()
      } catch (err) {
        if (stopped) return
        const e = err instanceof TunnelClientError ? err : new TunnelClientError("offline", errMsg(err), { cause: err })
        if (e.code === "revoked") {
          setState("revoked", e)
          return
        }
        if (e.code === "protocol_outdated") {
          setState("outdated", e)
          return
        }
        setState("offline", e)
        await sleep(backoff(attempt++))
        continue
      }
      if (stopped) {
        ch.sink.close("client closed")
        return
      }
      attempt = 0
      const closed = serve(ch)
      setState("open")
      if (opts.store) {
        void opts.store.put({ ...credential, lastSeen: new Date(now()).toISOString() }).catch(() => {})
      }
      const revoked = await closed
      if (stopped) return
      if (revoked) {
        setState("revoked", revoked)
        return
      }
      // Let the daemon re-park on the token before we come back.
      setState("offline", new TunnelClientError("disconnected", `lost the connection to ${credential.name}`))
      await sleep(backoff(attempt++))
    }
  }

  /** Jittered ("equal jitter") capped exponential backoff. */
  function backoff(n: number): number {
    const cap = Math.min(maxMs, minMs * 2 ** Math.min(n, 30))
    return cap / 2 + random() * (cap / 2)
  }

  // ── requests ─────────────────────────────────────────────────────

  function onHttpFrame(
    l: Live,
    frame: Extract<TunnelFrame, { t: "http_response" | "http_response_head" | "http_response_chunk" }>,
  ): void {
    const p = l.pending.get(frame.reqId)
    if (!p) return // cancelled / unknown — drop
    if (frame.t === "http_response") {
      l.pending.delete(frame.reqId)
      p.detach()
      if (p.settled) return
      p.settled = true
      let body: Uint8Array | null = frame.body ? decodeData(frame.body) : null
      if (!body?.length && frame.error) {
        body = new TextEncoder().encode(JSON.stringify({ error: frame.error.code, message: frame.error.message }))
      }
      p.resolve(makeResponse(frame.status, frame.headers, body))
      return
    }
    if (frame.t === "http_response_head") {
      if (p.settled) return
      p.settled = true
      const stream = new ReadableStream<Uint8Array>({
        start: c => {
          p.controller = c
        },
        cancel: () => {
          // The consumer gave up on the body (EventSource closed, reader
          // cancelled): stop the daemon's upstream too.
          if (l.pending.get(frame.reqId) === p) {
            l.pending.delete(frame.reqId)
            p.detach()
            l.sink.send({ t: "http_cancel", reqId: frame.reqId })
          }
        },
      })
      p.resolve(makeResponse(frame.status, frame.headers, stream))
      return
    }
    // http_response_chunk
    const c = p.controller
    if (!c) return
    try {
      if (frame.data) c.enqueue(decodeData(frame.data))
      if (frame.error) {
        l.pending.delete(frame.reqId)
        p.detach()
        c.error(new TunnelClientError("stream_error", `${frame.error.code}: ${frame.error.message}`))
      } else if (frame.end) {
        l.pending.delete(frame.reqId)
        p.detach()
        c.close()
      }
    } catch {
      /* the consumer cancelled; the cancel hook already cleaned up */
    }
  }

  function waitForLive(signal: AbortSignal): Promise<Live> {
    if (state === "open" && live) return Promise.resolve(live)
    if (state === "revoked") return Promise.reject(lastError ?? revokedError(credential.name))
    if (state === "outdated") return Promise.reject(lastError ?? outdatedError(`this device's pairing with ${credential.name}`))
    if (state === "closed") return Promise.reject(new TunnelClientError("closed", "the tunnel client was closed"))
    return new Promise((resolve, reject) => {
      const done = (fn: () => void): void => {
        clearTimeout(timer)
        off()
        signal.removeEventListener("abort", onAbort)
        fn()
      }
      const timer = setTimeout(
        () =>
          done(() =>
            reject(
              new TunnelClientError(
                "offline",
                `${credential.name} is unreachable (no connection within ${requestWaitMs}ms)` +
                  (lastError ? `: ${lastError.message}` : ""),
                lastError ? { cause: lastError } : undefined,
              ),
            ),
          ),
        requestWaitMs,
      )
      const onAbort = (): void => done(() => reject(signal.reason))
      signal.addEventListener("abort", onAbort)
      const off = onStateChangeImpl(({ state: s, error }) => {
        if (s === "open" && live) {
          const l = live
          done(() => resolve(l))
        } else if (s === "revoked" || s === "outdated" || s === "closed") {
          done(() =>
            reject(
              error ??
                new TunnelClientError(s === "outdated" ? "protocol_outdated" : s, `the tunnel client is ${s}`),
            ),
          )
        }
      })
    })
  }

  async function tunnelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request =
      input instanceof Request
        ? init
          ? new Request(input, init)
          : input
        : new Request(new URL(String(input), BASE), init)
    const signal = request.signal
    if (signal.aborted) throw signal.reason
    const method = request.method.toUpperCase()
    const body =
      method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer())
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const path = mapPath(new URL(request.url))
    if (!path.startsWith("/")) throw new TypeError(`tunnel path must start with "/" (got "${path}")`)

    const l = await waitForLive(signal)
    if (signal.aborted) throw signal.reason
    // Closed in the gap since it was handed to us: the close sweep may already
    // have run, so a request registered now would never be failed.
    if (!l.sink.isOpen) {
      throw new TunnelClientError("disconnected", `lost the connection to ${credential.name}`)
    }
    const reqId = `${reqPrefix}-${(++seq).toString(36)}`

    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        const p = l.pending.get(reqId)
        if (!p) return
        l.pending.delete(reqId)
        p.detach()
        l.sink.send({ t: "http_cancel", reqId })
        if (!p.settled) {
          p.settled = true
          reject(signal.reason)
        } else {
          try {
            p.controller?.error(signal.reason)
          } catch {
            /* already closed */
          }
        }
      }
      const pending: Pending = {
        resolve,
        reject,
        controller: null,
        settled: false,
        detach: () => signal.removeEventListener("abort", onAbort),
      }
      l.pending.set(reqId, pending)
      signal.addEventListener("abort", onAbort)
      const base = {
        t: "http_request" as const,
        reqId,
        method,
        path,
        ...(Object.keys(headers).length ? { headers } : {}),
      }
      if (body && body.length > MAX_FRAME_PAYLOAD_BYTES && hello?.capabilities.httpRequestChunks === true) {
        // One frame this size would exceed the rendezvous' message cap once
        // E2E-wrapped (and kill the channel): stream it in bounded chunks.
        l.sink.send({ ...base, bodyChunked: true })
        const pieces = splitPayload(body)
        pieces.forEach((piece, i) => {
          l.sink.send({
            t: "http_request_chunk",
            reqId,
            data: encodeData(piece),
            ...(i === pieces.length - 1 ? { end: true } : {}),
          })
        })
      } else {
        l.sink.send({ ...base, ...(body && body.length ? { body: encodeData(body) } : {}) })
      }
    })
  }

  // ── public surface ───────────────────────────────────────────────

  function onStateChangeImpl(listener: (change: StateChange) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // A credential from before pair/v2 is never dialed: the daemon won't serve
  // it, and a v2 hello can't even reach its re-pair notice.
  if (credential.protocol !== PAIR_VERSION) {
    setState("outdated", outdatedError(`this device's pairing with ${credential.name}`))
    // That happened inside connect(), before anyone could subscribe: replay it
    // to the listeners attached in the same tick, so onStateChange fires.
    queueMicrotask(() => {
      if (state === "outdated" && lastError) notify({ state, error: lastError })
    })
  } else void run().catch(err => {
    setState("offline", new TunnelClientError("offline", errMsg(err), { cause: err }))
  })

  return {
    credential,
    get state() {
      return state
    },
    get hello() {
      return hello
    },
    get lastError() {
      return lastError
    },
    onStateChange: onStateChangeImpl,
    ready() {
      return waitForLive(new AbortController().signal).then(() => undefined)
    },
    fetch: tunnelFetch,
    reconnect() {
      wake?.()
    },
    close() {
      if (stopped) return
      stopped = true
      wake?.()
      const l = live
      live = null
      if (l) {
        failPending(l, new TunnelClientError("closed", "the tunnel client was closed"))
        l.sink.close("client closed")
      }
      // `revoked` / `outdated` are terminal verdicts a UI must keep showing
      // (with lastError): closing the client doesn't turn them into "closed".
      if (state !== "revoked" && state !== "outdated") setState("closed")
    },
  }
}

function makeResponse(
  status: number,
  headers: Readonly<Record<string, string>> | undefined,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
): Response {
  const h = new Headers()
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue
    try {
      h.append(k, v)
    } catch {
      /* a header the platform refuses to set on a synthetic Response */
    }
  }
  // Response() only takes 200–599; anything else from the daemon is a bad
  // gateway from the page's point of view.
  const s = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502
  if (NULL_BODY_STATUS.has(s)) {
    if (body instanceof ReadableStream) void body.cancel().catch(() => {})
    return new Response(null, { status: s, headers: h })
  }
  return new Response(body as BodyInit | null, { status: s, headers: h })
}
