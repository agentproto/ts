import { describe, it, expect } from "vitest"
import { randomBytes } from "node:crypto"
import { wrapE2E, E2eError, type E2eKeys, type E2eErrorCode } from "../tunnel/e2e.js"
import type { TunnelFrame } from "../tunnel/frames.js"
import { connect, flush, passthrough, type Middleware } from "./e2e-harness.js"

/** A pair of role-crossed key sets, exactly as the handshake would yield. */
function sessionKeys(): { client: E2eKeys; daemon: E2eKeys } {
  const k1 = randomBytes(32)
  const k2 = randomBytes(32)
  return {
    client: { sendKey: k1, recvKey: k2 },
    daemon: { sendKey: k2, recvKey: k1 },
  }
}

/** Collect the typed security errors a wrapped endpoint raises. */
function errorSink() {
  const errors: E2eError[] = []
  return { errors, onSecurityError: (e: E2eError) => errors.push(e) }
}

const collect = (sink: { onFrame: (h: (f: TunnelFrame) => void) => void }) => {
  const got: TunnelFrame[] = []
  sink.onFrame(f => got.push(f))
  return got
}

describe("wrapE2E — AEAD FrameSink channel", () => {
  it("round-trips frames in both directions, transparently", async () => {
    const { client, daemon } = sessionKeys()
    const { a, b } = connect()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon)
    const atD = collect(d)
    const atC = collect(c)

    c.send({ t: "ping", nonce: "n1" })
    c.send({ t: "http_request", reqId: "r1", method: "GET", path: "/x" })
    d.send({ t: "pong", nonce: "n1" })
    await flush()

    expect(atD).toEqual([
      { t: "ping", nonce: "n1" },
      { t: "http_request", reqId: "r1", method: "GET", path: "/x" },
    ])
    expect(atC).toEqual([{ t: "pong", nonce: "n1" }])
    expect(c.sentCount).toBe(2)
    expect(d.recvCount).toBe(2)
  })

  it("puts only opaque ciphertext on the wire — no plaintext frame types leak", async () => {
    const { client, daemon } = sessionKeys()
    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a, b } = connect(record, record)
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon)
    collect(d)

    c.send({ t: "spawn", execId: "e1", command: "claude", args: ["--secret-flag"] })
    await flush()

    expect(wire.length).toBeGreaterThan(0)
    for (const f of wire) expect(f.t).toBe("e2e")
    // Search the raw decoded ciphertext (not the base64 text, whose alphabet
    // could coincidentally contain a short marker) for the inner frame's
    // distinctive strings.
    const cipher = Buffer.concat(
      wire.map(f => (f.t === "e2e" ? Buffer.from(f.d, "base64") : Buffer.alloc(0)))
    ).toString("latin1")
    for (const needle of ["claude", "--secret-flag", '"command"', '"execId"']) {
      expect(cipher).not.toContain(needle)
    }
  })

  it("a broker that flips a ciphertext byte is caught (auth), channel closes, nothing delivered", async () => {
    const { client, daemon } = sessionKeys()
    const flip: Middleware = (frame, deliver) => {
      if (frame.t === "e2e") {
        const buf = Buffer.from(frame.d, "base64")
        buf.writeUInt8(buf.readUInt8(0) ^ 0xff, 0)
        deliver({ ...frame, d: buf.toString("base64") })
      } else deliver(frame)
    }
    const { a, b } = connect(flip)
    const err = errorSink()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    c.send({ t: "ping", nonce: "n1" })
    await flush()

    expect(atD).toEqual([])
    expect(err.errors.map(e => e.code)).toContain("auth")
    expect(d.isOpen).toBe(false)
  })

  it("a broker that flips the counter field is caught (as replay/reorder/auth)", async () => {
    const { client, daemon } = sessionKeys()
    const bumpN: Middleware = (frame, deliver) => {
      if (frame.t === "e2e") deliver({ ...frame, n: frame.n + 5 })
      else deliver(frame)
    }
    const { a, b } = connect(bumpN)
    const err = errorSink()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    c.send({ t: "ping", nonce: "n1" })
    await flush()

    expect(atD).toEqual([])
    // n was pushed ahead of the expected counter → a gap.
    expect(err.errors.map(e => e.code)).toContain("reorder")
    expect(d.isOpen).toBe(false)
  })

  it("a dropped frame surfaces as a gap on the next frame (reorder)", async () => {
    const { client, daemon } = sessionKeys()
    let dropped = false
    const dropFirst: Middleware = (frame, deliver) => {
      if (frame.t === "e2e" && !dropped) {
        dropped = true
        return // silently drop frame n=0
      }
      deliver(frame)
    }
    const { a, b } = connect(dropFirst)
    const err = errorSink()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    c.send({ t: "ping", nonce: "n0" })
    c.send({ t: "ping", nonce: "n1" })
    await flush()

    expect(atD).toEqual([]) // n=1 arrives while n=0 is expected → refused
    expect(err.errors.map(e => e.code)).toContain("reorder")
    expect(d.isOpen).toBe(false)
  })

  it("reordered frames are refused (strict monotonicity)", async () => {
    const { client, daemon } = sessionKeys()
    let held: TunnelFrame | null = null
    const swap: Middleware = (frame, deliver) => {
      if (frame.t === "e2e") {
        if (!held) {
          held = frame // hold n=0
          return
        }
        deliver(frame) // deliver n=1 first
        deliver(held) // then the held n=0
        held = null
      } else deliver(frame)
    }
    const { a, b } = connect(swap)
    const err = errorSink()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    c.send({ t: "ping", nonce: "n0" })
    c.send({ t: "ping", nonce: "n1" })
    await flush()

    expect(atD).toEqual([])
    expect(err.errors.map(e => e.code)).toContain("reorder")
    expect(d.isOpen).toBe(false)
  })

  it("a replayed frame is refused (replay)", async () => {
    const { client, daemon } = sessionKeys()
    let replayed = false
    const dupFirst: Middleware = (frame, deliver) => {
      deliver(frame)
      if (frame.t === "e2e" && !replayed) {
        replayed = true
        deliver(frame) // send frame n=0 a second time
      }
    }
    const { a, b } = connect(dupFirst)
    const err = errorSink()
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    c.send({ t: "ping", nonce: "n0" })
    await flush()

    // The first copy is delivered; the replay is refused and closes the channel.
    expect(atD).toEqual([{ t: "ping", nonce: "n0" }])
    expect(err.errors.map(e => e.code)).toContain("replay")
    expect(d.isOpen).toBe(false)
  })

  it("a wrapped endpoint refuses a plaintext (downgrade) frame — not_e2e", async () => {
    const { daemon } = sessionKeys()
    const { a, b } = connect()
    const err = errorSink()
    const d = wrapE2E(b, daemon, err)
    const atD = collect(d)

    // `a` is an unwrapped peer speaking plaintext — a downgrade attempt.
    a.send({ t: "ping", nonce: "plain" })
    await flush()

    expect(atD).toEqual([])
    expect(err.errors.map(e => e.code)).toContain("not_e2e")
    expect(d.isOpen).toBe(false)
  })

  it("delivers a long in-order run and keeps counters aligned", async () => {
    const { client, daemon } = sessionKeys()
    const { a, b } = connect(passthrough, passthrough)
    const c = wrapE2E(a, client)
    const d = wrapE2E(b, daemon)
    const atD = collect(d)

    const N = 50
    for (let i = 0; i < N; i++) c.send({ t: "stdout", execId: "e", data: String(i) })
    await flush()

    expect(atD).toHaveLength(N)
    expect(atD.map(f => (f.t === "stdout" ? f.data : ""))).toEqual(
      Array.from({ length: N }, (_, i) => String(i))
    )
    expect(c.sentCount).toBe(N)
    expect(d.recvCount).toBe(N)
    expect(d.isOpen).toBe(true)
  })

  it("guards against nonce-counter overflow (rekey limit) before ever reusing a nonce", async () => {
    const { client, daemon } = sessionKeys()
    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a, b } = connect(record)
    const err = errorSink()
    const c = wrapE2E(a, client, { ...err, maxFrames: 2 })
    wrapE2E(b, daemon)

    c.send({ t: "ping", nonce: "0" })
    c.send({ t: "ping", nonce: "1" })
    c.send({ t: "ping", nonce: "2" }) // exceeds the limit — must not go out
    await flush()

    expect(wire).toHaveLength(2)
    expect(err.errors.map(e => e.code)).toContain("overflow")
    expect(c.isOpen).toBe(false)
  })

  it("E2eError carries a stable machine-readable code", () => {
    const e = new E2eError("auth", "boom")
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("E2eError")
    expect(e.code).toBe("auth")
  })
})
