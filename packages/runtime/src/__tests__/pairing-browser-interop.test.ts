/**
 * Browser-mode client ↔ Node daemon, through a real local rendezvous broker.
 *
 * The daemon side is the production path, unchanged: `createPairingRegistry`
 * (node:crypto `respondToHandshake`, node:crypto `wrapE2E`) serving a real
 * `createTunnelServer`. The client side uses ONLY the browser-safe entries —
 * `@agentproto/secrets/pairing/browser` and `@agentproto/acp/tunnel/browser`,
 * whose crypto is WebCrypto (forced explicitly below too) — over the WHATWG
 * `WebSocket` global, i.e. the stack a phone browser will run. It speaks raw
 * `agentproto/tunnel/v1` frames (no Node tunnel client), so every frame it
 * sends or reads went through the browser code.
 *
 * Covered: offer → pair; frames both ways (ping/pong, a buffered request); a
 * long streamed response (hundreds of SSE chunks, order + integrity checked);
 * then a reconnect over the epoch routing token, still in browser mode.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import {
  createTunnelServer,
  wrapWebSocket as wrapNodeWebSocket,
  type E2eFrameSink,
  type FrameSink,
} from "@agentproto/acp/tunnel"
import {
  clientHandshakeOverSink,
  wrapWebSocket,
  webCryptoAead,
  decodeData,
  type TunnelFrame,
  type WebSocketLike,
} from "@agentproto/acp/tunnel/browser"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  webCryptoProvider,
  type PairingSession,
} from "@agentproto/secrets/pairing/browser"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createRendezvousServer, type RendezvousServer } from "@agentproto/rendezvous"
import { createPairingRegistry, type PairingRegistry } from "../pairing-registry.js"

const CHUNKS = 400

/** Deterministic, order-revealing chunk payloads. */
function chunkPayload(i: number): string {
  return `data: {"seq":${i},"pad":"${"x".repeat(i % 97)}"}\n\n`
}

/** The daemon's HTTP upstream: `/stream` is a long SSE response delivered in
 *  CHUNKS separate reads; anything else is a small JSON echo. */
function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith("/stream")) {
        let i = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i >= CHUNKS) {
              controller.close()
              return
            }
            controller.enqueue(new TextEncoder().encode(chunkPayload(i++)))
          },
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return new Response(JSON.stringify({ ok: true, path }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }),
  )
}

function makeServe(): (sink: E2eFrameSink) => { close(): Promise<void> } {
  return sink => {
    const server = createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:1/upstream",
      label: "node-daemon",
      pty: false,
    })
    return { close: () => server.close() }
  }
}

/** Dial with the WHATWG `WebSocket` global — the browser API (Node ≥ 22). */
function dialBrowserWs(url: string, opened: globalThis.WebSocket[]): Promise<FrameSink> {
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(url)
    opened.push(ws)
    ws.addEventListener("open", () => resolve(wrapWebSocket(ws as unknown as WebSocketLike)), { once: true })
    ws.addEventListener("error", () => reject(new Error(`ws dial failed: ${url}`)), { once: true })
  })
}

/** A frame-level client over the wrapped sink: collects frames, lets a test
 *  await one matching a predicate. */
function frameClient(sink: E2eFrameSink) {
  const seen: TunnelFrame[] = []
  const waiters: { pred: (f: TunnelFrame) => boolean; resolve: (f: TunnelFrame) => void }[] = []
  sink.onFrame(f => {
    seen.push(f)
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(f)
      }
    }
  })
  const next = (pred: (f: TunnelFrame) => boolean): Promise<TunnelFrame> => {
    const hit = seen.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise(resolve => waiters.push({ pred, resolve }))
  }
  return { seen, next }
}

/** Browser-mode pair: handshake + wrap with WebCrypto on the client side. */
async function browserPair(
  raw: FrameSink,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  authToken: string,
): Promise<{ sink: E2eFrameSink; session: PairingSession }> {
  const started = await startClientHandshake(
    { daemonX25519Pub, daemonEd25519Pub, authToken, clientName: "phone@browser" },
    webCryptoProvider,
  )
  let session: PairingSession | null = null
  const sink = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async reply => {
      session = await started.complete(decodePairingReply(reply))
      return session
    },
    { timeoutMs: 4_000, wrap: { aead: webCryptoAead } },
  )
  if (!session) throw new Error("handshake did not derive a session")
  return { sink, session }
}

describe("browser-mode (WebCrypto) client ↔ node:crypto daemon over a real rendezvous", () => {
  let tmp: string
  let identity: DaemonIdentity
  let rendezvous: RendezvousServer
  let rvUrl: string
  let registry: PairingRegistry | null = null
  const nodeSockets: WebSocket[] = []
  const browserSockets: globalThis.WebSocket[] = []

  async function dialDaemonSide(url: string, signal?: AbortSignal): Promise<FrameSink> {
    const ws = new WebSocket(url)
    nodeSockets.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", err => reject(err))
      signal?.addEventListener("abort", () => {
        ws.close()
        reject(new Error("aborted"))
      })
    })
    return wrapNodeWebSocket(ws as unknown as Parameters<typeof wrapNodeWebSocket>[0])
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-browser-"))
    identity = await generateIdentity()
    stubUpstream()
    rendezvous = createRendezvousServer({ parkTimeoutMs: 5_000 })
    const { port } = await rendezvous.listen(0, "127.0.0.1")
    rvUrl = `ws://127.0.0.1:${port}/v1`
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (registry) await registry.shutdown().catch(() => {})
    registry = null
    for (const ws of [...nodeSockets, ...browserSockets]) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    nodeSockets.length = 0
    browserSockets.length = 0
    await rendezvous.close().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("pairs, exchanges frames both ways, streams a long response intact, and reconnects", async () => {
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialDaemonSide(url, signal),
      serve: makeServe(),
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })

    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))

    // ── pair, browser mode ──
    const parsed = await parseOfferUrl(offer.url, { now: Date.now() }, webCryptoProvider)
    const offerTokens = await deriveOfferTokens(parsed.secret, webCryptoProvider)
    const raw = await dialBrowserWs(
      `${rvUrl}?side=client&t=${encodeURIComponent(offerTokens.route)}`,
      browserSockets,
    )
    const { sink, session } = await browserPair(
      raw,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
    )
    expect(session.peerFingerprint).toBe(parsed.fingerprint)
    const client = frameClient(sink)

    // daemon → client: the tunnel server's hello, decrypted by WebCrypto.
    const hello = await client.next(f => f.t === "hello")
    expect(hello.t === "hello" && hello.label).toBe("node-daemon")

    // client → daemon → client: ping/pong.
    sink.send({ t: "ping", nonce: "from-browser" })
    await client.next(f => f.t === "pong" && f.nonce === "from-browser")

    // A buffered request/response.
    sink.send({ t: "http_request", reqId: "r-small", method: "GET", path: "/health" })
    const small = await client.next(f => f.t === "http_response" && f.reqId === "r-small")
    if (small.t !== "http_response") throw new Error("unreachable")
    expect(small.status).toBe(200)
    expect(JSON.parse(new TextDecoder().decode(decodeData(small.body ?? "")))).toEqual({
      ok: true,
      path: "/upstream/health",
    })

    // ── a long streamed response ──
    sink.send({
      t: "http_request",
      reqId: "r-stream",
      method: "GET",
      path: "/stream",
      headers: { accept: "text/event-stream" },
    })
    const head = await client.next(f => f.t === "http_response_head" && f.reqId === "r-stream")
    expect(head.t === "http_response_head" && head.status).toBe(200)
    await client.next(f => f.t === "http_response_chunk" && f.reqId === "r-stream" && f.end === true)

    const chunks = client.seen.filter(
      (f): f is Extract<TunnelFrame, { t: "http_response_chunk" }> =>
        f.t === "http_response_chunk" && f.reqId === "r-stream",
    )
    const dataChunks = chunks.filter(c => c.data)
    expect(dataChunks.length).toBeGreaterThanOrEqual(CHUNKS / 2) // streamed, not one blob
    expect(chunks.at(-1)?.end).toBe(true)
    expect(chunks.filter(c => c.error)).toEqual([])
    // Nothing for this request arrives after the terminal chunk; head precedes all.
    const headIdx = client.seen.indexOf(head)
    const firstChunkIdx = client.seen.indexOf(chunks[0]!)
    expect(headIdx).toBeLessThan(firstChunkIdx)

    const body = new TextDecoder().decode(
      Buffer.concat(dataChunks.map(c => Buffer.from(decodeData(c.data!)))),
    )
    const expected = Array.from({ length: CHUNKS }, (_, i) => chunkPayload(i)).join("")
    expect(body.length).toBe(expected.length)
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      createHash("sha256").update(expected).digest("hex"),
    )
    const seqs = [...body.matchAll(/"seq":(\d+)/g)].map(m => Number(m[1]))
    expect(seqs).toEqual(Array.from({ length: CHUNKS }, (_, i) => i))

    // Both directions ran strictly in counter order with no gaps.
    expect(sink.recvCount).toBe(client.seen.length)
    expect(sink.isOpen).toBe(true)

    // The pairing is persisted daemon-side, and both peers derive one root.
    await vi.waitFor(async () => expect((await registry!.list()).length).toBe(1))
    const pairRoot = await derivePairRoot(session, webCryptoProvider)
    sink.close("done")

    // ── reconnect over the epoch routing token, still browser mode ──
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch(), webCryptoProvider)
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const raw2 = await dialBrowserWs(
      `${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`,
      browserSockets,
    )
    const { sink: sink2 } = await browserPair(
      raw2,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      epoch.auth,
    )
    const client2 = frameClient(sink2)
    await client2.next(f => f.t === "hello")
    sink2.send({ t: "ping", nonce: "reconnected" })
    await client2.next(f => f.t === "pong" && f.nonce === "reconnected")
    sink2.close("done")
  }, 30_000)
})
