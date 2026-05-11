/**
 * Tunnel client (host side).
 *
 * Sits on the orchestrator (e.g. Guilde API). Speaks to a remote daemon
 * over a `FrameSink`. Exposes `spawn(command, args, opts)` that returns
 * an object shaped like Node's `ChildProcess` — same `.stdin` /
 * `.stdout` / `.stderr` / `.on('exit')` / `.kill()` surface. This lets
 * the existing ACP protocol arm drive remote subprocesses with zero
 * code changes; the arm thinks it's talking to a local child.
 *
 * The duck is intentionally minimal — only the methods the ACP arm
 * actually calls. If you need the full ChildProcess interface, wrap
 * this with a node:stream.Readable shim.
 */

import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import {
  TUNNEL_VERSION,
  decodeData,
  encodeData,
  type ExitFrame,
  type HelloFrame,
  type HttpRequestFrame,
  type HttpResponseFrame,
  type SpawnFrame,
  type SpawnedFrame,
  type StderrFrame,
  type StdoutFrame,
  type TunnelFrame,
} from "./frames.js"
import type { FrameSink } from "./transport.js"

/** Resolved response from `forwardHttp`. Mirrors `HttpResponseFrame`
 *  but with the body decoded back to a Buffer for the caller. */
export interface TunnelHttpResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body: Buffer
  /** Set when the daemon failed to complete the upstream call. */
  error?: Readonly<{
    code: string
    message: string
  }>
}

export interface TunnelHttpRequest {
  method: string
  path: string
  headers?: Readonly<Record<string, string>>
  body?: Buffer | Uint8Array | string
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number
}

export interface TunnelClientOptions {
  sink: FrameSink
  /**
   * Reject the `spawn` call if the daemon hasn't sent its `hello`
   * within this window. Defaults to 10s — generous for high-latency
   * tunnels but fast enough that misconfigured daemons fail loudly.
   */
  helloTimeoutMs?: number
}

export interface TunnelSpawnOptions {
  cwd?: string
  env?: Readonly<Record<string, string>>
  /** Allocate a PTY on the daemon. Requires `hello.capabilities.pty`. */
  pty?: boolean
}

/**
 * Minimal ChildProcess-shaped duck. Covers the surface our ACP arm
 * calls; expand only when a real consumer needs more.
 */
export interface TunnelChildProcess {
  readonly execId: string
  readonly pid: number | null
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** "exit" → (code, signal). "error" → (Error). */
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this
  on(event: "error", listener: (err: Error) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface TunnelClient {
  /**
   * Resolves once the daemon has sent its `hello` frame, OR rejects
   * with a tunnel-level error. Subsequent calls return the cached
   * promise.
   */
  ready(): Promise<HelloFrame>
  spawn(
    command: string,
    args: readonly string[],
    opts?: TunnelSpawnOptions
  ): Promise<TunnelChildProcess>
  /**
   * Forward an HTTP request through the tunnel to the daemon's
   * configured upstream (typically `http://127.0.0.1:<port>`). The
   * daemon completes the upstream call and replies with the response,
   * which this promise resolves to. Rejects on tunnel-transport
   * failure; the daemon-reported HTTP status (incl. 5xx) is returned
   * in the resolved value.
   */
  forwardHttp(req: TunnelHttpRequest): Promise<TunnelHttpResponse>
  close(): Promise<void>
}

export function createTunnelClient(opts: TunnelClientOptions): TunnelClient {
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000
  let hello: HelloFrame | null = null
  let helloPromise: Promise<HelloFrame> | null = null

  // Per-execId routing tables. We dispatch incoming frames to the
  // right child duck by execId; spawn awaits its own `spawned` /
  // `error` reply via these one-shot resolvers.
  const childByExec = new Map<string, TunnelChildDuck>()
  const spawnPending = new Map<
    string,
    { resolve: (frame: SpawnedFrame) => void; reject: (err: Error) => void }
  >()

  // Inflight HTTP forwards keyed by reqId. Each resolves with the
  // first matching `http_response` frame; daemon timeouts are surfaced
  // either via `error` (then we resolve with status=502) or by the
  // per-request setTimeout below (then we reject with a timeout error).
  const httpPending = new Map<
    string,
    {
      resolve: (resp: TunnelHttpResponse) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const offFrame = opts.sink.onFrame((frame) => routeIncoming(frame))
  const offClose = opts.sink.onClose(() => {
    for (const [, duck] of childByExec) duck.__handleSinkClosed()
    childByExec.clear()
    for (const [, p] of spawnPending) {
      p.reject(new Error("Tunnel closed before spawn completed."))
    }
    spawnPending.clear()
    for (const [, p] of httpPending) {
      clearTimeout(p.timer)
      p.reject(new Error("Tunnel closed before HTTP response arrived."))
    }
    httpPending.clear()
    offFrame()
    offClose()
  })

  function routeIncoming(frame: TunnelFrame): void {
    switch (frame.t) {
      case "hello":
        if (frame.version !== TUNNEL_VERSION) {
          // Mismatch — surface via the ready() rejection. We don't
          // tear down the sink because the caller may want to
          // negotiate a fallback.
          throw new Error(
            `Tunnel daemon speaks ${frame.version}; this client speaks ${TUNNEL_VERSION}.`
          )
        }
        hello = frame
        return
      case "spawned": {
        const pending = spawnPending.get(frame.execId)
        if (pending) {
          spawnPending.delete(frame.execId)
          pending.resolve(frame)
        }
        return
      }
      case "stdout": {
        const duck = childByExec.get(frame.execId)
        duck?.__pushStdout(decodeData((frame as StdoutFrame).data))
        return
      }
      case "stderr": {
        const duck = childByExec.get(frame.execId)
        duck?.__pushStderr(decodeData((frame as StderrFrame).data))
        return
      }
      case "exit": {
        const duck = childByExec.get(frame.execId)
        duck?.__handleExit(frame as ExitFrame)
        childByExec.delete(frame.execId)
        return
      }
      case "error": {
        if (frame.execId) {
          const pending = spawnPending.get(frame.execId)
          if (pending) {
            spawnPending.delete(frame.execId)
            pending.reject(new Error(`${frame.code}: ${frame.message}`))
            return
          }
          const duck = childByExec.get(frame.execId)
          duck?.__pushError(new Error(`${frame.code}: ${frame.message}`))
          return
        }
        // Tunnel-level error: nowhere to surface it cleanly here.
        // Callers that care should wrap the FrameSink and observe
        // tunnel-error frames themselves.
        return
      }
      case "http_response": {
        const pending = httpPending.get(frame.reqId)
        if (!pending) return
        httpPending.delete(frame.reqId)
        clearTimeout(pending.timer)
        pending.resolve({
          status: frame.status,
          headers: frame.headers ?? {},
          body: frame.body ? decodeData(frame.body) : Buffer.alloc(0),
          ...(frame.error ? { error: frame.error } : {}),
        })
        return
      }
      case "ping":
        opts.sink.send({ t: "pong", nonce: frame.nonce })
        return
      case "pong":
      case "spawn":
      case "stdin":
      case "kill":
      case "resize":
      case "http_request":
        // Not expected on the host side; ignore.
        return
    }
  }

  return {
    ready() {
      if (hello) return Promise.resolve(hello)
      if (helloPromise) return helloPromise
      helloPromise = new Promise<HelloFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Tunnel daemon did not send hello within ${helloTimeoutMs}ms.`
            )
          )
        }, helloTimeoutMs)
        // Rebind sink listener so we resolve on the next hello.
        const off = opts.sink.onFrame((frame) => {
          if (frame.t !== "hello") return
          clearTimeout(timer)
          off()
          if (frame.version !== TUNNEL_VERSION) {
            reject(
              new Error(
                `Tunnel daemon speaks ${frame.version}; client speaks ${TUNNEL_VERSION}.`
              )
            )
            return
          }
          hello = frame
          resolve(frame)
        })
      })
      return helloPromise
    },

    async spawn(command, args, spawnOpts) {
      if (!hello) await this.ready()
      if (spawnOpts?.pty && hello?.capabilities.pty !== true) {
        throw new Error(
          `Tunnel daemon '${hello?.label ?? "(unnamed)"}' does not advertise PTY support.`
        )
      }
      const execId = randomUUID()
      const req: SpawnFrame = {
        t: "spawn",
        execId,
        command,
        args,
        cwd: spawnOpts?.cwd,
        env: spawnOpts?.env,
        pty: spawnOpts?.pty,
      }
      const spawnedFrame = await new Promise<SpawnedFrame>(
        (resolve, reject) => {
          spawnPending.set(execId, { resolve, reject })
          opts.sink.send(req)
        }
      )
      const duck = new TunnelChildDuck(execId, spawnedFrame.pid, opts.sink)
      childByExec.set(execId, duck)
      return duck
    },

    async forwardHttp(req: TunnelHttpRequest): Promise<TunnelHttpResponse> {
      if (!hello) await this.ready()
      const reqId = randomUUID()
      const timeoutMs = req.timeoutMs ?? 30_000
      const body =
        req.body === undefined
          ? undefined
          : encodeData(
              typeof req.body === "string" ? req.body : Buffer.from(req.body)
            )
      const frame: HttpRequestFrame = {
        t: "http_request",
        reqId,
        method: req.method,
        path: req.path,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(body !== undefined ? { body } : {}),
        timeoutMs,
      }
      return new Promise<TunnelHttpResponse>((resolve, reject) => {
        // Belt-and-suspenders timeout: in addition to the daemon-side
        // enforcement, we time out client-side at timeoutMs + 5s so a
        // misbehaving daemon can't stall this promise forever.
        const timer = setTimeout(() => {
          httpPending.delete(reqId)
          reject(
            new Error(
              `Tunnel forwardHttp(${req.method} ${req.path}) timed out after ${timeoutMs + 5_000}ms.`
            )
          )
        }, timeoutMs + 5_000)
        httpPending.set(reqId, { resolve, reject, timer })
        opts.sink.send(frame)
      })
    },

    async close() {
      opts.sink.close("client.close")
    },
  }
}

/**
 * Internal ChildProcess duck. Public methods mirror the subset of
 * Node's ChildProcess that our ACP arm calls; double-underscored
 * methods are control hooks for the client.
 */
class TunnelChildDuck extends EventEmitter implements TunnelChildProcess {
  readonly execId: string
  pid: number | null
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  private readonly sink: FrameSink
  private exited = false

  constructor(execId: string, pid: number, sink: FrameSink) {
    super()
    this.execId = execId
    this.pid = pid > 0 ? pid : null
    this.sink = sink

    // stdout / stderr are passive Readables — consumers attach
    // listeners and we push() data as it arrives.
    this.stdout = new Readable({ read() {} })
    this.stderr = new Readable({ read() {} })

    // stdin is a Writable that converts each chunk to a `stdin` frame.
    this.stdin = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        sink.send({
          t: "stdin",
          execId,
          data: encodeData(chunk),
        })
        cb()
      },
      // Sending an empty stdin frame on `final` mirrors the local
      // semantics of closing a child's stdin (signal EOF). Daemons
      // ignore empty payloads, so this is safe even if the child
      // doesn't care about EOF.
      final(cb) {
        sink.send({ t: "stdin", execId, data: "" })
        cb()
      },
    })
  }

  __pushStdout(buf: Buffer): void {
    this.stdout.push(buf)
  }

  __pushStderr(buf: Buffer): void {
    this.stderr.push(buf)
  }

  __pushError(err: Error): void {
    this.emit("error", err)
  }

  __handleExit(frame: ExitFrame): void {
    if (this.exited) return
    this.exited = true
    this.stdout.push(null)
    this.stderr.push(null)
    this.emit("exit", frame.code, frame.signal)
  }

  __handleSinkClosed(): void {
    if (this.exited) return
    this.exited = true
    this.stdout.push(null)
    this.stderr.push(null)
    this.emit(
      "exit",
      null,
      "SIGHUP" // surrogate signal — the tunnel went away
    )
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exited) return false
    this.sink.send({
      t: "kill",
      execId: this.execId,
      signal: typeof signal === "string" ? signal : `SIG${signal}`,
    })
    return true
  }
}
