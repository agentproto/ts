/**
 * AIP-59 §3.5 frame padding: an E2E wrapper pads plaintext frames to size
 * buckets once both peers have negotiated it in the tunnel hello, and still
 * decodes the old unpadded format.
 */

import { describe, expect, it, vi } from "vitest"
import { randomBytes } from "node:crypto"
import { wrapE2E as wrapE2ECore, type E2eKeys } from "../tunnel/e2e.js"
import { nodeAead } from "../tunnel/aead-node.js"
import { encodeFrame, type TunnelFrame } from "../tunnel/frames.js"
import { connect, type Middleware } from "./e2e-harness.js"

const TAG_LEN = 16
const HEADER_LEN = 12
const BUCKETS = new Set([256, 1024, 4096, 16384, 32768, 49152])

/** The bucket the spec promises for an encoded frame. */
function paddedFrameSize(size: number): number {
  for (const bucket of [256, 1024, 4096, 16384]) if (size <= bucket) return bucket
  return Math.ceil(size / 16384) * 16384
}

function sessionKeys(): { client: E2eKeys; daemon: E2eKeys } {
  const k1 = randomBytes(32)
  const k2 = randomBytes(32)
  return { client: { sendKey: k1, recvKey: k2 }, daemon: { sendKey: k2, recvKey: k1 } }
}

const collect = (sink: { onFrame: (h: (f: TunnelFrame) => void) => void }) => {
  const got: TunnelFrame[] = []
  sink.onFrame(f => got.push(f))
  return got
}

function channel() {
  const aToB: TunnelFrame[] = []
  const bToA: TunnelFrame[] = []
  const record = (into: TunnelFrame[]): Middleware => (frame, deliver) => {
    into.push(frame)
    deliver(frame)
  }
  const { a, b } = connect(record(aToB), record(bToA))
  const keys = sessionKeys()
  const c = wrapE2ECore(a, keys.client, { aead: nodeAead })
  const d = wrapE2ECore(b, keys.daemon, { aead: nodeAead })
  return { c, d, aToB, bToA, atC: collect(c), atD: collect(d) }
}

const cipherLength = (frame: TunnelFrame): number =>
  frame.t === "e2e" ? Buffer.from(frame.d, "base64").length : 0

const hello = (padded: boolean): TunnelFrame => ({
  t: "hello",
  version: "agentproto/tunnel/v1",
  capabilities: { pty: false, ...(padded ? { e2ePadding: true } : {}) },
})

describe("E2E frame padding", () => {
  it("pads both directions to the buckets after the hello capability", async () => {
    const { c, d, aToB, bToA, atC, atD } = channel()

    // The hello is sent unpadded (the capability is what enables padding).
    d.send(hello(true))
    await vi.waitFor(() => expect(atC).toHaveLength(1))
    expect(aToB).toHaveLength(0)
    await vi.waitFor(() => expect(bToA).toHaveLength(1))
    expect(cipherLength(bToA[0]!)).toBe(encodeFrame(hello(true)).length + TAG_LEN)

    const payloads: TunnelFrame[] = [1, 200, 900, 3800, 16000, 32000].map((n, i) => ({
      t: "http_request",
      reqId: `r${i}`,
      method: "GET",
      path: `/${"a".repeat(n)}`,
    }))
    for (const frame of payloads) c.send(frame)
    await vi.waitFor(() => expect(atD).toHaveLength(payloads.length))
    expect(atD).toEqual(payloads)

    const clientFrames = aToB.filter(f => f.t === "e2e")
    expect(clientFrames).toHaveLength(payloads.length)
    for (let i = 0; i < payloads.length; i++) {
      const plaintextLen = cipherLength(clientFrames[i]!) - TAG_LEN
      const expected = paddedFrameSize(HEADER_LEN + encodeFrame(payloads[i]!).length)
      expect(plaintextLen).toBe(expected)
      expect(BUCKETS.has(plaintextLen), `bucket ${plaintextLen}`).toBe(true)
    }

    // The daemon saw a padded frame, so its own next send is padded too.
    d.send({ t: "pong", nonce: "x" })
    await vi.waitFor(() => expect(atC).toHaveLength(2))
    await vi.waitFor(() => expect(bToA).toHaveLength(2))
    const daemonFrame = bToA.filter(f => f.t === "e2e").at(-1)!
    const daemonPlain = cipherLength(daemonFrame) - TAG_LEN
    expect(daemonPlain).toBe(paddedFrameSize(HEADER_LEN + encodeFrame({ t: "pong", nonce: "x" }).length))
    expect(BUCKETS.has(daemonPlain)).toBe(true)
  })

  it("round-trips exactly through the padding", async () => {
    const { c, d, atC, atD } = channel()
    d.send(hello(true))
    await vi.waitFor(() => expect(atC).toHaveLength(1))

    const frame: TunnelFrame = { t: "ping", nonce: "n-".repeat(1000) }
    c.send(frame)
    await vi.waitFor(() => expect(atD).toHaveLength(1))
    expect(atD[0]).toEqual(frame)

    d.send({ t: "pong", nonce: "back" })
    await vi.waitFor(() => expect(atC).toHaveLength(2))
    expect(atC[1]).toEqual({ t: "pong", nonce: "back" })
  })

  it("a daemon that does not advertise padding keeps both sides unpadded", async () => {
    const { c, d, aToB, atD } = channel()
    d.send(hello(false))
    await vi.waitFor(() => expect(atD).toHaveLength(0))

    const frame: TunnelFrame = { t: "ping", nonce: "old-peer" }
    c.send(frame)
    await vi.waitFor(() => expect(atD).toHaveLength(1))
    expect(atD[0]).toEqual(frame)
    const sent = aToB.filter(f => f.t === "e2e").at(-1)!
    expect(cipherLength(sent) - TAG_LEN).toBe(encodeFrame(frame).length)
  })

  it("decodes an unpadded frame from a peer that never negotiates", async () => {
    const { c, d, atD } = channel()
    const frame: TunnelFrame = { t: "ping", nonce: "no-hello" }
    c.send(frame)
    await vi.waitFor(() => expect(atD).toHaveLength(1))
    expect(atD[0]).toEqual(frame)
  })

})
