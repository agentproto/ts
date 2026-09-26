/**
 * No tunnel message may outgrow a rendezvous' message cap.
 *
 * The broker closes any WebSocket message above `maxMessageBytes` (1 MiB by
 * default, the hosted one included), and over a pairing every frame is
 * base64'd, sealed and base64'd again. A 1.4 MB page sent as one buffered
 * `http_response` was ~1.9 MB on the wire: the channel died, the client
 * reconnected, the next request died again.
 *
 * Here a real `createTunnelClient` talks to a real `createTunnelServer` through
 * `wrapE2E` on both ends, over an in-memory wire that records the size of
 * every message exactly as a WebSocket would carry it. Multi-MB bodies go
 * both ways, and WS messages both ways; every wire message must stay well
 * under 1 MiB, and every byte must arrive intact.
 */

import { randomBytes } from "node:crypto"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  createTunnelClient,
  createTunnelServer,
  wrapE2E,
  encodeFrame,
  parseFrame,
  MAX_FRAME_PAYLOAD_BYTES,
  type FrameSink,
  type TunnelFrame,
} from "../tunnel/index.js"
import type { UpstreamWebSocket } from "../tunnel/server.js"

const RDV_MAX_MESSAGE_BYTES = 1024 * 1024

/** Two raw sinks joined by a JSON-text wire; `sizes` records every message. */
function wire(): { a: FrameSink; b: FrameSink; sizes: number[]; frames: TunnelFrame[][] } {
  const sizes: number[] = []
  const frames: TunnelFrame[][] = [[], []]
  const make = (side: 0 | 1, peer: () => Set<(f: TunnelFrame) => void>): FrameSink & { handlers: Set<(f: TunnelFrame) => void> } => {
    const handlers = new Set<(f: TunnelFrame) => void>()
    return {
      handlers,
      isOpen: true,
      send(frame) {
        const text = encodeFrame(frame)
        sizes.push(Buffer.byteLength(text))
        frames[side]!.push(frame)
        setImmediate(() => {
          const f = parseFrame(text)!
          for (const h of peer()) h(f)
        })
      },
      close() {},
      onFrame: h => (handlers.add(h), () => handlers.delete(h)),
      onClose: () => () => {},
    }
  }
  const a = make(0, () => b.handlers)
  const b = make(1, () => a.handlers)
  return { a, b, sizes, frames }
}

function e2ePair() {
  const w = wire()
  const k1 = randomBytes(32)
  const k2 = randomBytes(32)
  const host = wrapE2E(w.a, { sendKey: k1, recvKey: k2 })
  const daemon = wrapE2E(w.b, { sendKey: k2, recvKey: k1 })
  return { host, daemon, sizes: w.sizes }
}

/** A fixed pseudo-random body (compressible-free, so nothing hides size). */
function body(n: number, seed = 7): Buffer {
  const out = Buffer.alloc(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe("tunnel frames stay under the rendezvous message cap", () => {
  it("a multi-MB buffered response goes out as head + bounded chunks and reassembles", async () => {
    const big = body(3 * 1024 * 1024 + 123)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(big, { headers: { "content-type": "text/html" } })),
    )
    const { host, daemon, sizes } = e2ePair()
    createTunnelServer({ sink: daemon, authorize: r => r, httpUpstream: "http://127.0.0.1:1" })
    const client = createTunnelClient({ sink: host })
    await client.ready()

    const res = await client.forwardHttp({ method: "GET", path: "/apps/x/ui/" })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/html")
    expect(Buffer.compare(res.body, big)).toBe(0)

    // The streaming API reads the same bytes.
    const streamed = await client.forwardHttpStream({ method: "GET", path: "/apps/x/ui/" })
    const parts: Uint8Array[] = []
    const reader = streamed.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(Buffer.compare(Buffer.concat(parts), big)).toBe(0)

    expect(Math.max(...sizes)).toBeLessThan(RDV_MAX_MESSAGE_BYTES / 2)
  }, 30_000)

  it("a single huge upstream stream read is split too", async () => {
    const big = body(2 * 1024 * 1024, 3)
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(big))
                c.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    )
    const { host, daemon, sizes } = e2ePair()
    createTunnelServer({ sink: daemon, authorize: r => r, httpUpstream: "http://127.0.0.1:1" })
    const client = createTunnelClient({ sink: host })
    const res = await client.forwardHttp({ method: "GET", path: "/events" })
    expect(Buffer.compare(res.body, big)).toBe(0)
    expect(Math.max(...sizes)).toBeLessThan(RDV_MAX_MESSAGE_BYTES / 2)
  }, 30_000)

  it("a multi-MB request body is sent as http_request_chunk frames and forwarded intact", async () => {
    const big = body(3 * 1024 * 1024 + 7, 11)
    let received: Buffer | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        received = Buffer.from(init!.body as Uint8Array)
        return Response.json({ n: received.length })
      }),
    )
    const { host, daemon, sizes } = e2ePair()
    createTunnelServer({ sink: daemon, authorize: r => r, httpUpstream: "http://127.0.0.1:1" })
    const client = createTunnelClient({ sink: host })
    const hello = await client.ready()
    expect(hello.capabilities.httpRequestChunks).toBe(true)

    const res = await client.forwardHttp({ method: "POST", path: "/upload", body: big })
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ n: big.length })
    expect(Buffer.compare(received!, big)).toBe(0)
    expect(Math.max(...sizes)).toBeLessThan(RDV_MAX_MESSAGE_BYTES / 2)

    // Small bodies stay inline.
    await client.forwardHttp({ method: "POST", path: "/small", body: "hi" })
    expect(received!.toString("utf8")).toBe("hi")
  }, 30_000)

  it("bounds an assembled request body (413) and drops it on http_cancel", async () => {
    const upstream = vi.fn(async () => Response.json({}))
    vi.stubGlobal("fetch", upstream)
    const w = wire()
    const got: TunnelFrame[] = []
    w.a.onFrame(f => got.push(f))
    createTunnelServer({
      sink: w.b,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:1",
      maxRequestBodyBytes: 1000,
    })
    const piece = Buffer.alloc(600).toString("base64")
    w.a.send({ t: "http_request", reqId: "big", method: "POST", path: "/x", bodyChunked: true })
    w.a.send({ t: "http_request_chunk", reqId: "big", data: piece })
    w.a.send({ t: "http_request_chunk", reqId: "big", data: piece, end: true })
    w.a.send({ t: "http_request", reqId: "gone", method: "POST", path: "/x", bodyChunked: true })
    w.a.send({ t: "http_request_chunk", reqId: "gone", data: piece })
    w.a.send({ t: "http_cancel", reqId: "gone" })
    w.a.send({ t: "http_request_chunk", reqId: "gone", data: piece, end: true })
    await vi.waitFor(() => expect(got.some(f => f.t === "http_response")).toBe(true))
    await new Promise(r => setTimeout(r, 30))
    expect(got.filter(f => f.t === "http_response")).toEqual([
      expect.objectContaining({ reqId: "big", status: 413 }),
    ])
    expect(upstream).not.toHaveBeenCalled()
  })

  it("large WS messages are fragmented both ways when negotiated, and reassembled", async () => {
    const toBrowser = body(1536 * 1024, 5)
    const fromBrowser = body(1200 * 1024, 9)
    let onUpstreamMessage: ((data: Buffer, isBinary: boolean) => void) | null = null
    const upstreamGot: { data: Buffer; binary: boolean }[] = []
    const upstream: UpstreamWebSocket = {
      protocol: "",
      send: (data, o) => void upstreamGot.push({ data: Buffer.from(data), binary: o.binary }),
      close: () => {},
      onMessage: h => void (onUpstreamMessage = h),
      onClose: () => {},
      onError: () => {},
    }
    const { host, daemon, sizes } = e2ePair()
    createTunnelServer({
      sink: daemon,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:1",
      dialUpstreamWs: async () => upstream,
    })
    const client = createTunnelClient({ sink: host })
    expect((await client.ready()).capabilities.wsFragments).toBe(true)
    const ws = await client.forwardWebSocket({ path: "/sessions/s/pty" })
    const browserGot: { data: Buffer; binary: boolean }[] = []
    ws.onMessage((data, binary) => browserGot.push({ data, binary }))

    onUpstreamMessage!(toBrowser, true)
    onUpstreamMessage!(Buffer.from("small"), false)
    ws.send(new Uint8Array(fromBrowser))
    ws.send("tiny")

    await vi.waitFor(() => expect(browserGot).toHaveLength(2))
    expect(Buffer.compare(browserGot[0]!.data, toBrowser)).toBe(0)
    expect(browserGot[0]!.binary).toBe(true)
    expect(browserGot[1]).toEqual({ data: Buffer.from("small"), binary: false })
    await vi.waitFor(() => expect(upstreamGot).toHaveLength(2))
    expect(Buffer.compare(upstreamGot[0]!.data, fromBrowser)).toBe(0)
    expect(upstreamGot[1]).toEqual({ data: Buffer.from("tiny"), binary: false })
    expect(Math.max(...sizes)).toBeLessThan(RDV_MAX_MESSAGE_BYTES / 2)
  }, 30_000)

  it("stays compatible: no fragments to a host that didn't ask, no chunked body to an old daemon", async () => {
    // Daemon side: a ws_open without `fragments` gets whole messages.
    let onUpstreamMessage: ((data: Buffer, isBinary: boolean) => void) | null = null
    const w = wire()
    const got: TunnelFrame[] = []
    w.a.onFrame(f => got.push(f))
    createTunnelServer({
      sink: w.b,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:1",
      dialUpstreamWs: async () => ({
        protocol: "",
        send: () => {},
        close: () => {},
        onMessage: h => void (onUpstreamMessage = h),
        onClose: () => {},
        onError: () => {},
      }),
    })
    w.a.send({ t: "ws_open", reqId: "old", path: "/p" })
    await vi.waitFor(() => expect(got.some(f => f.t === "ws_open_ack")).toBe(true))
    onUpstreamMessage!(Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES * 2 + 1), true)
    await vi.waitFor(() => expect(got.some(f => f.t === "ws_message")).toBe(true))
    await new Promise(r => setTimeout(r, 20))
    const msgs = got.filter(f => f.t === "ws_message")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).not.toHaveProperty("more")

    // Host side: a daemon whose hello lacks httpRequestChunks gets the body inline.
    const w2 = wire()
    const client = createTunnelClient({ sink: w2.a })
    w2.b.send({ t: "hello", version: "agentproto/tunnel/v1", capabilities: { pty: false } })
    await client.ready()
    void client.forwardHttp({ method: "POST", path: "/x", body: Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 10) }).catch(() => {})
    const requestFrames = () => w2.frames[0]!.filter(f => f.t === "http_request" || f.t === "http_request_chunk")
    await vi.waitFor(() => expect(requestFrames().length).toBeGreaterThan(0))
    await new Promise(r => setTimeout(r, 20))
    const sent = requestFrames()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: "http_request", body: expect.any(String) })
    expect(sent[0]).not.toHaveProperty("bodyChunked")
    await client.close()
  })
})
