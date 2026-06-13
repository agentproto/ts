import { describe, it, expect, vi, afterEach } from "vitest"
import { createTunnelServer } from "../tunnel/server.js"
import { decodeData } from "../tunnel/frames.js"
import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"

/** FrameSink that records sent frames and exposes the inbound handler so a test
 *  can push host→daemon frames. */
function pairedSink(): {
  sink: FrameSink
  sent: TunnelFrame[]
  push: (frame: TunnelFrame) => void
} {
  const sent: TunnelFrame[] = []
  let open = true
  let onFrame: ((f: TunnelFrame) => void) | undefined
  const sink: FrameSink = {
    send: frame => {
      sent.push(frame)
    },
    close: () => {
      open = false
    },
    onFrame: handler => {
      onFrame = handler
      return () => {}
    },
    onClose: () => () => {},
    get isOpen() {
      return open
    },
  }
  return { sink, sent, push: f => onFrame?.(f) }
}

const responseOf = (sent: TunnelFrame[]) =>
  sent.find(f => f.t === "http_response") as
    | Extract<TunnelFrame, { t: "http_response" }>
    | undefined

const chunksOf = (sent: TunnelFrame[]) =>
  sent.filter(f => f.t === "http_response_chunk") as Extract<
    TunnelFrame,
    { t: "http_response_chunk" }
  >[]

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A `fetch` Response stand-in for a buffered (non-stream) reply. */
function bufferedResponse(status: number, contentType: string, body: string) {
  return {
    status,
    headers: { forEach: (cb: (v: string, k: string) => void) => cb(contentType, "content-type") },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

/** A streaming Response whose reader yields `chunks` (each after `gapMs`),
 *  then either ends or — if `stallAtEnd` — hangs forever. */
function streamingResponse(
  chunks: string[],
  gapMs: number,
  stallAtEnd: boolean,
) {
  let i = 0
  const reader = {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>(resolve => {
        if (i < chunks.length) {
          const c = chunks[i++]!
          setTimeout(() => resolve({ done: false, value: new TextEncoder().encode(c) }), gapMs)
        } else if (stallAtEnd) {
          /* never resolves — simulates a silent upstream stall */
        } else {
          setTimeout(() => resolve({ done: true }), gapMs)
        }
      }),
    cancel: async () => {},
  }
  return {
    status: 200,
    headers: {
      forEach: (cb: (v: string, k: string) => void) =>
        cb("text/event-stream", "content-type"),
    },
    body: { getReader: () => reader },
  }
}

describe("tunnel HTTP forward bounds", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("forwards a buffered response on the happy path", async () => {
    const { sink, sent, push } = pairedSink()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bufferedResponse(200, "application/json", '{"ok":true}')),
    )
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
    })

    push({ t: "http_request", reqId: "h1", method: "GET", path: "/data" })
    await wait(10)

    const res = responseOf(sent)
    expect(res?.status).toBe(200)
    expect(decodeData(res!.body!).toString("utf8")).toBe('{"ok":true}')
  })

  it("replies 504 timeout when a buffered forward exceeds the ceiling", async () => {
    const { sink, sent, push } = pairedSink()
    let sawAbort = false
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              sawAbort = true
              const e = new Error("aborted")
              e.name = "AbortError"
              reject(e)
            })
          }),
      ),
    )
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      httpForwardTimeoutMs: 20,
    })

    push({ t: "http_request", reqId: "h2", method: "GET", path: "/slow" })
    await wait(60)

    expect(sawAbort).toBe(true)
    expect(responseOf(sent)).toMatchObject({
      reqId: "h2",
      status: 504,
      error: { code: "timeout" },
    })
  })

  it("the per-frame timeoutMs overrides the server default", async () => {
    const { sink, sent, push } = pairedSink()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted")
              e.name = "AbortError"
              reject(e)
            })
          }),
      ),
    )
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      httpForwardTimeoutMs: 5_000, // would not fire within the test window
    })

    push({ t: "http_request", reqId: "h3", method: "GET", path: "/x", timeoutMs: 20 })
    await wait(60)

    expect(responseOf(sent)).toMatchObject({ reqId: "h3", status: 504 })
  })

  it("ends a stalled stream with upstream_stream_idle_timeout", async () => {
    const { sink, sent, push } = pairedSink()
    // Headers arrive, one chunk flows, then the upstream goes silent forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(["event: hi\n\n"], 0, true)),
    )
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      httpStreamIdleTimeoutMs: 25,
    })

    push({ t: "http_request", reqId: "s1", method: "GET", path: "/sse" })
    await wait(80)

    // Head emitted, the one real chunk delivered, then an idle-timeout end.
    expect(sent.some(f => f.t === "http_response_head")).toBe(true)
    const chunks = chunksOf(sent)
    expect(chunks.some(c => c.data)).toBe(true)
    const end = chunks.find(c => c.end)
    expect(end?.error).toMatchObject({ code: "upstream_stream_idle_timeout" })
  })

  it("does not cut a stream that keeps sending within the idle window", async () => {
    const { sink, sent, push } = pairedSink()
    // 3 chunks, 10ms apart, then clean end — all within a 50ms idle window.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(["a", "b", "c"], 10, false)),
    )
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      httpStreamIdleTimeoutMs: 50,
    })

    push({ t: "http_request", reqId: "s2", method: "GET", path: "/sse" })
    await wait(120)

    const chunks = chunksOf(sent)
    expect(chunks.filter(c => c.data).length).toBe(3)
    const end = chunks.find(c => c.end)
    expect(end).toBeDefined()
    expect(end?.error).toBeUndefined() // clean end, not an idle timeout
  })
})
