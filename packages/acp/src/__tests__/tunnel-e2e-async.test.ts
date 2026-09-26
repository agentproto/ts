/**
 * wrapE2E after the move to an async AEAD seam: byte-identity with the
 * pre-refactor build, node:crypto ↔ WebCrypto interop, ordering under async
 * crypto, graceful-close draining, and the hand-off gap between a handshake
 * and `wrapE2E` subscribing.
 */

import { describe, it, expect, vi } from "vitest"
import {
  wrapE2E,
  clientHandshakeOverSink,
  daemonHandshakeOverSink,
  type E2eKeys,
} from "../tunnel/e2e.js"
import { nodeAead } from "../tunnel/aead-node.js"
import { webCryptoAead, type E2eAead } from "../tunnel/aead.js"
import { encodeData } from "../tunnel/frames.js"
import { base64DecodePortable, base64EncodePortable } from "../tunnel/bytes.js"
import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"
import { connect, type Middleware } from "./e2e-harness.js"

const KEYS_A: E2eKeys = { sendKey: new Uint8Array(32).fill(0x11), recvKey: new Uint8Array(32).fill(0x22) }
const KEYS_B: E2eKeys = { sendKey: KEYS_A.recvKey, recvKey: KEYS_A.sendKey }

const GOLDEN_FRAMES: TunnelFrame[] = [
  { t: "ping", nonce: "golden-0" },
  { t: "http_response_chunk", reqId: "r1", data: encodeData("chunk ✓") },
  { t: "hello", version: "agentproto/tunnel/v1", capabilities: { pty: false } },
]

/** Captured from the pre-refactor, `node:crypto`-only `wrapE2E` (commit
 *  98084516) sending GOLDEN_FRAMES under KEYS_A. */
const GOLDEN_WIRE = [
  { t: "e2e", n: 0, d: "v+hqRduN7fBvfZ8p+Zy14ZIFraTawzGAHYAttjR/7fxpOcVHUIltApD0YORS1IA=" },
  {
    t: "e2e",
    n: 1,
    d: "sql86jIBV2QNSaQ3+nQKv0o90j0X1dE2MSK7RRqv2trL4oCx8dyGQF5azBceyjJ3XxOosBLySTXYQ/vtmwK6InLeygRFZU2UoKXG3AV1",
  },
  {
    t: "e2e",
    n: 2,
    d: "PbTnU9Mzjxny+VrVnghsjf2RC5fBiAqGqCJAcXgeYcArsWhDcCaqcL06LnJWKhLkb02ySL1hOY60xUp1vQELzvxdaR112VCqaLDgmIfxdOJ7CRH1ZPwH9/6pbw==",
  },
]

/** A write-only sink that records what `wrapE2E` puts on the wire. */
function recordingSink(): { sink: FrameSink; wire: TunnelFrame[] } {
  const wire: TunnelFrame[] = []
  return {
    wire,
    sink: {
      isOpen: true,
      send: f => wire.push(f),
      close() {},
      onFrame: () => () => {},
      onClose: () => () => {},
    },
  }
}

/** A linked pair like a raw WebSocket: frames delivered while nobody is
 *  subscribed are DROPPED (the e2e-harness buffers them, which would hide a
 *  hand-off gap). Delivery is a macrotask, like a socket message event. */
function lossyPair(): { a: FrameSink; b: FrameSink } {
  type End = FrameSink & { handlers: Set<(f: TunnelFrame) => void>; peer?: End }
  const make = (): End => {
    const handlers = new Set<(f: TunnelFrame) => void>()
    const closers = new Set<(r?: string) => void>()
    let open = true
    const end: End = {
      handlers,
      get isOpen() {
        return open
      },
      send(f) {
        if (!open) return
        setTimeout(() => {
          for (const h of end.peer?.handlers ?? []) h(f)
        }, 0)
      },
      close(r) {
        if (!open) return
        open = false
        for (const h of closers) h(r)
      },
      onFrame(h) {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      onClose(h) {
        closers.add(h)
        return () => closers.delete(h)
      },
    }
    return end
  }
  const a = make()
  const b = make()
  a.peer = b
  b.peer = a
  return { a, b }
}

const AEADS: [string, E2eAead][] = [
  ["node:crypto", nodeAead],
  ["WebCrypto", webCryptoAead],
]

describe.each(AEADS)("wrapE2E wire byte-identity (%s)", (_name, aead) => {
  it("emits exactly the envelopes the pre-refactor build emitted", async () => {
    const { sink, wire } = recordingSink()
    const w = wrapE2E(sink, KEYS_A, { aead })
    for (const f of GOLDEN_FRAMES) w.send(f)
    await vi.waitFor(() => expect(wire).toHaveLength(GOLDEN_WIRE.length))
    expect(wire).toEqual(GOLDEN_WIRE)
  })
})

describe("wrapE2E across implementations", () => {
  it.each([
    ["node:crypto → WebCrypto", nodeAead, webCryptoAead],
    ["WebCrypto → node:crypto", webCryptoAead, nodeAead],
  ])("%s: frames flow both ways", async (_name, left, right) => {
    const { a, b } = connect()
    const l = wrapE2E(a, KEYS_A, { aead: left })
    const r = wrapE2E(b, KEYS_B, { aead: right })
    const atR: TunnelFrame[] = []
    const atL: TunnelFrame[] = []
    r.onFrame(f => atR.push(f))
    l.onFrame(f => atL.push(f))
    for (const f of GOLDEN_FRAMES) l.send(f)
    r.send({ t: "pong", nonce: "back" })
    await vi.waitFor(() => {
      expect(atR).toEqual(GOLDEN_FRAMES)
      expect(atL).toEqual([{ t: "pong", nonce: "back" }])
    })
  })
})

describe.each(AEADS)("wrapE2E ordering and lifecycle under async crypto (%s)", (_name, aead) => {
  it("keeps strict order across a burst of large and small frames", async () => {
    const { a, b } = connect()
    const c = wrapE2E(a, KEYS_A, { aead })
    const d = wrapE2E(b, KEYS_B, { aead })
    const got: string[] = []
    d.onFrame(f => {
      if (f.t === "stdout") got.push(f.execId)
    })
    const N = 300
    for (let i = 0; i < N; i++) {
      // Alternate big and tiny payloads so per-frame crypto latency varies.
      const size = i % 3 === 0 ? 64 * 1024 : 3
      c.send({ t: "stdout", execId: String(i), data: encodeData(new Uint8Array(size).fill(i & 0xff)) })
    }
    await vi.waitFor(() => expect(got).toHaveLength(N), { timeout: 10_000 })
    expect(got).toEqual(Array.from({ length: N }, (_, i) => String(i)))
    expect(d.recvCount).toBe(N)
  })

  it("a local close still flushes frames already handed to send", async () => {
    const { a, b } = connect()
    const c = wrapE2E(a, KEYS_A, { aead })
    const d = wrapE2E(b, KEYS_B, { aead })
    const got: TunnelFrame[] = []
    d.onFrame(f => got.push(f))
    let closedAt = -1
    d.onClose(() => {
      closedAt = got.length
    })
    for (const f of GOLDEN_FRAMES) c.send(f)
    c.close("done")
    expect(c.isOpen).toBe(false)
    await vi.waitFor(() => expect(closedAt).toBe(GOLDEN_FRAMES.length))
    expect(got).toEqual(GOLDEN_FRAMES)
  })

  it("a remote close is reported only after already-received frames are delivered", async () => {
    const hold: TunnelFrame[] = []
    let release: (() => void) | undefined
    // Deliver the three envelopes, then the close, in one burst.
    const gate: Middleware = (frame, deliver) => {
      hold.push(frame)
      release = () => {
        for (const f of hold.splice(0)) deliver(f)
      }
    }
    const { a, b } = connect(gate)
    const c = wrapE2E(a, KEYS_A, { aead })
    const d = wrapE2E(b, KEYS_B, { aead })
    const events: string[] = []
    d.onFrame(f => events.push(f.t))
    d.onClose(() => events.push("close"))
    for (const f of GOLDEN_FRAMES) c.send(f)
    await vi.waitFor(() => expect(hold).toHaveLength(3))
    release!()
    await Promise.resolve()
    b.close("peer gone") // inner transport closes right behind the frames
    await vi.waitFor(() => expect(events).toContain("close"))
    expect(events).toEqual(["ping", "http_response_chunk", "hello", "close"])
  })

  it("frames decrypted before the first subscriber are held for it", async () => {
    const { a, b } = connect()
    const c = wrapE2E(a, KEYS_A, { aead })
    const d = wrapE2E(b, KEYS_B, { aead })
    c.send({ t: "ping", nonce: "early" })
    await vi.waitFor(() => expect(d.recvCount).toBe(1))
    const got: TunnelFrame[] = []
    d.onFrame(f => got.push(f))
    expect(got).toEqual([{ t: "ping", nonce: "early" }])
  })

  it("handshake-over-sink loses nothing the daemon sends while the client is still deriving keys", async () => {
    const { a, b } = lossyPair()
    const [c, d] = await Promise.all([
      clientHandshakeOverSink(
        a,
        new TextEncoder().encode("HELLO"),
        async () => {
          // Slow key derivation: the daemon wraps and starts talking first.
          await new Promise(r => setTimeout(r, 30))
          return KEYS_A
        },
        { wrap: { aead } },
      ),
      daemonHandshakeOverSink(
        b,
        async () => ({ reply: new TextEncoder().encode("REPLY"), keys: KEYS_B }),
        { wrap: { aead } },
      ).then(wrapped => {
        // The daemon speaks the instant it is wrapped (a tunnel server's hello).
        wrapped.send({ t: "hello", version: "agentproto/tunnel/v1", capabilities: { pty: false } })
        wrapped.send({ t: "ping", nonce: "second" })
        return wrapped
      }),
    ])
    const got: TunnelFrame[] = []
    c.onFrame(f => got.push(f))
    await vi.waitFor(() => expect(got).toHaveLength(2))
    expect(got.map(f => f.t)).toEqual(["hello", "ping"])
    expect(c.isOpen).toBe(true)
    expect(d.isOpen).toBe(true)
  })
})

describe("portable base64 in the tunnel core matches Buffer", () => {
  it("encode + lenient decode", () => {
    for (let n = 0; n < 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff)
      const b64 = Buffer.from(bytes).toString("base64")
      expect(base64EncodePortable(bytes)).toBe(b64)
      expect(Buffer.from(base64DecodePortable(b64)).equals(Buffer.from(bytes))).toBe(true)
    }
    for (const s of ["QQ==QQ==", "Q=Q=", "QU JD", "!!QUJD", "-_-_", "QUI=x", "é€QUJD"]) {
      expect(Buffer.from(base64DecodePortable(s)).toString("hex")).toBe(Buffer.from(s, "base64").toString("hex"))
    }
  })
})
