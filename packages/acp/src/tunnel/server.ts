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
   * Whether this daemon advertises PTY support. v0 always reports
   * false — PTY allocation needs node-pty (optional dep) and we
   * haven't wired that side yet.
   */
  pty?: boolean
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
}

export interface TunnelServer {
  /** Currently-live execId → ChildProcess. Read-only diagnostic. */
  readonly children: ReadonlyMap<string, ChildProcess>
  /** Kill all live children and close the sink. */
  close(): Promise<void>
}

export function createTunnelServer(opts: TunnelServerOptions): TunnelServer {
  const children = new Map<string, ChildProcess>()
  let closed = false

  // Greet the host immediately so it can fail fast on version
  // mismatch before issuing spawns.
  opts.sink.send({
    t: "hello",
    version: TUNNEL_VERSION,
    capabilities: { pty: opts.pty === true },
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
    offFrame()
    offClose()
  })

  async function handleFrame(frame: TunnelFrame): Promise<void> {
    switch (frame.t) {
      case "spawn":
        await handleSpawn(frame)
        return
      case "stdin": {
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
        // Cast: NodeJS.Signals is a string union; users may send any
        // POSIX signal name. We trust the host.
        child.kill((frame.signal as NodeJS.Signals | undefined) ?? "SIGTERM")
        return
      }
      case "resize":
        // PTY resize — needs node-pty wiring. Silently no-op for now;
        // hosts that care can check `hello.capabilities.pty`.
        return
      case "http_request":
        // Fire-and-forget — the handler emits its own http_response
        // frame (or error). Errors that escape handleHttpRequest
        // bubble to the outer .catch and become a generic `error`
        // frame, but the per-request error path inside the handler
        // produces an http_response with `error:` set, which is what
        // the host's forwardHttp expects.
        await handleHttpRequest(frame)
        return
      case "ping":
        opts.sink.send({ t: "pong", nonce: frame.nonce })
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
    const timer = setTimeout(() => controller.abort(), timeoutMs)
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
      const buf = Buffer.from(await upstreamRes.arrayBuffer())
      const outHeaders: Record<string, string> = {}
      upstreamRes.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return
        outHeaders[key] = value
      })
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
      clearTimeout(timer)
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
