import { describe, it, expect, vi, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import { createTunnelServer } from "../tunnel/server.js"
import { createTunnelClient } from "../tunnel/client.js"
import {
  wrapE2E,
  clientHandshakeOverSink,
  daemonHandshakeOverSink,
  E2eError,
  type E2eKeys,
} from "../tunnel/e2e.js"
import type { TunnelFrame } from "../tunnel/frames.js"
import { connect, flush, type Middleware } from "./e2e-harness.js"

function sessionKeys(): { client: E2eKeys; daemon: E2eKeys } {
  const k1 = randomBytes(32)
  const k2 = randomBytes(32)
  return {
    client: { sendKey: k1, recvKey: k2 },
    daemon: { sendKey: k2, recvKey: k1 },
  }
}

/** Distinctive strings that would appear on the wire only if a frame or its
 *  payload were transmitted in plaintext. All ≥7 bytes so a coincidental match
 *  in random ciphertext is astronomically unlikely (no flakiness). */
const PLAINTEXT_MARKERS = [
  "http_request",
  "http_response",
  "spawned",
  "capabilities",
  '{"pong":true}',
  '{"ping":1}',
  "hello-over-e2e",
]

describe("wrapE2E — real tunnel client ↔ server over an encrypted channel", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("runs createTunnelClient ↔ createTunnelServer transparently, and the middle sees only ciphertext", { timeout: 15_000 }, async () => {
    const { client, daemon } = sessionKeys()

    // The rendezvous's-eye view: record every byte that crosses in either
    // direction.
    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a, b } = connect(record, record)

    const hostSink = wrapE2E(a, client)
    const daemonSink = wrapE2E(b, daemon)

    // Daemon side: real tunnel server with a stubbed HTTP upstream.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
        arrayBuffer: async () => new TextEncoder().encode('{"pong":true}').buffer,
      })),
    )
    createTunnelServer({
      sink: daemonSink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18999",
      label: "e2e-daemon",
      pty: false,
    })

    // Host side: real tunnel client.
    const host = createTunnelClient({ sink: hostSink })
    const hello = await host.ready()
    expect(hello.t).toBe("hello")
    expect(hello.label).toBe("e2e-daemon")

    // HTTP round-trip through the encrypted tunnel.
    const res = await host.forwardHttp({ method: "POST", path: "/mcp", body: '{"ping":1}' })
    expect(res.status).toBe(200)
    expect(res.body.toString("utf8")).toBe('{"pong":true}')

    // A real subprocess spawn, its stdout relayed back encrypted.
    const child = await host.spawn(process.execPath, [
      "-e",
      "process.stdout.write('hello-over-e2e'); process.exit(0)",
    ])
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8")
    })
    await new Promise<void>(resolve => child.on("exit", () => resolve()))
    expect(out).toContain("hello-over-e2e")

    await host.close()

    // Eavesdropper assertion: everything on the wire was an `e2e` envelope,
    // and no plaintext frame marker survived into the ciphertext bytes.
    expect(wire.length).toBeGreaterThan(0)
    for (const f of wire) expect(f.t).toBe("e2e")
    // Search the raw decoded ciphertext for any plaintext marker.
    const cipher = Buffer.concat(
      wire.map(f => (f.t === "e2e" ? Buffer.from(f.d, "base64") : Buffer.alloc(0)))
    ).toString("latin1")
    for (const marker of PLAINTEXT_MARKERS) {
      expect(cipher).not.toContain(marker)
    }
  })

  it("interop guard: an unwrapped tunnel peer never misparses an E2E envelope as a real frame", async () => {
    // A plaintext tunnel client is handed a sink that only ever carries `e2e`
    // envelopes. It must not act on them (no hello, no spawn) — they carry no
    // actionable semantics for a non-E2E peer. It fails by never becoming
    // ready, not by misinterpreting bytes.
    const { daemon } = sessionKeys()
    const { a, b } = connect()

    // The daemon is E2E-wrapped and emits an encrypted hello.
    const daemonSink = wrapE2E(b, daemon)
    createTunnelServer({ sink: daemonSink, authorize: r => r, label: "wrapped" })

    // The host is NOT wrapped — it reads raw `e2e` envelopes off `a`.
    const host = createTunnelClient({ sink: a, helloTimeoutMs: 50 })
    await flush()
    await expect(host.ready()).rejects.toBeTruthy()
    await host.close()
  })
})

describe("handshake-over-sink helpers", () => {
  it("drives a two-message handshake and returns wrapped sinks that interoperate", async () => {
    const { client, daemon } = sessionKeys()
    const { a, b } = connect()

    const helloBytes = new TextEncoder().encode("CLIENT-HELLO")
    const replyBytes = new TextEncoder().encode("DAEMON-REPLY")

    // Synthetic drivers standing in for @agentproto/secrets/pairing: the daemon
    // validates the hello and yields its reply + keys; the client verifies the
    // reply and yields the crossed keys.
    const [c, d] = await Promise.all([
      clientHandshakeOverSink(a, helloBytes, reply => {
        expect(Buffer.from(reply).toString("utf8")).toBe("DAEMON-REPLY")
        return client
      }),
      daemonHandshakeOverSink(b, hello => {
        expect(Buffer.from(hello).toString("utf8")).toBe("CLIENT-HELLO")
        return { reply: replyBytes, keys: daemon }
      }),
    ])

    const atD: TunnelFrame[] = []
    d.onFrame(f => atD.push(f))
    c.send({ t: "ping", nonce: "after-handshake" })
    await flush()
    expect(atD).toEqual([{ t: "ping", nonce: "after-handshake" }])
  })

  it("rejects and closes the sink when the daemon driver refuses the hello", async () => {
    const { client } = sessionKeys()
    const { a, b } = connect()
    const helloBytes = new TextEncoder().encode("CLIENT-HELLO")

    const results = await Promise.allSettled([
      clientHandshakeOverSink(a, helloBytes, () => client),
      daemonHandshakeOverSink(b, () => {
        throw new E2eError("auth", "offer token rejected")
      }),
    ])

    expect(results[0]?.status).toBe("rejected")
    expect(results[1]?.status).toBe("rejected")
    expect(a.isOpen).toBe(false)
    expect(b.isOpen).toBe(false)
  })

  it("rejects when a non-handshake frame arrives first", async () => {
    const { a, b } = connect()
    const helloBytes = new TextEncoder().encode("CLIENT-HELLO")

    const pending = daemonHandshakeOverSink(b, () => {
      throw new Error("should not be called")
    })
    // A stray plaintext frame instead of an e2e_handshake.
    a.send({ t: "ping", nonce: "stray" })

    await expect(pending).rejects.toBeInstanceOf(E2eError)
    // Silence the unused-hello lint by referencing it.
    expect(helloBytes.length).toBeGreaterThan(0)
  })
})
