/**
 * On-demand activation of an app service (app-service-on-demand.ts): the host
 * owns the declared port, starts the process on the first request, proxies
 * HTTP and WebSocket, stops it when idle, and refuses to crash-loop.
 *
 * Real everything: a real loopback listener, real child processes spawned
 * through `startAppServiceProcess` (a few lines of `node -e` as the "service")
 * and a real sessions registry. Time values are small, never mocked.
 */

import { afterEach, describe, expect, it } from "vitest"
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { connect, createServer as createNetServer } from "node:net"
import type { AppService } from "@agentproto/app"
import {
  allocateLoopbackPort,
  isOnDemandService,
  onDemandServiceState,
  startOnDemandService,
  stopAllOnDemandServices,
  type OnDemandAppService,
  type OnDemandService,
  type StartOnDemandServiceDeps,
} from "../app-service-on-demand.js"
import { isAppServiceSupervised, stopAppServiceSupervisor } from "../app-service-process.js"
import { createSessionsRegistry } from "../sessions.js"

const APP_ID = "@test/on-demand"

/** The "service": echoes what it was asked and who it is, and misbehaves on demand. */
const ECHO_SERVICE = `
const http = require("http")
const srv = http.createServer((req, res) => {
  if (req.url === "/crash") process.exit(1)
  if (req.url === "/slow") return void setTimeout(() => res.end("slow-done"), 500)
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    res.setHeader("x-backend", "1")
    res.end(JSON.stringify({
      pid: process.pid,
      port: process.env.PORT,
      method: req.method,
      url: req.url,
      host: req.headers.host,
      bytes: body.length,
      text: body.length < 100 ? body.toString() : undefined,
    }))
  })
})
srv.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n")
  socket.on("data", d => socket.write("echo:" + d))
})
setTimeout(() => srv.listen(Number(process.env.PORT), "127.0.0.1"), Number(process.env.START_DELAY || 0))
`

const registry = createSessionsRegistry({ persist: false })
const hosts: OnDemandService[] = []
const servers: Array<{ close: () => void }> = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.stop()))
  for (const s of servers.splice(0)) s.close()
})

interface Fixture {
  host: OnDemandService
  name: string
  port: number
  /** `onProcessChange` calls, in order: a start is an object, a stop `undefined`. */
  changes: Array<{ sessionId: string; pid?: number } | undefined>
  starts: () => number
  rows: () => number
}

let counter = 0
async function startHost(
  opts: {
    script?: string
    name?: string
    activation?: { idleStopMs?: number; startTimeoutMs?: number }
    env?: Record<string, string>
    restart?: StartOnDemandServiceDeps["restart"]
  } = {},
): Promise<Fixture> {
  const port = await allocateLoopbackPort()
  const name = opts.name ?? `svc-${++counter}`
  const service: OnDemandAppService = {
    name,
    command: process.execPath,
    args: ["-e", opts.script ?? ECHO_SERVICE],
    port,
    activation: { mode: "on-demand", ...(opts.activation ?? {}) },
  }
  const changes: Fixture["changes"] = []
  const started = await startOnDemandService({
    registry,
    appId: APP_ID,
    dir: process.cwd(),
    service,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
    onProcessChange: info => changes.push(info),
  })
  if (!started.ok) throw new Error(started.error)
  hosts.push(started.handle)
  const label = `app:${APP_ID}:service:${name}`
  return {
    host: started.handle,
    name,
    port,
    changes,
    starts: () => changes.filter(c => c !== undefined).length,
    rows: () => registry.list().filter(r => r.label === label).length,
  }
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function get(port: number, path = "/", init: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: init.method ?? "GET", path, headers: init.headers, agent: false },
      res => {
        const chunks: Buffer[] = []
        res.on("data", c => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on("error", reject)
    req.end(init.body)
  })
}

async function waitFor(cond: () => boolean, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ port, host: "127.0.0.1" })
    s.once("connect", () => {
      s.destroy()
      resolve(true)
    })
    s.once("error", () => resolve(false))
  })
}

describe("isOnDemandService", () => {
  it("needs both a port and activation.mode on-demand", () => {
    const base: AppService = { name: "a", entry: "x", port: 1 }
    expect(isOnDemandService({ ...base, activation: { mode: "on-demand" } })).toBe(true)
    expect(isOnDemandService({ ...base, activation: { mode: "always" } })).toBe(false)
    expect(isOnDemandService(base)).toBe(false)
    expect(isOnDemandService({ name: "a", entry: "x", activation: { mode: "on-demand" } })).toBe(false)
  })
})

describe("on-demand service host", () => {
  it("holds the declared port but runs nothing until a request arrives", async () => {
    const fx = await startHost()
    expect(fx.host.state).toBe("idle")
    expect(await canConnect(fx.port)).toBe(true)
    await sleep(100)
    expect(fx.starts()).toBe(0)
    expect(fx.rows()).toBe(0)
    expect(fx.host.pid).toBeUndefined()
  })

  it("starts the process on the first request, gives it PORT, and proxies method, path, headers and body", async () => {
    const fx = await startHost()
    const res = await get(fx.port, "/a/b?c=1", { method: "POST", body: "hello", headers: { "x-in": "1", host: "front.example" } })
    expect(res.status).toBe(200)
    expect(res.headers["x-backend"]).toBe("1")
    const seen = JSON.parse(res.body)
    expect(seen).toMatchObject({ method: "POST", url: "/a/b?c=1", text: "hello", host: "front.example" })
    // The process binds a port of its own, never the one the host holds.
    expect(Number(seen.port)).not.toBe(fx.port)
    expect(fx.host.state).toBe("running")
    expect(fx.starts()).toBe(1)
    expect(fx.host.pid).toBe(seen.pid)
    // The attempt is a row in the sessions registry, like a keep-alive one.
    expect(fx.rows()).toBe(1)
    const row = registry.list().find(r => r.id === fx.host.sessionId)
    expect(row).toMatchObject({ label: expect.stringContaining("service:"), origin: `app-service:${APP_ID}` })
  })

  it("streams a large request body through", async () => {
    const fx = await startHost()
    const res = await get(fx.port, "/up", { method: "PUT", body: Buffer.alloc(3 * 1024 * 1024, 7) })
    expect(JSON.parse(res.body).bytes).toBe(3 * 1024 * 1024)
  })

  it("reuses the running process for later requests", async () => {
    const fx = await startHost()
    const pids = new Set<number>()
    for (let i = 0; i < 4; i++) pids.add(JSON.parse((await get(fx.port)).body).pid)
    expect([...pids]).toHaveLength(1)
    expect(fx.starts()).toBe(1)
  })

  it("makes concurrent first requests share one start (queued during a slow cold start)", async () => {
    const fx = await startHost({ env: { START_DELAY: "400" } })
    const t0 = Date.now()
    const replies = await Promise.all(Array.from({ length: 6 }, () => get(fx.port)))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350)
    expect(replies.every(r => r.status === 200)).toBe(true)
    expect(new Set(replies.map(r => JSON.parse(r.body).pid)).size).toBe(1)
    expect(fx.starts()).toBe(1)
    expect(fx.rows()).toBe(1)
  })

  it("stops the process after idleStopMs and starts a fresh one on the next request", async () => {
    const fx = await startHost({ activation: { idleStopMs: 250 } })
    const first = JSON.parse((await get(fx.port)).body).pid as number
    expect(alive(first)).toBe(true)
    await waitFor(() => fx.host.state === "idle", 3_000, "idle stop")
    await waitFor(() => !alive(first), 3_000, "process gone")
    expect(fx.changes.at(-1)).toBeUndefined()
    expect(await canConnect(fx.port)).toBe(true) // the front door stays
    const second = JSON.parse((await get(fx.port)).body).pid as number
    expect(second).not.toBe(first)
    expect(fx.starts()).toBe(2)
  })

  it("keeps the process up while a request is open, however long it takes, then stops it", async () => {
    const fx = await startHost({ activation: { idleStopMs: 150 } })
    const slow = get(fx.port, "/slow") // takes 500ms, three times the idle period
    await sleep(350)
    expect(fx.host.state).toBe("running")
    expect((await slow).body).toBe("slow-done")
    await waitFor(() => fx.host.state === "idle", 3_000, "idle stop after the request")
  })

  it("proxies a WebSocket-style upgrade, cold-starting through it, and an open connection pins the process", async () => {
    const fx = await startHost({ activation: { idleStopMs: 200 } })
    expect(fx.host.state).toBe("idle")
    const sock = connect({ port: fx.port, host: "127.0.0.1" })
    let received = ""
    sock.on("data", d => (received += d.toString()))
    sock.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n")
    await waitFor(() => received.includes("\r\n\r\n"), 5_000, "101 through the front")
    expect(received.startsWith("HTTP/1.1 101")).toBe(true)
    sock.write("hi")
    await waitFor(() => received.endsWith("echo:hi"), 3_000, "echo")
    // Silent for 2.5x the idle period: an open connection is not idle.
    await sleep(500)
    expect(fx.host.state).toBe("running")
    sock.end()
    await waitFor(() => fx.host.state === "idle", 3_000, "idle stop after the socket closed")
  })

  it("answers 503 with a generic body and Retry-After when the process exits before listening, and does not respawn during the backoff", async () => {
    const fx = await startHost({
      script: "process.exit(3)",
      restart: { baseDelayMs: 400, factor: 2, maxDelayMs: 2_000 },
    })
    const first = await get(fx.port)
    expect(first.status).toBe(503)
    expect(first.body).toBe("service unavailable\n")
    expect(first.headers["retry-after"]).toBe("1")
    expect(fx.rows()).toBe(1)
    // Inside the gap the host refuses without spawning.
    const second = await get(fx.port)
    expect(second.status).toBe(503)
    expect(fx.rows()).toBe(1)
    // After it, one more try, and the gap doubles (800ms => Retry-After 1).
    await sleep(450)
    expect((await get(fx.port)).status).toBe(503)
    expect(fx.rows()).toBe(2)
    expect(fx.host.state).toBe("idle")
    expect(fx.host.disposed).toBe(false) // no give-up state: still listening
  })

  it("answers 503 and kills the process when nothing listens within startTimeoutMs", async () => {
    const fx = await startHost({
      script: "setInterval(() => {}, 1000)",
      activation: { startTimeoutMs: 300 },
    })
    const t0 = Date.now()
    const res = await get(fx.port)
    expect(res.status).toBe(503)
    expect(Date.now() - t0).toBeLessThan(2_000)
    const row = registry.list().find(r => r.id === fx.host.sessionId)
    expect(row?.pid).toBeDefined()
    await waitFor(() => !alive(row!.pid!), 3_000, "stuck process killed")
  })

  it("returns to idle when the process crashes, counts it, and starts again after the backoff", async () => {
    const fx = await startHost({ restart: { baseDelayMs: 400, factor: 2, maxDelayMs: 2_000 } })
    const first = JSON.parse((await get(fx.port)).body).pid as number
    const crashed = await get(fx.port, "/crash").catch(() => ({ status: 0 }))
    expect([0, 502]).toContain(crashed.status)
    await waitFor(() => fx.host.state === "idle", 3_000, "idle after the crash")
    expect(alive(first)).toBe(false)
    // Crash loop guard: an immediate request is refused, not respawned.
    expect((await get(fx.port)).status).toBe(503)
    expect(fx.starts()).toBe(1)
    await sleep(450)
    const again = JSON.parse((await get(fx.port)).body)
    expect(again.pid).not.toBe(first)
    expect(fx.starts()).toBe(2)
  })

  it("treats an operator kill of the process row as a stop, not a failure", async () => {
    const fx = await startHost({ restart: { baseDelayMs: 5_000 } })
    const first = JSON.parse((await get(fx.port)).body).pid as number
    registry.kill(fx.host.sessionId)
    await waitFor(() => fx.host.state === "idle", 3_000, "idle after the kill")
    expect(alive(first)).toBe(false)
    // No backoff: the very next request starts it again.
    const again = await get(fx.port)
    expect(again.status).toBe(200)
    expect(JSON.parse(again.body).pid).not.toBe(first)
  })

  it("fails to start when something else holds the declared port", async () => {
    const holder = createNetServer()
    servers.push(holder)
    await new Promise<void>(r => holder.listen(0, "127.0.0.1", r))
    const held = (holder.address() as { port: number }).port
    const res = await startOnDemandService({
      registry,
      appId: APP_ID,
      dir: process.cwd(),
      service: { name: "held", command: process.execPath, args: ["-e", ""], port: held, activation: { mode: "on-demand" } },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain(`port ${held} is already in use`)
    expect(onDemandServiceState(APP_ID, "held")).toBeUndefined()
  })

  it("is stopped by the supervisor kill path: listener closed, process killed", async () => {
    const fx = await startHost()
    const pid = JSON.parse((await get(fx.port)).body).pid as number
    expect(isAppServiceSupervised(APP_ID, fx.name)).toBe(true)
    expect(onDemandServiceState(APP_ID, fx.name)).toBe("running")
    expect(await stopAppServiceSupervisor(APP_ID, fx.name)).toBe(true)
    expect(fx.host.disposed).toBe(true)
    expect(alive(pid)).toBe(false)
    expect(await canConnect(fx.port)).toBe(false)
    expect(isAppServiceSupervised(APP_ID, fx.name)).toBe(false)
    expect(onDemandServiceState(APP_ID, fx.name)).toBeUndefined()
  })

  it("stopAllOnDemandServices stops every host (daemon shutdown)", async () => {
    const a = await startHost()
    const b = await startHost()
    const pid = JSON.parse((await get(a.port)).body).pid as number
    await stopAllOnDemandServices()
    expect(a.host.disposed && b.host.disposed).toBe(true)
    expect(alive(pid)).toBe(false)
    expect(await canConnect(a.port)).toBe(false)
  })

  it("a new host for the same service takes over the declared port from the old one", async () => {
    const fx = await startHost({ name: "takeover" })
    const next = await startOnDemandService({
      registry,
      appId: APP_ID,
      dir: process.cwd(),
      service: { name: "takeover", command: process.execPath, args: ["-e", ECHO_SERVICE], port: fx.port, activation: { mode: "on-demand" } },
    })
    expect(next.ok).toBe(true)
    if (next.ok) hosts.push(next.handle)
    expect(fx.host.disposed).toBe(true)
    expect((await get(fx.port)).status).toBe(200)
  })
})
