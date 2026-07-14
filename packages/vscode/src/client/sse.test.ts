import { describe, expect, it, vi } from "vitest"

import { subscribeSse } from "./sse.js"

/** Build a fetch impl that serves a scripted sequence of responses. */
function scriptedFetch(
  scripts: Array<{ status?: number; chunks?: string[]; body?: string; delayMs?: number }>,
): typeof fetch {
  let call = 0
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    void url
    const signal = init?.signal
    const script = scripts[Math.min(call, scripts.length - 1)]!
    call++
    const status = script.status ?? 200
    if (status !== 200 || script.body !== undefined) {
      return new Response(script.body ?? "", { status })
    }
    // Stream chunks as a ReadableStream that aborts when the fetch signal
    // fires — mirroring how a real fetch response body cancels on abort.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal) {
          if (signal.aborted) {
            controller.error(new DOMException("Aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"))
          })
        }
        void (async () => {
          for (const chunk of script.chunks ?? []) {
            if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs))
            if (signal?.aborted) return
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        })()
      },
    })
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
}

describe("subscribeSse — frame parsing", () => {
  it("parses a single-line data: frame as JSON", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { chunks: [`data: ${JSON.stringify({ line: "hello", stream: "stdout" })}\n\n`] },
    ])
    const sub = subscribeSse("http://x/s1/stream", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ line: "hello", stream: "stdout" }])
  })

  it("parses multi-line data: frames (concatenated with \\n)", async () => {
    const events: unknown[] = []
    const payload = JSON.stringify({ a: 1, b: 2 })
    const fetchImpl = scriptedFetch([
      { chunks: [`data: ${payload.slice(0, 5)}\ndata: ${payload.slice(5)}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ a: 1, b: 2 }])
  })

  it("ignores keep-alive comment lines (: keep-alive)", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { chunks: [`: keep-alive\n\ndata: ${JSON.stringify({ x: 1 })}\n\n: keep-alive\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ x: 1 }])
  })

  it("ignores event/id fields and only emits data", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { chunks: [`event: message\nid: 42\ndata: ${JSON.stringify({ y: 2 })}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ y: 2 }])
  })

  it("handles a frame split across multiple chunks", async () => {
    const events: unknown[] = []
    const payload = JSON.stringify({ line: "split" })
    const fetchImpl = scriptedFetch([
      { chunks: [`data: ${payload.slice(0, 3)}`, `${payload.slice(3)}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ line: "split" }])
  })

  it("swallows non-JSON data frames without killing the stream", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { chunks: [`data: not-json\n\ndata: ${JSON.stringify({ ok: true })}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ ok: true }])
  })

  it("handles CRLF (\\r\\n) line endings", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { chunks: [`data: ${JSON.stringify({ crlf: true })}\r\n\r\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    await new Promise(r => setTimeout(r, 50))
    sub.close()
    expect(events).toEqual([{ crlf: true }])
  })
})

describe("subscribeSse — reconnect + error handling", () => {
  it("reconnects after the stream closes (server drops connection)", async () => {
    const events: unknown[] = []
    // First call: one event then EOF. Second call: another event then EOF.
    const fetchImpl = scriptedFetch([
      { chunks: [`data: ${JSON.stringify({ n: 1 })}\n\n`] },
      { chunks: [`data: ${JSON.stringify({ n: 2 })}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    // Backoff starts at 1s; wait long enough for one reconnect.
    await new Promise(r => setTimeout(r, 1300))
    sub.close()
    expect(events).toContainEqual({ n: 1 })
    expect(events).toContainEqual({ n: 2 })
  })

  it("reports HTTP errors via onError and reconnects", async () => {
    const onError = vi.fn()
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([
      { status: 500 },
      { chunks: [`data: ${JSON.stringify({ recovered: true })}\n\n`] },
    ])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e), onError }, fetchImpl)
    await new Promise(r => setTimeout(r, 1300))
    sub.close()
    expect(onError).toHaveBeenCalled()
    expect(events).toContainEqual({ recovered: true })
  })

  it("close() aborts the in-flight request and stops the loop", async () => {
    const events: unknown[] = []
    const fetchImpl = scriptedFetch([{ chunks: [`data: ${JSON.stringify({ late: true })}\n\n`], delayMs: 80 }])
    const sub = subscribeSse("http://x", {}, { onEvent: e => events.push(e) }, fetchImpl)
    // Close immediately — the delayed chunk should never be delivered.
    sub.close()
    await new Promise(r => setTimeout(r, 200))
    expect(events).toEqual([])
  })
})
