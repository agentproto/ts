/**
 * The operator-only heap routes (E99): `GET /debug/heap` and
 * `POST /debug/heap-snapshot`, gated on the daemon bearer or a local
 * non-browser call, and refused to a session principal.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { startHttpServer } from "../http-server.js"
import { CALLER_SESSION_ID_HEADER, createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { HeapReport, HeapSnapshotResult } from "../heap-diagnostics.js"

const report: HeapReport = {
  at: "2026-11-02T01:00:00.000Z",
  memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  majorGcs: 0,
  handles: {},
  structures: { sessions: { total: 1, live: 0 } },
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close(err => (err ? reject(err) : resolve())))
  return port
}

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

async function serve(snapshot: () => HeapSnapshotResult, token?: string): Promise<string> {
  const port = await freePort()
  const base = createSessionsRegistry({ persist: false })
  // A claim naming a session the daemon spawned is a session principal.
  const sessions = {
    ...base,
    get: (id: string) => (id === "sess_spawned" ? { id, kind: "agent-cli" } : base.get(id)),
  } as unknown as SessionsRegistry
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    ...(token ? { token } : {}),
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "test", version: "0" })).server,
    conversations: { async open() {}, async appendTurn() {}, async read() { return { meta: {} as never, turns: [] } }, async list() { return [] }, pathFor: id => id },
    events: createRuntimeEvents(),
    heartbeat: { start() {}, stop() {}, async fireNow() {} },
    sessions,
    meta: { workspace: process.cwd(), registered: [] },
    heapDiagnostics: { report: () => report, snapshot },
  })
  stops.push(() => http.stop())
  return `http://127.0.0.1:${port}`
}

describe("heap diagnostics routes", () => {
  it("serves the report and a snapshot to a local operator call", async () => {
    const snapshot = vi.fn((): HeapSnapshotResult => ({
      ok: true,
      path: "/tmp/x.heapsnapshot",
      heapUsed: 3,
      freeBytes: 9,
      durationMs: 1,
      warning: "blocks",
    }))
    const url = await serve(snapshot)
    const r = await fetch(`${url}/debug/heap`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(report)
    const s = await fetch(`${url}/debug/heap-snapshot`, { method: "POST" })
    expect(s.status).toBe(200)
    expect(await s.json()).toMatchObject({ ok: true, path: "/tmp/x.heapsnapshot" })
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it("refuses a browser call without the bearer, accepts the bearer", async () => {
    const snapshot = vi.fn((): HeapSnapshotResult => ({ ok: false, error: "snapshot_failed", message: "x" }))
    const url = await serve(snapshot, "tok")
    const browser = await fetch(`${url}/debug/heap-snapshot`, { method: "POST", headers: { origin: "http://localhost:3000" } })
    expect(browser.status).toBe(401)
    expect(snapshot).not.toHaveBeenCalled()
    const withBearer = await fetch(`${url}/debug/heap`, { headers: { origin: "http://localhost:3000", authorization: "Bearer tok" } })
    expect(withBearer.status).toBe(200)
  })

  it("refuses a session principal", async () => {
    const snapshot = vi.fn((): HeapSnapshotResult => ({ ok: false, error: "snapshot_failed", message: "x" }))
    const url = await serve(snapshot)
    const r = await fetch(`${url}/debug/heap-snapshot`, { method: "POST", headers: { [CALLER_SESSION_ID_HEADER]: "sess_spawned" } })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: "operator_only" })
    expect(snapshot).not.toHaveBeenCalled()
  })

  it("answers 507 when the guard refuses for lack of memory", async () => {
    const url = await serve(() => ({
      ok: false,
      error: "insufficient_memory",
      message: "refusing",
      heapUsed: 10,
      freeBytes: 1,
      requiredBytes: 20,
    }))
    const r = await fetch(`${url}/debug/heap-snapshot`, { method: "POST" })
    expect(r.status).toBe(507)
    expect(await r.json()).toMatchObject({ error: "insufficient_memory", requiredBytes: 20 })
  })
})
