/**
 * Test harness: a real local rendezvous broker, the real Node daemon side
 * (`createPairingRegistry` from @agentproto/runtime — node:crypto handshake and
 * `wrapE2E`, serving a real `createTunnelServer`), and a scripted HTTP
 * upstream behind it. The client under test only ever sees the broker URL.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import { vi } from "vitest"
import { createTunnelServer, wrapWebSocket, type FrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity } from "@agentproto/secrets/identity"
import { createRendezvousServer, type RendezvousServer } from "@agentproto/rendezvous"
import { createPairingRegistry, type PairingRegistry } from "@agentproto/runtime"
import type { WebSocketConstructor } from "../channel.js"

export interface Upstream {
  /** Every request the daemon forwarded upstream. */
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[]
  /** `/sse`: releases the second event (the first is sent at once). */
  releaseSse(): void
  /** Resolves once the upstream `/forever` stream was cancelled. */
  foreverCancelled: Promise<void>
}

/** The daemon's HTTP upstream, via the global `fetch` the tunnel server calls.
 *
 *   /sse        text/event-stream: event 1 now, event 2 only after releaseSse()
 *   /forever    text/event-stream that never ends (observes cancellation)
 *   /slow/<ms>  JSON after <ms>
 *   /status/<n> empty body with status n
 *   anything    JSON echo of method, path, headers, body
 */
export function stubUpstream(): Upstream {
  let release!: () => void
  const released = new Promise<void>(r => (release = r))
  let markCancelled!: () => void
  const foreverCancelled = new Promise<void>(r => (markCancelled = r))
  const requests: Upstream["requests"] = []
  const enc = new TextEncoder()

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url))
      const path = u.pathname.replace(/^\/upstream/, "") + u.search
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
      const body = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : ""
      requests.push({ method: init?.method ?? "GET", path, headers, body })

      if (u.pathname.endsWith("/sse")) {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode("event: tick\ndata: 1\n\n"))
            await released
            c.enqueue(enc.encode("event: tick\ndata: 2\n\n"))
            c.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      if (u.pathname.endsWith("/forever")) {
        let n = 0
        const stream = new ReadableStream<Uint8Array>({
          async pull(c) {
            await new Promise(r => setTimeout(r, 20))
            c.enqueue(enc.encode(`data: ${n++}\n\n`))
          },
          cancel() {
            markCancelled()
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      const slow = /\/slow\/(\d+)$/.exec(u.pathname)
      if (slow) {
        await new Promise(r => setTimeout(r, Number(slow[1])))
        return Response.json({ slow: Number(slow[1]), path })
      }
      const status = /\/status\/(\d+)$/.exec(u.pathname)
      if (status) return new Response(null, { status: Number(status[1]), headers: { "x-status": status[1]! } })
      return new Response(JSON.stringify({ method: init?.method ?? "GET", path, headers, body }), {
        status: 200,
        headers: { "content-type": "application/json", "x-upstream": "yes" },
      })
    }),
  )
  return { requests, releaseSse: () => release(), foreverCancelled }
}

export interface Daemon {
  registry: PairingRegistry
  rendezvous: RendezvousServer
  rvUrl: string
  upstream: Upstream
  /** A fresh offer URL (daemon parked on the broker, ready for the client). */
  offer(): Promise<string>
  teardown(): Promise<void>
}

export async function startDaemon(opts: { label?: string } = {}): Promise<Daemon> {
  const tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-client-"))
  const identity = await generateIdentity()
  const upstream = stubUpstream()
  const rendezvous = createRendezvousServer({ parkTimeoutMs: 5_000 })
  const { port } = await rendezvous.listen(0, "127.0.0.1")
  const rvUrl = `ws://127.0.0.1:${port}/v1`
  const daemonSockets: WebSocket[] = []

  const dial = async (url: string, signal: AbortSignal): Promise<FrameSink> => {
    const ws = new WebSocket(url)
    daemonSockets.push(ws)
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        ws.close()
        reject(new Error("aborted"))
      }
      ws.once("open", () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      })
      ws.once("error", err => reject(err))
      signal.addEventListener("abort", onAbort)
    })
    return wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
  }

  const registry = createPairingRegistry({
    loadIdentity: async () => identity,
    pairingsPath: join(tmp, "pairings.json"),
    defaultRendezvousUrl: rvUrl,
    dial,
    serve: sink => {
      const server = createTunnelServer({
        sink,
        authorize: r => r,
        httpUpstream: "http://127.0.0.1:1/upstream",
        ...(opts.label ? { label: opts.label } : {}),
        pty: false,
      })
      return { close: () => server.close() }
    },
    handshakeTimeoutMs: 4_000,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
  })

  return {
    registry,
    rendezvous,
    rvUrl,
    upstream,
    async offer() {
      const before = rendezvous.stats.parked
      const offer = await registry.createOffer({ ttlMs: 60_000 })
      await vi.waitFor(() => {
        if (rendezvous.stats.parked <= before) throw new Error("daemon not parked yet")
      })
      return offer.url
    },
    async teardown() {
      vi.unstubAllGlobals()
      await registry.shutdown().catch(() => {})
      for (const ws of daemonSockets) ws.terminate()
      await rendezvous.close().catch(() => {})
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** The WHATWG `WebSocket` global (the browser API; Node ≥ 22), wrapped so a
 *  test can count dials and reach the live sockets. */
export function countingWebSocket(): { WebSocket: WebSocketConstructor; sockets: globalThis.WebSocket[] } {
  const sockets: globalThis.WebSocket[] = []
  const Native = globalThis.WebSocket
  const Counting = function (url: string) {
    const ws = new Native(url)
    sockets.push(ws)
    return ws
  } as unknown as WebSocketConstructor
  return { WebSocket: Counting, sockets }
}

export async function readAll(res: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))
}
