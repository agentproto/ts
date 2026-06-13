import { describe, it, expect } from "vitest"
import {
  createTunnelServer,
  type UpstreamWebSocket,
} from "../tunnel/server.js"
import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"

/** A FrameSink that records sent frames AND exposes the inbound handler so a
 *  test can push host→daemon frames (the existing capability test only needs
 *  the construction-time hello, so it doesn't wire ingest). */
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

/** A no-op upstream socket — the dial succeeds, we only assert the URL it was
 *  asked to dial (the resolution is the unit under test, not the piping). */
function fakeUpstream(): UpstreamWebSocket {
  return {
    protocol: "",
    send: () => {},
    close: () => {},
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
  }
}

const ackOf = (sent: TunnelFrame[]) =>
  sent.find(f => f.t === "ws_open_ack") as
    | Extract<TunnelFrame, { t: "ws_open_ack" }>
    | undefined

const flush = () => new Promise(resolve => setImmediate(resolve))

describe("tunnel WS upstream resolution", () => {
  it("dials a resolved import origin when ws_open names an upstream alias", async () => {
    const { sink, sent, push } = pairedSink()
    let dialed: string | undefined
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      resolveWsUpstream: alias =>
        alias === "bureau" ? "http://127.0.0.1:8830" : undefined,
      dialUpstreamWs: async ({ url }) => {
        dialed = url
        return fakeUpstream()
      },
    })

    push({
      t: "ws_open",
      reqId: "r1",
      path: "/watch/tab-1?fps=4",
      upstream: "bureau",
    })
    await flush()

    // The watch rides the import's own origin, not the default gateway.
    expect(dialed).toBe("ws://127.0.0.1:8830/watch/tab-1?fps=4")
    expect(ackOf(sent)).toMatchObject({ reqId: "r1", status: 101 })
  })

  it("falls back to the default gateway when no upstream is named", async () => {
    const { sink, push } = pairedSink()
    let dialed: string | undefined
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      resolveWsUpstream: () => "http://127.0.0.1:8830",
      dialUpstreamWs: async ({ url }) => {
        dialed = url
        return fakeUpstream()
      },
    })

    push({ t: "ws_open", reqId: "r2", path: "/sessions/abc/pty" })
    await flush()

    expect(dialed).toBe("ws://127.0.0.1:18790/sessions/abc/pty")
  })

  it("rejects an unknown upstream alias without dialing", async () => {
    const { sink, sent, push } = pairedSink()
    let dialCount = 0
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      resolveWsUpstream: () => undefined,
      dialUpstreamWs: async () => {
        dialCount += 1
        return fakeUpstream()
      },
    })

    push({ t: "ws_open", reqId: "r3", path: "/watch/x", upstream: "ghost" })
    await flush()

    expect(dialCount).toBe(0)
    expect(ackOf(sent)).toMatchObject({
      reqId: "r3",
      status: 502,
      error: { code: "unknown_ws_upstream" },
    })
  })

  it("rejects with 504 when the dial exceeds wsDialTimeoutMs", async () => {
    const { sink, sent, push } = pairedSink()
    let abortedReason: string | undefined
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      wsDialTimeoutMs: 20,
      // A dial that never settles on its own — only the server's timeout (which
      // aborts the signal) ends the wait. Honour the signal so the test also
      // proves the abort is wired through.
      dialUpstreamWs: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const reason = signal.reason
            abortedReason = reason instanceof Error ? reason.message : "aborted"
            reject(reason instanceof Error ? reason : new Error("aborted"))
          })
        }),
    })

    push({ t: "ws_open", reqId: "r4", path: "/watch/slow" })
    // Wait past the 20ms dial ceiling.
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(abortedReason).toBe("ws_dial_timeout")
    expect(ackOf(sent)).toMatchObject({
      reqId: "r4",
      status: 504,
      error: { code: "upstream_ws_timeout" },
    })
  })

  it("closes an orphaned socket if a timed-out dial resolves late", async () => {
    const { sink, sent, push } = pairedSink()
    let closedCode: number | undefined
    let resolveDial: (sock: UpstreamWebSocket) => void = () => {}
    createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18790",
      wsDialTimeoutMs: 20,
      // Ignores the abort signal entirely and resolves AFTER the timeout — the
      // server must still 504 and close the late socket so it doesn't leak.
      dialUpstreamWs: () =>
        new Promise<UpstreamWebSocket>(res => {
          resolveDial = res
        }),
    })

    push({ t: "ws_open", reqId: "r5", path: "/watch/late" })
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(ackOf(sent)).toMatchObject({
      reqId: "r5",
      status: 504,
      error: { code: "upstream_ws_timeout" },
    })

    // The dial resolves late; the orphaned socket must be closed.
    resolveDial({ ...fakeUpstream(), close: code => (closedCode = code) })
    await flush()
    expect(closedCode).toBe(1001)
  })
})
