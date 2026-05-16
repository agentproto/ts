/**
 * Tunnel server (daemon side).
 *
 * Sits on the local machine that actually owns the binaries (e.g. the
 * user's laptop running `agentproto serve`). Accepts spawn frames from
 * a remote host, spawns the requested child via node:child_process,
 * pipes stdio back as `stdout`/`stderr` frames, and reports lifecycle
 * via `spawned`/`exit`/`error`.
 *
 * Transport-agnostic: the caller passes a `FrameSink`. For WebSocket
 * callers, see `wrapWebSocket()` in ./ws-adapter.ts.
 *
 * Security: this process MUST refuse spawn requests by default unless
 * the caller installed an `authorize(spawn)` hook. We don't expose a
 * "trust everything" mode — every host integration is responsible for
 * deciding what the remote may exec. The hook gets the full SpawnFrame
 * and can mutate it (e.g. force `cwd` into a workspace) or reject.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { hostname, platform } from "node:os"
import {
  TUNNEL_VERSION,
  decodeData,
  encodeData,
  encodeFrame,
  parseFrame,
  type ExitFrame,
  type HttpRequestFrame,
  type HttpResponseFrame,
  type SpawnFrame,
  type StderrFrame,
  type StdoutFrame,
  type TunnelFrame,
  type WsOpenFrame,
} from "./frames.js"
import type { FrameSink } from "./transport.js"

export interface TunnelServerOptions {
  sink: FrameSink
  /**
   * Authorization hook. Called for each `spawn` frame BEFORE the
   * subprocess is created. Return the (possibly mutated) frame to
   * proceed; throw or return null to reject. Rejection causes an
   * `error` frame with code "spawn_unauthorized".
   *
   * No default — callers MUST decide. Pass `(req) => req` to allow
   * everything (useful for tests; never for production).
   */
  authorize: (req: SpawnFrame) => SpawnFrame | null | Promise<SpawnFrame | null>
  /**
   * Upstream HTTP base URL for `http_request` frames. The daemon
   * appends the frame's `path` and forwards. Typically the local
   * gateway address — `http://127.0.0.1:18790`. When omitted, the
   * daemon replies to any `http_request` with
   * `error: { code: "http_upstream_not_configured" }`.
   */
  httpUpstream?: string
  /** User-friendly label sent in the hello frame. */
  label?: string
  /**
   * Whether this daemon advertises PTY support. Set to true only when
   * `spawnPty` is also provided.
   */
  pty?: boolean
  /**
   * Factory for PTY-backed processes. When provided (and `pty: true`),
   * spawn frames with `pty: true` use this instead of node:child_process.
   * Injected from the CLI layer so the ACP package stays native-free.
   */
  spawnPty?: (opts: {
    command: string
    args: string[]
    cwd?: string
    env?: Record<string, string>
    cols: number
    rows: number
  }) => PtyProcess
  /**
   * Optional hook fired once per successful spawn — after authorize
   * passed and the ChildProcess has emitted its `spawn` event.
   * Lets the daemon adopt this child into a higher-level registry
   * (e.g. @agentproto/runtime's sessions registry, AIP-46) so the
   * spawn shows up in /sessions, the LocalDaemonSessionsCard, and
   * the CLI TUI alongside spawns originated locally.
   *
   * The hook is fire-and-forget — the tunnel doesn't await its
   * return. Errors from the hook are swallowed so an observer
   * registry hiccup never breaks the tunnel exchange.
   */
  onChildSpawned?: (info: {
    execId: string
    child: ChildProcess
    request: SpawnFrame
  }) => void
  /**
   * Optional hook fired when the host sends a `reconnect_soon` frame —
   * graceful drain signal during host rollover. The daemon SHOULD
   * close + reconnect immediately (skipping any backoff) so the new
   * host replica picks it up. Default: ignore (the host follows up
   * with `close(1012)` and the daemon's own reconnect supervisor
   * handles it via normal backoff, ~30 s gap).
   *
   * Implementations typically call into their connection supervisor
   * to mark the next reconnect as "no-backoff" then close the sink.
   * `reasonMs` is the host's hint for how long it will wait before
   * forcing close — daemons MAY use it to drain in-flight RPCs first.
   */
  onReconnectSoon?: (info: { reasonMs?: number }) => void
  /**
   * Factory that dials a WS connection to the local upstream. When
   * provided (and `httpUpstream` is set), the daemon advertises
   * `wsForward` capability and handles `ws_open` frames by piping the
   * upstream WS through the tunnel. Injected so `@agentproto/acp`
   * stays free of a hard `ws` dependency — the CLI provides this
   * factory using its already-pulled-in `ws` package.
   */
  dialUpstreamWs?: (params: {
    url: string
    protocols?: readonly string[]
    headers?: Readonly<Record<string, string>>
  }) => Promise<UpstreamWebSocket>
}

/**
 * Minimal upstream WS surface — satisfied by the `ws` library's
 * client socket. Daemons supplying `dialUpstreamWs` resolve into
 * one of these as soon as the WS is OPEN. `protocol` is the
 * subprotocol negotiated by the upstream (empty string when none).
 */
export interface UpstreamWebSocket {
  readonly protocol: string
  /** Send a frame to the upstream. */
  send(data: Buffer | string, opts: { binary: boolean }): void
  /** Close the upstream connection. */
  close(code?: number, reason?: string): void
  /** Subscribe to inbound frames. */
  onMessage(handler: (data: Buffer, isBinary: boolean) => void): void
  /** Subscribe to upstream close. */
  onClose(handler: (code: number, reason: string) => void): void
  /** Subscribe to transport errors. */
  onError(handler: (err: Error) => void): void
}

/** Minimal PTY process surface — satisfied by node-pty's IPty. */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(handler: (data: string) => void): void
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): void
}

export interface TunnelServer {
  /** Currently-live execId → ChildProcess. Read-only diagnostic. */
  readonly children: ReadonlyMap<string, ChildProcess>
  /** Kill all live children and close the sink. */
  close(): Promise<void>
}

export function createTunnelServer(opts: TunnelServerOptions): TunnelServer {
  const children = new Map<string, ChildProcess>()
  // PTY-backed processes keyed by execId (separate from pipe-based children).
  const ptyProcs = new Map<string, PtyProcess>()
  // Per-reqId map of bridged upstream WS connections. Each entry's
  // lifecycle starts at ws_open (we send open_ack on success) and ends
  // at ws_close (either direction). On tunnel teardown we close all.
  const upstreamWs = new Map<string, UpstreamWebSocket>()
  let closed = false

  // Greet the host immediately so it can fail fast on version
  // mismatch before issuing spawns.
  opts.sink.send({
    t: "hello",
    version: TUNNEL_VERSION,
    capabilities: {
      pty: opts.pty === true,
      wsForward: opts.dialUpstreamWs !== undefined && !!opts.httpUpstream,
    },
    label: opts.label,
    daemon: {
      name: "agentproto",
      version: "0.1.0-alpha",
      platform: `${platform()}/${hostname()}`,
      nodeVersion: process.version,
    },
  })

  const offFrame = opts.sink.onFrame((frame) => {
    handleFrame(frame).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      opts.sink.send({ t: "error", code: "internal", message })
    })
  })

  const offClose = opts.sink.onClose(() => {
    closed = true
    for (const [, child] of children) child.kill("SIGTERM")
    children.clear()
    for (const [, pty] of ptyProcs) pty.kill()
    ptyProcs.clear()
    for (const [, ws] of upstreamWs) {
      try {
        ws.close(1001, "tunnel_closed")
      } catch {
        /* socket may already be dead */
      }
    }
    upstreamWs.clear()
    offFrame()
    offClose()
  })

  async function handleFrame(frame: TunnelFrame): Promise<void> {
    switch (frame.t) {
      case "spawn":
        await handleSpawn(frame)
        return
      case "stdin": {
        const pty = ptyProcs.get(frame.execId)
        if (pty) {
          pty.write(Buffer.from(frame.data, "base64").toString("utf8"))
          return
        }
        const child = children.get(frame.execId)
        if (!child || !child.stdin) {
          opts.sink.send({
            t: "error",
            execId: frame.execId,
            code: "unknown_exec",
            message: `No live exec '${frame.execId}'`,
          })
          return
        }
        child.stdin.write(Buffer.from(frame.data, "base64"))
        return
      }
      case "kill": {
        const pty = ptyProcs.get(frame.execId)
        if (pty) {
          pty.kill(frame.signal ?? "SIGTERM")
          return
        }
        const child = children.get(frame.execId)
        if (!child) {
          opts.sink.send({
            t: "error",
            execId: frame.execId,
            code: "unknown_exec",
            message: `No live exec '${frame.execId}'`,
          })
          return
        }
        child.kill((frame.signal as NodeJS.Signals | undefined) ?? "SIGTERM")
        return
      }
      case "resize": {
        ptyProcs.get(frame.execId)?.resize(frame.cols, frame.rows)
        return
      }
      case "http_request":
        // Fire-and-forget — the handler emits its own http_response
        // frame (or error). Errors that escape handleHttpRequest
        // bubble to the outer .catch and become a generic `error`
        // frame, but the per-request error path inside the handler
        // produces an http_response with `error:` set, which is what
        // the host's forwardHttp expects.
        await handleHttpRequest(frame)
        return
      case "ws_open":
        await handleWsOpen(frame)
        return
      case "ws_message": {
        const ws = upstreamWs.get(frame.reqId)
        if (!ws) {
          // Stale frame for a closed bridge — silently drop. Sending
          // an error frame would race with our own ws_close on the
          // teardown path.
          return
        }
        try {
          ws.send(decodeData(frame.data), { binary: frame.binary === true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          opts.sink.send({
            t: "ws_close",
            reqId: frame.reqId,
            code: 1011,
            reason: `send_failed: ${message}`,
          })
          try {
            ws.close(1011, "send_failed")
          } catch {
            /* defensive */
          }
          upstreamWs.delete(frame.reqId)
        }
        return
      }
      case "ws_close": {
        const ws = upstreamWs.get(frame.reqId)
        if (!ws) return
        upstreamWs.delete(frame.reqId)
        try {
          ws.close(frame.code, frame.reason)
        } catch {
          /* socket may already be dead */
        }
        return
      }
      case "ping":
        opts.sink.send({ t: "pong", nonce: frame.nonce })
        return
      case "reconnect_soon":
        // Host is shutting down this replica (e.g. k8s preStop). Fire
        // the supervisor hook so the daemon CLI can drop the WS +
        // reconnect without exponential backoff. We do NOT close the
        // sink here — that's the supervisor's call (it may want to
        // drain in-flight RPCs first using the `reasonMs` hint).
        try {
          opts.onReconnectSoon?.({
            ...(frame.reasonMs !== undefined ? { reasonMs: frame.reasonMs } : {}),
          })
        } catch {
          /* defensive — supervisor hook must never break the tunnel */
        }
        return
      case "pong":
      case "error":
        // Daemon doesn't act on these; host-side concern.
        return
      default:
        opts.sink.send({
          t: "error",
          code: "unknown_frame",
          message: `Daemon received unexpected frame type '${(frame as { t: string }).t}'`,
        })
    }
  }

  async function handleSpawn(req: SpawnFrame): Promise<void> {
    if (closed) return
    let approved: SpawnFrame | null
    try {
      approved = await opts.authorize(req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      opts.sink.send({
        t: "error",
        execId: req.execId,
        code: "spawn_unauthorized",
        message,
      })
      return
    }
    if (!approved) {
      opts.sink.send({
        t: "error",
        execId: req.execId,
        code: "spawn_unauthorized",
        message: "Authorize hook rejected the spawn request.",
      })
      return
    }

    // PTY path — use injected spawnPty factory when pty:true is requested.
    if (approved.pty && opts.spawnPty) {
      let pty: PtyProcess
      try {
        pty = opts.spawnPty({
          command: approved.command,
          args: [...approved.args],
          cwd: approved.cwd,
          env: approved.env ? { ...approved.env } : undefined,
          cols: approved.cols ?? 80,
          rows: approved.rows ?? 24,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        opts.sink.send({ t: "error", execId: req.execId, code: "spawn_failed", message })
        return
      }

      ptyProcs.set(req.execId, pty)
      opts.sink.send({ t: "spawned", execId: req.execId, pid: pty.pid })

      pty.onData(data => {
        opts.sink.send({ t: "stdout", execId: req.execId, data: encodeData(data) })
      })
      pty.onExit(({ exitCode, signal }) => {
        opts.sink.send({
          t: "exit",
          execId: req.execId,
          code: exitCode,
          signal: signal != null ? String(signal) : null,
        })
        ptyProcs.delete(req.execId)
      })

      if (opts.onChildSpawned) {
        try {
          // PTY processes can't be adopted as ChildProcess — pass a no-op shim
          // so the hook fires (for session visibility) without crashing.
          opts.onChildSpawned({
            execId: req.execId,
            child: { pid: pty.pid } as unknown as ChildProcess,
            request: approved,
          })
        } catch { /* fire-and-forget */ }
      }
      return
    }

    let child: ChildProcess
    try {
      child = spawn(approved.command, [...approved.args], {
        cwd: approved.cwd,
        env: { ...process.env, ...(approved.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        // detached:false so SIGINT/SIGTERM on the daemon kills children too.
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      opts.sink.send({
        t: "error",
        execId: req.execId,
        code: "spawn_failed",
        message,
      })
      return
    }

    children.set(req.execId, child)

    if (typeof child.pid === "number") {
      opts.sink.send({ t: "spawned", execId: req.execId, pid: child.pid })
    } else {
      // Pid is null when spawn synchronously failed. The 'error'
      // event below will fire with the real cause; we still report
      // a placeholder spawned to keep the lifecycle predictable.
      opts.sink.send({ t: "spawned", execId: req.execId, pid: -1 })
    }

    // Notify the higher-level registry (when wired) — this is what
    // makes tunnel-driven spawns visible in the daemon's
    // /sessions list alongside spawns originated locally. Errors
    // from the observer never break the tunnel.
    if (opts.onChildSpawned) {
      try {
        opts.onChildSpawned({ execId: req.execId, child, request: approved })
      } catch (err) {
        // Hook is fire-and-forget — log + continue.
        // Use console.warn directly because tunnel server has no
        // logger context.
        console.warn(
          `[tunnel-server] onChildSpawned hook threw for execId=${req.execId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const f: StdoutFrame = {
        t: "stdout",
        execId: req.execId,
        data: encodeData(chunk),
      }
      opts.sink.send(f)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const f: StderrFrame = {
        t: "stderr",
        execId: req.execId,
        data: encodeData(chunk),
      }
      opts.sink.send(f)
    })

    child.on("error", (err) => {
      opts.sink.send({
        t: "error",
        execId: req.execId,
        code: "child_error",
        message: err.message,
      })
    })

    child.on("exit", (code, signal) => {
      const f: ExitFrame = {
        t: "exit",
        execId: req.execId,
        code,
        signal,
      }
      opts.sink.send(f)
      children.delete(req.execId)
    })
  }

  /**
   * Open a bridged WS connection to the local upstream. Same path-
   * safety rules as `handleHttpRequest` (no absolute URLs, no `..`),
   * same hop-by-hop header stripping. The `dialUpstreamWs` factory
   * resolves to an `UpstreamWebSocket` once the upgrade is OPEN — we
   * then emit `ws_open_ack` to the host and start piping frames.
   */
  async function handleWsOpen(req: WsOpenFrame): Promise<void> {
    if (closed) return
    const reject = (
      status: number,
      code: string,
      message: string
    ): void => {
      opts.sink.send({
        t: "ws_open_ack",
        reqId: req.reqId,
        status,
        error: { code, message },
      })
    }
    if (!opts.dialUpstreamWs || !opts.httpUpstream) {
      reject(
        502,
        "ws_upstream_not_configured",
        "Daemon does not support WS forwarding — start with `--upstream ws://…` (or upgrade)."
      )
      return
    }
    if (
      !req.path.startsWith("/") ||
      req.path.startsWith("//") ||
      req.path.includes("..")
    ) {
      reject(
        400,
        "invalid_path",
        `Daemon WS forward requires a safe relative path; got '${req.path}'.`
      )
      return
    }
    const HOP_BY_HOP = new Set([
      "connection",
      "upgrade",
      "sec-websocket-version",
      "sec-websocket-key",
      "sec-websocket-extensions",
      "sec-websocket-protocol",
      "host",
      "content-length",
    ])
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      headers[k] = v
    }
    // Map the http upstream base to a ws scheme. The daemon's upstream
    // is conventionally http://127.0.0.1:<port>; the same host accepts
    // WS upgrades on the same port, so ws://… works.
    const base = opts.httpUpstream.replace(/^http(s?):\/\//, "ws$1://")
    const url = `${base.replace(/\/$/, "")}${req.path}`
    let upstream: UpstreamWebSocket
    try {
      upstream = await opts.dialUpstreamWs({
        url,
        ...(req.protocols && req.protocols.length > 0
          ? { protocols: req.protocols }
          : {}),
        headers,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Try to extract an HTTP status from a `ws` error like
      // `Unexpected server response: 404`.
      const m = message.match(/Unexpected server response: (\d+)/)
      const status = m ? Number.parseInt(m[1]!, 10) : 502
      reject(status, "upstream_ws_failed", message)
      return
    }
    // Race: caller already abandoned us (tunnel closed mid-upgrade).
    if (closed) {
      try {
        upstream.close(1001, "tunnel_closed")
      } catch {
        /* defensive */
      }
      return
    }
    upstreamWs.set(req.reqId, upstream)
    opts.sink.send({
      t: "ws_open_ack",
      reqId: req.reqId,
      status: 101,
      ...(upstream.protocol ? { protocol: upstream.protocol } : {}),
    })

    upstream.onMessage((data, isBinary) => {
      if (!opts.sink.isOpen) return
      opts.sink.send({
        t: "ws_message",
        reqId: req.reqId,
        data: encodeData(data),
        binary: isBinary,
      })
    })
    upstream.onClose((code, reason) => {
      if (!upstreamWs.has(req.reqId)) return
      upstreamWs.delete(req.reqId)
      if (opts.sink.isOpen) {
        opts.sink.send({
          t: "ws_close",
          reqId: req.reqId,
          code,
          ...(reason ? { reason } : {}),
        })
      }
    })
    upstream.onError(err => {
      // Errors typically precede a close; emit a stable error code in
      // the close frame so the host can distinguish from clean close.
      if (!upstreamWs.has(req.reqId)) return
      upstreamWs.delete(req.reqId)
      if (opts.sink.isOpen) {
        opts.sink.send({
          t: "ws_close",
          reqId: req.reqId,
          code: 1011,
          reason: `upstream_error: ${err.message}`,
        })
      }
      try {
        upstream.close(1011, "upstream_error")
      } catch {
        /* defensive */
      }
    })
  }

  async function handleHttpRequest(req: HttpRequestFrame): Promise<void> {
    if (closed) return
    const respond = (
      partial:
        | { status: number; headers?: HttpResponseFrame["headers"]; body?: string }
        | { error: HttpResponseFrame["error"]; status: number }
    ): void => {
      opts.sink.send({
        t: "http_response",
        reqId: req.reqId,
        ...partial,
      } as HttpResponseFrame)
    }

    // Reject if no upstream is configured. Better explicit error
    // than a confusing 502 from a missing fetch target.
    if (!opts.httpUpstream) {
      respond({
        status: 502,
        error: {
          code: "http_upstream_not_configured",
          message:
            "Daemon was not started with an http upstream — cannot forward HTTP frames.",
        },
      })
      return
    }

    // Path-only is required to keep the daemon from being a generic
    // SSRF amplifier. Absolute URLs (including protocol-relative `//`)
    // and parent-traversal are rejected. Querystrings are fine.
    if (
      !req.path.startsWith("/") ||
      req.path.startsWith("//") ||
      req.path.includes("..")
    ) {
      respond({
        status: 400,
        error: {
          code: "invalid_path",
          message: `Daemon http forward requires a safe relative path; got '${req.path}'.`,
        },
      })
      return
    }

    // Strip hop-by-hop headers defensively before forwarding —
    // they're meaningful only to the previous transport hop.
    const HOP_BY_HOP = new Set([
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "host", // upstream sets its own based on the URL
      "content-length", // fetch recomputes
    ])
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      headers[k] = v
    }

    const url = `${opts.httpUpstream.replace(/\/$/, "")}${req.path}`
    const controller = new AbortController()
    const timeoutMs = req.timeoutMs ?? 30_000
    // For streaming responses (SSE / long-poll), the daemon-side
    // request must NOT abort on the regular timeout — the stream is
    // *meant* to be long-lived. We arm the timer initially, then
    // disarm it as soon as we detect a streaming response so the
    // stream can run indefinitely (the host enforces its own teardown
    // via tunnel close / explicit cancel).
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(),
      timeoutMs
    )
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    try {
      const upstreamRes = await fetch(url, {
        method: req.method,
        headers,
        body:
          req.body === undefined ? undefined : decodeData(req.body),
        signal: controller.signal,
        // node fetch follows redirects by default — fine for MCP, the
        // upstream gateway doesn't redirect anyway.
      })
      const outHeaders: Record<string, string> = {}
      upstreamRes.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return
        outHeaders[key] = value
      })

      // Streaming detection — SSE responses MUST go through the
      // chunked-frame protocol so the host can pipe bytes to the
      // browser in real time. Anything else stays on the buffered
      // path for now (small JSON responses are simpler that way; we
      // can widen streaming to all responses later once it's proven).
      const contentType = (outHeaders["content-type"] ?? "").toLowerCase()
      const isStream =
        contentType.startsWith("text/event-stream") ||
        contentType.includes("application/x-ndjson")

      if (isStream && upstreamRes.body) {
        // Disarm the request-level timeout — SSE streams are
        // long-lived by design. The host closing the tunnel (or the
        // upstream closing its end) is what terminates us now.
        clearTimer()
        opts.sink.send({
          t: "http_response_head",
          reqId: req.reqId,
          status: upstreamRes.status,
          headers: outHeaders,
        })
        const reader = upstreamRes.body.getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) {
              opts.sink.send({
                t: "http_response_chunk",
                reqId: req.reqId,
                end: true,
              })
              return
            }
            if (value && value.byteLength > 0) {
              opts.sink.send({
                t: "http_response_chunk",
                reqId: req.reqId,
                data: encodeData(Buffer.from(value)),
              })
            }
            // Stop streaming if the tunnel sink closed under us — no
            // point feeding chunks into the void.
            if (!opts.sink.isOpen) {
              try {
                await reader.cancel()
              } catch {
                /* ignore */
              }
              return
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          opts.sink.send({
            t: "http_response_chunk",
            reqId: req.reqId,
            end: true,
            error: { code: "upstream_stream_failed", message },
          })
        }
        return
      }

      // Buffered path (unchanged): small responses + non-SSE traffic.
      const buf = Buffer.from(await upstreamRes.arrayBuffer())
      respond({
        status: upstreamRes.status,
        headers: outHeaders,
        body: buf.length > 0 ? encodeData(buf) : "",
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const aborted = err instanceof Error && err.name === "AbortError"
      respond({
        status: aborted ? 504 : 502,
        error: {
          code: aborted ? "timeout" : "upstream_fetch_failed",
          message,
        },
      })
    } finally {
      clearTimer()
    }
  }

  return {
    children,
    async close() {
      if (closed) return
      closed = true
      for (const [, child] of children) child.kill("SIGTERM")
      children.clear()
      opts.sink.close("server.close")
    },
  }
}

// Re-exports for convenience — server-only callers don't need to
// reach into ./frames for these.
export { encodeFrame, parseFrame }
