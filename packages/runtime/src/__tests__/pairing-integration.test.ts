import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, stat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import {
  createTunnelClient,
  createTunnelServer,
  wrapWebSocket,
  clientHandshakeOverSink,
  type FrameSink,
  type E2eFrameSink,
  type TunnelClient,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  derivePairRoot,
  deriveEpochRoutingToken,
  currentEpoch,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createRendezvousServer, type RendezvousServer } from "@agentproto/rendezvous"
import {
  createPairingRegistry,
  type PairingChannelHandle,
  type PairingRegistry,
} from "../pairing-registry.js"
import { connect, flush, type Middleware } from "./frame-harness.js"

/** Stub the daemon's HTTP upstream: every forwarded request returns a canned
 *  JSON body that echoes the path. Distinctive so we can assert round-trips. */
function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => ({
      status: 200,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type"),
      },
      arrayBuffer: async () =>
        new TextEncoder().encode(JSON.stringify({ ok: true, path: String(url) })).buffer,
    })),
  )
}

/** A `serve` that stands up a real tunnel server (the exact serving path the
 *  daemon uses) over the E2E-wrapped sink, forwarding to the stubbed upstream. */
function makeServe(): (sink: E2eFrameSink) => PairingChannelHandle {
  return sink => {
    const server = createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: "http://127.0.0.1:1/upstream",
      label: "paired-daemon",
      pty: false,
    })
    return { close: () => server.close() }
  }
}

/** Run the client `pair accept` handshake over a raw sink and return a live
 *  tunnel client plus the derived session (for pair-root / reconnect). */
async function clientAccept(
  rawSink: FrameSink,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  offerToken: string,
  name: string,
): Promise<{ client: TunnelClient; session: PairingSession }> {
  const started = startClientHandshake({
    daemonX25519Pub,
    daemonEd25519Pub,
    offerToken,
    clientName: name,
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    rawSink,
    encodePairingMessage(started.hello),
    replyBytes => {
      session = started.complete(decodePairingReply(replyBytes))
      return session
    },
  )
  if (!session) throw new Error("handshake did not derive a session")
  return { client: createTunnelClient({ sink: wrapped }), session }
}

// ── in-process (malicious/untrusted broker) tests ────────────────

describe("paired channel over an untrusted broker (in-process)", () => {
  let tmp: string
  let identity: DaemonIdentity
  let registry: PairingRegistry | null = null

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-"))
    identity = generateIdentity()
    stubUpstream()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (registry) await registry.shutdown().catch(() => {})
    registry = null
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("pairs, persists, serves an HTTP round-trip — and the broker sees only ciphertext", async () => {
    const wire: { t: string; d?: unknown }[] = []
    const record: Middleware = (frame, deliver) => {
      wire.push(frame)
      deliver(frame)
    }

    // The daemon's injected `dial` hands back one end of a recorded in-process
    // splice; the other end is the client's raw sink.
    let clientSink: FrameSink | null = null
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: async () => {
        const { a, b } = connect(record, record)
        clientSink = a
        return b
      },
      serve: makeServe(),
      handshakeTimeoutMs: 1_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })

    const offer = await registry.createOffer({ ttlMs: 60_000 })
    // Let the daemon loop dial (populating clientSink).
    await vi.waitFor(() => expect(clientSink).not.toBeNull())

    const parsed = parseOfferUrl(offer.url)
    const { client } = await clientAccept(
      clientSink!,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      parsed.token,
      "jeremy@laptop",
    )

    const hello = await client.ready()
    expect(hello.label).toBe("paired-daemon")

    const res = await client.forwardHttp({ method: "GET", path: "/health" })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString("utf8")).ok).toBe(true)

    // Pairing persisted 0600 with the expected shape.
    const pairingsPath = join(tmp, "pairings.json")
    const st = await stat(pairingsPath)
    expect(st.mode & 0o777).toBe(0o600)
    const file = JSON.parse(await readFile(pairingsPath, "utf8"))
    expect(file.pairings).toHaveLength(1)
    expect(file.pairings[0].name).toBe("jeremy@laptop")
    expect(file.pairings[0].fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof file.pairings[0].pairRoot).toBe("string")

    await client.close()

    // Eavesdropper assertion: everything the broker relayed was an e2e or
    // e2e_handshake envelope, and no plaintext frame marker survived into any
    // e2e ciphertext.
    expect(wire.length).toBeGreaterThan(0)
    for (const f of wire) {
      expect(f.t === "e2e" || f.t === "e2e_handshake").toBe(true)
    }
    const cipher = Buffer.concat(
      wire.filter(f => f.t === "e2e").map(f => Buffer.from(String(f.d), "base64")),
    ).toString("latin1")
    for (const marker of ["http_request", "http_response", "spawned", "capabilities", '{"ok":true']) {
      expect(cipher).not.toContain(marker)
    }
  })

  it("fails closed when the broker tampers with an e2e frame (cannot forge)", async () => {
    // A malicious broker flips a byte inside the first `e2e` ciphertext it sees
    // in the client→daemon direction. The AEAD tag must catch it and the
    // channel must close rather than deliver anything.
    let tampered = false
    const tamperOnce: Middleware = (frame, deliver) => {
      if (!tampered && frame.t === "e2e" && typeof frame.d === "string") {
        tampered = true
        const buf = Buffer.from(frame.d, "base64")
        buf.writeUInt8(buf.readUInt8(0) ^ 0xff, 0)
        deliver({ ...frame, d: buf.toString("base64") })
        return
      }
      deliver(frame)
    }

    let clientSink: FrameSink | null = null
    const serve = makeServe()
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      // Tamper client→daemon (a→b); leave daemon→client clean so the hello
      // arrives intact and `ready()` resolves — the tamper only bites the first
      // encrypted http_request the client sends afterwards.
      dial: async () => {
        const { a, b } = connect(tamperOnce)
        clientSink = a
        return b
      },
      serve,
      handshakeTimeoutMs: 1_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })

    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(clientSink).not.toBeNull())

    const parsed = parseOfferUrl(offer.url)
    const started = startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      offerToken: parsed.token,
      clientName: "tamper-test",
    })
    const wrapped = await clientHandshakeOverSink(
      clientSink!,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
    )
    const client = createTunnelClient({ sink: wrapped })
    await client.ready()

    // The daemon-side wrapE2E raises a security error + closes on the tampered
    // frame. Drive a request; the flipped ciphertext must fail the AEAD tag and
    // the request must never resolve successfully.
    const pending = client
      .forwardHttp({ method: "GET", path: "/health", timeoutMs: 500 })
      .then(() => "resolved")
      .catch(() => "rejected")
    await flush()
    expect(await pending).toBe("rejected")
    expect(tampered).toBe(true)
  }, 10_000)
})

// ── real rendezvous: end-to-end + reconnect + revoke ─────────────

describe("paired channel over the real rendezvous broker", () => {
  let tmp: string
  let identity: DaemonIdentity
  let rendezvous: RendezvousServer
  let rvUrl: string
  let registry: PairingRegistry | null = null
  const openSockets: WebSocket[] = []

  async function dialRv(url: string, signal?: AbortSignal): Promise<FrameSink> {
    const ws = new WebSocket(url)
    openSockets.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", err => reject(err))
      signal?.addEventListener("abort", () => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error("aborted"))
      })
    })
    return wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-rv-"))
    identity = generateIdentity()
    stubUpstream()
    rendezvous = createRendezvousServer({ parkTimeoutMs: 5_000 })
    const { port } = await rendezvous.listen(0, "127.0.0.1")
    rvUrl = `ws://127.0.0.1:${port}/v1`
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (registry) await registry.shutdown().catch(() => {})
    registry = null
    for (const ws of openSockets) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    openSockets.length = 0
    await rendezvous.close().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("offer → accept → HTTP round-trip, then reconnect with the epoch token, then revoke", async () => {
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialRv(url, signal),
      serve: makeServe(),
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })

    // ── first pairing via the offer ──
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    // The daemon dials + parks; wait until it's waiting at the broker.
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))

    const parsed = parseOfferUrl(offer.url)
    const clientRaw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(parsed.token)}`)
    const { client, session } = await clientAccept(
      clientRaw,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      parsed.token,
      "jeremy@laptop",
    )
    await client.ready()
    const res1 = await client.forwardHttp({ method: "GET", path: "/health" })
    expect(res1.status).toBe(200)

    const pairRoot = derivePairRoot(session)
    expect(pairRoot).toBe(derivePairRoot(session))

    // Persisted.
    await vi.waitFor(async () => {
      expect((await registry!.list()).length).toBe(1)
    })
    const fingerprint = (await registry.list())[0]!.fingerprint

    // Close the first channel; the daemon's standing reconnect loops remain.
    await client.close()

    // ── reconnect via the epoch routing token ──
    const epochToken = deriveEpochRoutingToken(pairRoot, currentEpoch())
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const clientRaw2 = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epochToken)}`)
    const { client: client2 } = await clientAccept(
      clientRaw2,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      epochToken, // reconnect: the offer-token field carries the epoch routing token
      "jeremy@laptop",
    )
    await client2.ready()
    const res2 = await client2.forwardHttp({ method: "GET", path: "/health" })
    expect(res2.status).toBe(200)
    await client2.close()

    // ── revoke → the pairing can no longer be reached ──
    expect(await registry.revoke(fingerprint)).toBe(true)
    expect((await registry.list()).length).toBe(0)

    // After revocation the daemon stops parking on the pairing's tokens, so a
    // client dialing the epoch token parks alone and no splice happens. It gets
    // no daemon hello → the handshake times out / never readies.
    await new Promise(r => setTimeout(r, 100))
    const epochToken2 = deriveEpochRoutingToken(pairRoot, currentEpoch())
    const clientRaw3 = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epochToken2)}`)
    const started = startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      offerToken: epochToken2,
      clientName: "revoked",
    })
    const reconnectAttempt = clientHandshakeOverSink(
      clientRaw3,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 300 },
    )
    await expect(reconnectAttempt).rejects.toBeTruthy()
  })
})
