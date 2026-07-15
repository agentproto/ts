/**
 * End-to-end tests for the opt-in `serve --connect` E2E upgrade (tunnel-e2e/v1).
 *
 * These wire the REAL token-authenticated handshake from
 * `@agentproto/secrets/pairing` (a dev-only dependency — the shipped acp bundle
 * never imports it) through the acp negotiation helpers and a real
 * `createTunnelServer` ↔ `createTunnelClient`, over the in-memory `connect()`
 * harness that plays the untrusted host relay.
 *
 * The four cases map to the backward-compat + security guarantees:
 *   (a) both sides e2e → wire is ciphertext, real spawn + http round-trips work
 *   (b) host without e2e → daemon falls back to plaintext (unchanged)
 *   (c) daemon with e2e off → plaintext even against an e2e-capable host
 *   (d) mismatched tunnel.token → handshake fails closed, no plaintext leak
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  startTunnelHandshake,
  respondToTunnelHandshake,
  encodeTunnelMessage,
  decodeTunnelOffer,
  decodeTunnelAccept,
  TunnelHandshakeError,
} from "@agentproto/secrets/pairing"
import { createTunnelServer } from "../tunnel/server.js"
import { createTunnelClient } from "../tunnel/client.js"
import { connectSinkE2E, acceptSinkE2E } from "../tunnel/tunnel-e2e.js"
import { E2eError, type E2eKeys } from "../tunnel/e2e.js"
import type { FrameSink } from "../tunnel/transport.js"
import type { TunnelFrame } from "../tunnel/frames.js"
import { connect, flush, type Middleware } from "./e2e-harness.js"

const TOKEN = "apt_shared_tunnel_secret_abc123"

/** Daemon (initiator): negotiate e2e over `sink` using the real handshake. */
function daemonConnect(sink: FrameSink, token: string, timeoutMs = 8_000) {
  const started = startTunnelHandshake(token)
  const deriveKeys = (reply: Uint8Array): E2eKeys => {
    const accept = decodeTunnelAccept(reply)
    const session = started.complete(accept)
    return { sendKey: session.sendKey, recvKey: session.recvKey }
  }
  return connectSinkE2E(sink, encodeTunnelMessage(started.offer), deriveKeys, { timeoutMs })
}

/** Host (responder): accept e2e over `sink` using the real handshake. */
function hostAccept(sink: FrameSink, token: string, timeoutMs = 8_000) {
  const respond = (offerBytes: Uint8Array): { reply: Uint8Array; keys: E2eKeys } => {
    const offer = decodeTunnelOffer(offerBytes)
    const { accept, session } = respondToTunnelHandshake(offer, token)
    return {
      reply: encodeTunnelMessage(accept),
      keys: { sendKey: session.sendKey, recvKey: session.recvKey },
    }
  }
  return acceptSinkE2E(sink, respond, { timeoutMs })
}

/** Markers that would only appear on the wire if a tunnel/v1 frame (or its
 *  payload) crossed in plaintext. */
const PLAINTEXT_MARKERS = [
  "spawn",
  "http_request",
  "http_response",
  "spawned",
  "capabilities",
  "e2e-daemon",
  '{"ping":1}',
  "hello-over-connect-e2e",
]

function stubHttpUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type"),
      },
      arrayBuffer: async () => new TextEncoder().encode('{"pong":true}').buffer,
    })),
  )
}

describe("serve --connect E2E upgrade — token-authenticated handshake", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("(a) both sides e2e: wire is ciphertext and a real spawn + http round-trip works", { timeout: 15_000 }, async () => {
    stubHttpUpstream()

    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a: daemonRaw, b: hostRaw } = connect(record, record)

    // Negotiate BOTH ends concurrently over the shared token.
    const [daemonSink, hostResult] = await Promise.all([
      daemonConnect(daemonRaw, TOKEN),
      hostAccept(hostRaw, TOKEN),
    ])
    expect(daemonSink).not.toBeNull()
    expect(hostResult.e2e).toBe(true)
    if (daemonSink === null || !hostResult.e2e) throw new Error("negotiation failed")

    createTunnelServer({
      sink: daemonSink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18999",
      label: "e2e-daemon",
      pty: false,
      e2e: true,
    })
    const host = createTunnelClient({ sink: hostResult.sink })

    const hello = await host.ready()
    expect(hello.label).toBe("e2e-daemon")
    // The daemon confirms the channel is encrypted inside the box.
    expect(hello.capabilities.e2e).toBe(true)

    const res = await host.forwardHttp({ method: "POST", path: "/mcp", body: '{"ping":1}' })
    expect(res.status).toBe(200)
    expect(res.body.toString("utf8")).toBe('{"pong":true}')

    const child = await host.spawn(process.execPath, [
      "-e",
      "process.stdout.write('hello-over-connect-e2e'); process.exit(0)",
    ])
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8")
    })
    await new Promise<void>(resolve => child.on("exit", () => resolve()))
    expect(out).toContain("hello-over-connect-e2e")

    await host.close()

    // Eavesdropper view: only handshake + ciphertext envelopes crossed, and no
    // plaintext tunnel-frame marker survived into the bytes.
    expect(wire.length).toBeGreaterThan(0)
    for (const f of wire) expect(["e2e", "e2e_handshake"]).toContain(f.t)
    const cipher = Buffer.concat(
      wire.map(f => (f.t === "e2e" ? Buffer.from(f.d, "base64") : Buffer.alloc(0))),
    ).toString("latin1")
    for (const marker of PLAINTEXT_MARKERS) expect(cipher).not.toContain(marker)
  })

  it("(b) host without e2e support: daemon falls back to plaintext, tunnel unchanged", async () => {
    stubHttpUpstream()

    const { a: daemonRaw, b: hostRaw } = connect()

    // Daemon offers e2e (short timeout); the host never negotiates — it just
    // runs a plaintext client on the raw sink, ignoring the stray offer.
    const host = createTunnelClient({ sink: hostRaw })
    const daemonSink = await daemonConnect(daemonRaw, TOKEN, 150)

    // Peer stayed silent → null → fall back to plaintext on the same sink.
    expect(daemonSink).toBeNull()
    createTunnelServer({
      sink: daemonRaw,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18999",
      label: "plaintext-daemon",
      pty: false,
    })

    const hello = await host.ready()
    expect(hello.label).toBe("plaintext-daemon")
    expect(hello.capabilities.e2e).toBeUndefined()
    const res = await host.forwardHttp({ method: "POST", path: "/mcp", body: '{"ping":1}' })
    expect(res.body.toString("utf8")).toBe('{"pong":true}')
    await host.close()
  })

  it("(c) daemon with e2e off: plaintext even against an e2e-capable host", async () => {
    stubHttpUpstream()

    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a: daemonRaw, b: hostRaw } = connect(record, record)

    // Daemon does NOT negotiate — it emits the plaintext hello immediately.
    createTunnelServer({
      sink: daemonRaw,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:18999",
      label: "plaintext-daemon",
      pty: false,
    })

    // e2e-capable host detects the plaintext hello (a non-handshake first frame)
    // and falls back, re-injecting that hello into its plaintext client.
    const hostResult = await hostAccept(hostRaw, TOKEN, 2_000)
    expect(hostResult.e2e).toBe(false)

    const host = createTunnelClient({ sink: hostResult.sink })
    const hello = await host.ready()
    expect(hello.label).toBe("plaintext-daemon")
    const res = await host.forwardHttp({ method: "POST", path: "/mcp", body: '{"ping":1}' })
    expect(res.body.toString("utf8")).toBe('{"pong":true}')
    await host.close()

    // The hello DID cross in plaintext — this is the byte-compatible path.
    expect(wire.some(f => f.t === "hello")).toBe(true)
  })

  it("(d) mismatched tunnel.token: handshake fails closed with a typed error, no plaintext", async () => {
    const wire: TunnelFrame[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }
    const { a: daemonRaw, b: hostRaw } = connect(record, record)

    const results = await Promise.allSettled([
      daemonConnect(daemonRaw, TOKEN),
      hostAccept(hostRaw, "apt_WRONG_token"),
    ])

    // Host rejects the offer at handshake time (wrong token → bad_auth).
    expect(results[1]?.status).toBe("rejected")
    if (results[1]?.status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(TunnelHandshakeError)
      expect(results[1].reason.code).toBe("bad_auth")
    }
    // Daemon fails closed too — the host closed the sink, so the daemon's wait
    // for an accept ends in a typed E2eError, never a plaintext downgrade.
    expect(results[0]?.status).toBe("rejected")
    if (results[0]?.status === "rejected") {
      expect(results[0].reason).toBeInstanceOf(E2eError)
    }

    expect(daemonRaw.isOpen).toBe(false)
    expect(hostRaw.isOpen).toBe(false)

    // Nothing but the opening handshake offer ever crossed — no tunnel frames.
    await flush()
    for (const f of wire) expect(f.t).toBe("e2e_handshake")
  })
})
