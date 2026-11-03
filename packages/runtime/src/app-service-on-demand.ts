/**
 * On-demand activation of an app service (AIP-53 `services[].activation:
 * { mode: "on-demand" }`): scale to zero.
 *
 * A keep-alive service (`app-service-process.ts`) holds a process, and its
 * port, from install/boot on. An on-demand service holds neither. The HOST
 * owns the declared `port` for the whole life of the install: a loopback
 * listener that is the service's front door, and the target of its `expose`
 * tunnel. The process only exists while somebody uses it:
 *
 *   idle ──first request──▶ starting ──listening──▶ running ──idle──▶ stopping ──▶ idle
 *
 * - **Start.** The first request (or upgrade) finds no process, allocates a
 *   free loopback port, spawns the declared command with `PORT=<that port>`
 *   (the process must bind it; it can no longer bind the declared one, the
 *   host holds it) and waits until the port accepts connections. The request
 *   is QUEUED during that wait, up to `startTimeoutMs`; every request that
 *   arrives meanwhile shares the same start. Nothing is buffered: a queued
 *   request body stays in the socket, so the client is back-pressured.
 * - **Proxy.** HTTP is forwarded as-is (same method, path and headers bar
 *   the hop-by-hop ones, bodies streamed both ways); an `Upgrade` request
 *   (WebSocket) is forwarded and then piped byte for byte.
 * - **Stop.** The service is busy while a proxied request or upgraded
 *   connection is open, and idle `idleStopMs` after the last one ended; then
 *   its process group is killed (`killServiceProcess`) and the next request
 *   starts it again. An open streaming response or WebSocket therefore keeps
 *   it up; a quiet idle keep-alive socket does not.
 * - **Failure.** A failed start (exit before listening, no listener within
 *   `startTimeoutMs`, spawn error) answers 503 with a generic body, the
 *   reason goes to the log only. The restart policy's backoff becomes the
 *   circuit breaker: after the n-th unexpected exit inside its window the
 *   next start is refused (503 + `Retry-After`) for `baseDelay * factor^(n-1)`
 *   up to `maxDelay`. There is no give-up state: the host keeps listening,
 *   and the first request after the gap tries again. A crash while running
 *   returns the service to idle (and counts), it is not restarted unasked.
 *
 * What it replaces is the keep-alive restart loop, so none of its failure
 * modes exist here: nothing crash-loops at boot, and the child never holds
 * the declared port (its own port is fresh each start), so a copy left over
 * from an old daemon cannot make the new one fail with `EADDRINUSE`.
 *
 * Only a service whose work is driven by inbound requests may run this way:
 * a poller or scheduler is stopped while idle and must stay `always`.
 */

import { connect, createServer as createNetServer, type Socket } from "node:net"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import {
  DEFAULT_SERVICE_IDLE_STOP_MS,
  DEFAULT_SERVICE_START_TIMEOUT_MS,
  type AppService,
  type AppServiceActivation,
} from "@agentproto/app"

import {
  DEFAULT_APP_SERVICE_RESTART_POLICY,
  registerAppServiceSupervisor,
  startAppServiceProcess,
  stopAppServiceSupervisor,
  type AppServiceProcess,
  type AppServiceRestartPolicy,
} from "./app-service-process.js"
import type { SessionsRegistry } from "./sessions.js"

/** A service the host can front: it has a `port` and `activation.mode` is `on-demand`. */
export type OnDemandAppService = AppService & {
  readonly port: number
  readonly activation: AppServiceActivation & { readonly mode: "on-demand" }
}

export function isOnDemandService(service: AppService): service is OnDemandAppService {
  return service.activation?.mode === "on-demand" && service.port !== undefined
}

export type OnDemandState = "idle" | "starting" | "running" | "stopping"

/** An on-demand service the host is fronting. Also an {@link AppServiceProcess}
 *  so the kill paths (`stopAppServiceSupervisor`) stop it like a runner:
 *  `sessionId`/`pid`/`startTicks` are those of the live attempt (`sessionId`
 *  stays on the latest attempt, `""` before the first). */
export interface OnDemandService extends AppServiceProcess {
  readonly state: OnDemandState
  /** Port the host listens on (the declared one). */
  readonly port: number
}

export interface StartOnDemandServiceDeps {
  registry: SessionsRegistry
  appId: string
  dir: string
  service: OnDemandAppService
  label?: string
  workspaceSlug?: string
  /** Extra env for every start, on top of the daemon's (e.g. the exposed
   *  `AGENTPROTO_PUBLIC_URL`). `PORT` is always set by the host. */
  env?: Record<string, string>
  logFile?: string
  /** Backoff of the start circuit breaker (see the module doc). */
  restart?: Partial<AppServiceRestartPolicy>
  /** Interface the host listens on. Default `127.0.0.1`. */
  listenHost?: string
  /** The live process changed: `info` at a start, `undefined` once it is
   *  gone. Lets the caller keep the persisted owner record's pid current. */
  onProcessChange?: (info: { sessionId: string; pid?: number; startTicks?: number } | undefined) => void
  onError?: (message: string) => void
}

export type StartOnDemandServiceResult =
  | { ok: true; handle: OnDemandService }
  | { ok: false; error: string }

/** Live hosts, for the daemon-stop sweep and `app_status`. */
const hosts = new Map<string, OnDemandService>()

/** State of the on-demand host of `<appId>:<name>`, `undefined` when this
 *  daemon holds none (not started, bind failed, or stopped). */
export function onDemandServiceState(appId: string, name: string): OnDemandState | undefined {
  return hosts.get(`${appId}:${name}`)?.state
}

/** Stop every on-demand host of this daemon: close the listeners and kill
 *  the processes. Daemon shutdown calls it so no process outlives the front
 *  door that was the only way to reach it. */
export async function stopAllOnDemandServices(): Promise<void> {
  await Promise.all([...hosts.values()].map(h => h.stop().catch(() => undefined)))
}

/** An activation that failed: the request gets a generic 503 (the cause goes
 *  to the log, not to a public client). */
class ActivationError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message)
  }
}

interface Attempt {
  port: number
  handle: AppServiceProcess
  /** Set when the process is known gone, so a start in flight stops waiting. */
  exited: boolean
}

// RFC 9110 hop-by-hop headers, plus `expect` (the front already answered
// `100 Continue`). Not forwarded in either direction.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
])

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k)) out[k] = v
  return out
}

/** The request head of an upgrade, verbatim (`Connection`/`Upgrade` included). */
function rawRequestHead(req: IncomingMessage): string {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
  for (let i = 0; i < req.rawHeaders.length; i += 2) head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
  return `${head}\r\n`
}

function replyUnavailable(res: ServerResponse, retryAfterSec?: number): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
    ...(retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {}),
  })
  res.end("service unavailable\n")
}

function replyBadGateway(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" })
  res.end("bad gateway\n")
}

/** A refusal for an `Upgrade` request: the raw socket has no `ServerResponse`. */
function endUpgrade(socket: Socket, status: 502 | 503, retryAfterSec?: number): void {
  const reason = status === 503 ? "Service Unavailable" : "Bad Gateway"
  const retry = retryAfterSec !== undefined ? `retry-after: ${retryAfterSec}\r\n` : ""
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncache-control: no-store\r\ncontent-length: 0\r\n${retry}\r\n`)
}

/** A free loopback port: bind 0, read it, release it. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no loopback port"))))
    })
  })
}

function probeListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect({ port, host: "127.0.0.1" })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(1_000, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

/** How long the far side of an upgraded connection gets to finish once the
 *  near side has half-closed. */
const HALF_CLOSE_GRACE_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Take the listening side of an on-demand service. Resolves once the host is
 * bound to the declared port (the process starts later, on demand); `ok:
 * false` when it cannot bind (e.g. `EADDRINUSE`: something still holds the
 * declared port). The returned handle is registered like a keep-alive runner,
 * so `stopAppServiceSupervisor` (uninstall, reconcile) stops it.
 */
export async function startOnDemandService(deps: StartOnDemandServiceDeps): Promise<StartOnDemandServiceResult> {
  const { appId, service } = deps
  const idleStopMs = service.activation.idleStopMs ?? DEFAULT_SERVICE_IDLE_STOP_MS
  const startTimeoutMs = service.activation.startTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS
  const policy: AppServiceRestartPolicy = { ...DEFAULT_APP_SERVICE_RESTART_POLICY, ...deps.restart }
  const key = `${appId}:${service.name}`

  let phase: OnDemandState = "idle"
  let disposed = false
  let current: Attempt | undefined
  let lastSessionId = ""
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  /** Open proxied requests and upgraded connections. */
  let busy = 0
  let lastActivityAt = Date.now()
  let idleTimer: NodeJS.Timeout | undefined
  let failStamps: number[] = []
  let retryNotBefore = 0
  const upgraded = new Set<Socket>()

  const warn = (message: string): void => {
    const line = `[app-services] on-demand service "${key}" ${message}`
    console.warn(line)
    deps.onError?.(line)
  }

  // ── start / stop of the process ──────────────────────────────────────────

  /** One unexpected exit (or failed start). Widens the gap before the next
   *  start: the restart policy's backoff, minus the give-up. */
  const recordFailure = (): number => {
    const t = Date.now()
    failStamps = [...failStamps.filter(ts => ts > t - policy.windowMs), t]
    const delay = Math.min(policy.baseDelayMs * Math.pow(policy.factor, failStamps.length - 1), policy.maxDelayMs)
    retryNotBefore = t + delay
    return Math.max(1, Math.ceil(delay / 1000))
  }

  const onChildExit = (attempt: Attempt, deliberate: boolean): void => {
    if (attempt.exited) return
    attempt.exited = true
    if (current !== attempt || disposed) return
    if (phase === "starting") return // `doStart` is waiting on it and reports the failure
    current = undefined
    phase = "idle"
    deps.onProcessChange?.(undefined)
    if (!deliberate) {
      recordFailure()
      warn("exited while running; it starts again on the next request")
    }
  }

  const doStart = async (): Promise<void> => {
    const t = Date.now()
    if (t < retryNotBefore) {
      throw new ActivationError("start refused during the failure backoff", Math.max(1, Math.ceil((retryNotBefore - t) / 1000)))
    }
    phase = "starting"
    let attempt: Attempt | undefined
    try {
      const port = await allocateLoopbackPort()
      if (disposed) throw new ActivationError("host stopped")
      const started = startAppServiceProcess({
        registry: deps.registry,
        appId,
        dir: deps.dir,
        service,
        ...(deps.label !== undefined ? { label: deps.label } : {}),
        ...(deps.workspaceSlug !== undefined ? { workspaceSlug: deps.workspaceSlug } : {}),
        env: { ...(deps.env ?? {}), PORT: String(port) },
        ...(deps.logFile !== undefined ? { logFile: deps.logFile } : {}),
        ...(deps.onError !== undefined ? { onError: deps.onError } : {}),
        singleAttempt: {
          onExit: info => {
            if (attempt !== undefined) onChildExit(attempt, info.deliberate)
          },
        },
      })
      if (!started.ok) throw new Error(started.error)
      if (!started.handle.sessionId) throw new Error("spawn produced no process")
      attempt = { port, handle: started.handle, exited: false }
      current = attempt
      lastSessionId = started.handle.sessionId
      const deadline = t + startTimeoutMs
      let delay = 25
      for (;;) {
        if (disposed || attempt.exited) throw new Error("process exited before it listened")
        if (await probeListening(port)) break
        if (Date.now() >= deadline) throw new Error(`no listener on its port within ${startTimeoutMs}ms`)
        await sleep(delay)
        delay = Math.min(Math.round(delay * 1.6), 250)
      }
      if (disposed) throw new ActivationError("host stopped")
      phase = "running"
      lastActivityAt = Date.now()
      deps.onProcessChange?.({
        sessionId: started.handle.sessionId,
        ...(started.handle.pid !== undefined ? { pid: started.handle.pid } : {}),
        ...(started.handle.startTicks !== undefined ? { startTicks: started.handle.startTicks } : {}),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (attempt !== undefined) {
        attempt.exited = true
        await attempt.handle.stop().catch(() => undefined)
        deps.onProcessChange?.(undefined)
      }
      current = undefined
      phase = "idle"
      if (err instanceof ActivationError) throw err
      // Not a failure of the service: the host itself was stopped under it.
      if (disposed) throw new ActivationError("host stopped")
      const retryAfter = recordFailure()
      warn(`failed to start: ${reason}`)
      throw new ActivationError(reason, retryAfter)
    }
  }

  const start = (): Promise<void> => {
    if (starting === undefined) {
      const p: Promise<void> = doStart().finally(() => {
        if (starting === p) starting = undefined
      })
      starting = p
    }
    return starting
  }

  const stopProcess = (): Promise<void> => {
    if (stopping !== undefined) return stopping
    const attempt = current
    if (attempt === undefined) return Promise.resolve()
    phase = "stopping"
    attempt.exited = true
    const p: Promise<void> = (async () => {
      try {
        await attempt.handle.stop()
      } catch {
        // The process group is already gone: same best-effort contract as the kill paths.
      }
      if (current === attempt) current = undefined
      phase = "idle"
      deps.onProcessChange?.(undefined)
    })().finally(() => {
      if (stopping === p) stopping = undefined
    })
    stopping = p
    return p
  }

  // ── idle accounting ──────────────────────────────────────────────────────

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    if (disposed || phase !== "running" || busy > 0) return
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined
        if (disposed || phase !== "running" || busy > 0) return
        if (Date.now() - lastActivityAt < idleStopMs) return armIdleTimer()
        void stopProcess()
      },
      Math.max(0, lastActivityAt + idleStopMs - Date.now()),
    )
    idleTimer.unref()
  }

  /** Take the process for one request: starts it first when needed. The
   *  phase check and the `busy` increment are one synchronous step, so an
   *  idle stop can never slip between them. */
  const acquire = async (): Promise<number> => {
    for (;;) {
      if (disposed) throw new ActivationError("host stopped")
      if (phase === "running" && current !== undefined) {
        busy += 1
        lastActivityAt = Date.now()
        armIdleTimer()
        return current.port
      }
      if (phase === "stopping" && stopping !== undefined) await stopping
      else await start()
    }
  }

  const releaser = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      busy -= 1
      lastActivityAt = Date.now()
      armIdleTimer()
    }
  }

  // ── proxy ────────────────────────────────────────────────────────────────

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      let port: number
      try {
        port = await acquire()
      } catch (err) {
        replyUnavailable(res, err instanceof ActivationError ? err.retryAfterSec : undefined)
        return
      }
      const release = releaser()
      res.once("close", release)
      if (res.destroyed) return release()
      const upstream = httpRequest({
        host: "127.0.0.1",
        port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers),
        agent: false,
      })
      res.once("close", () => upstream.destroy())
      upstream.once("response", up => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage || undefined, forwardHeaders(up.headers))
        up.once("error", () => res.destroy())
        up.pipe(res)
      })
      upstream.once("error", () => replyBadGateway(res))
      req.once("error", () => upstream.destroy())
      req.pipe(upstream)
    })()
  }

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    socket.on("error", () => undefined)
    void (async () => {
      let port: number
      try {
        port = await acquire()
      } catch (err) {
        endUpgrade(socket, 503, err instanceof ActivationError ? err.retryAfterSec : undefined)
        return
      }
      const release = releaser()
      socket.once("close", () => {
        upgraded.delete(socket)
        release()
      })
      if (socket.destroyed) return release()
      upgraded.add(socket)
      const upstream = connect({ port, host: "127.0.0.1" })
      let connected = false
      upstream.once("error", () => (connected ? socket.destroy() : endUpgrade(socket, 502)))
      upstream.once("close", () => socket.destroy())
      socket.once("close", () => upstream.destroy())
      upstream.once("connect", () => {
        connected = true
        upstream.write(rawRequestHead(req))
        if (head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
        // The pipes pass a half-close on; a peer that then never finishes
        // must not pin the process (an open connection counts as busy), so
        // the other side is cut a moment after the first one is done.
        const cutSoon = (other: Socket) => (): void => void setTimeout(() => other.destroy(), HALF_CLOSE_GRACE_MS).unref()
        socket.once("end", cutSoon(upstream))
        upstream.once("end", cutSoon(socket))
        // Bytes in either direction are activity; counted after the pipes
        // exist so that adding a reader cannot drop the first ones.
        const touch = (): void => {
          lastActivityAt = Date.now()
        }
        socket.on("data", touch)
        upstream.on("data", touch)
      })
    })()
  }

  // ── the host's own life ──────────────────────────────────────────────────

  // Free the declared port first when a previous holder of this slot (e.g. a
  // host whose owner record was lost) still has it.
  await stopAppServiceSupervisor(appId, service.name)
  const server: Server = createServer(onRequest)
  server.on("upgrade", onUpgrade)
  const listenHost = deps.listenHost ?? "127.0.0.1"
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ port: service.port, host: listenHost }, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      error:
        code === "EADDRINUSE"
          ? `port ${service.port} is already in use (a copy of "${service.name}" still running? stop it, the host owns this port)`
          : `cannot listen on ${listenHost}:${service.port}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  server.on("error", err => warn(`listener error: ${err.message}`))

  let unregister: () => void = () => undefined
  const stop = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    unregister()
    hosts.delete(key)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    for (const s of upgraded) s.destroy()
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    server.closeAllConnections()
    await stopProcess()
    await closed
    await starting?.catch(() => undefined)
  }

  const handle: OnDemandService = {
    get sessionId() {
      return current?.handle.sessionId ?? lastSessionId
    },
    get pid() {
      return current?.handle.pid
    },
    get startTicks() {
      return current?.handle.startTicks
    },
    get disposed() {
      return disposed
    },
    get state() {
      return phase
    },
    port: service.port,
    stop,
  }
  unregister = registerAppServiceSupervisor(appId, service.name, handle)
  hosts.set(key, handle)
  return { ok: true, handle }
}
