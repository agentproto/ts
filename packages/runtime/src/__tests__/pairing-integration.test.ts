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
  const started = await startClientHandshake({
    daemonX25519Pub,
    daemonEd25519Pub,
    offerToken,
    clientName: name,
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    rawSink,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
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
    identity = await generateIdentity()
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

    const parsed = await parseOfferUrl(offer.url)
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

    const parsed = await parseOfferUrl(offer.url)
    const started = await startClientHandshake({
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
      // Like the CLI's daemonDialRendezvous: the signal only aborts the DIAL —
      // once open, the registry owns the socket's lifetime.
      const onAbort = (): void => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error("aborted"))
      }
      ws.once("open", () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      })
      ws.once("error", err => reject(err))
      signal?.addEventListener("abort", onAbort)
    })
    return wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-rv-"))
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

    const parsed = await parseOfferUrl(offer.url)
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

    const pairRoot = await derivePairRoot(session)
    expect(pairRoot).toBe(await derivePairRoot(session))

    // Persisted.
    await vi.waitFor(async () => {
      expect((await registry!.list()).length).toBe(1)
    })
    const fingerprint = (await registry.list())[0]!.fingerprint

    // Close the first channel; the daemon's standing reconnect loops remain.
    await client.close()

    // ── reconnect via the epoch routing token ──
    const epochToken = await deriveEpochRoutingToken(pairRoot, currentEpoch())
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

    // ── revoke → the client is told, authenticated, that it was unpaired ──
    expect(await registry.revoke(fingerprint)).toBe(true)
    expect((await registry.list()).length).toBe(0)

    // The daemon keeps a tombstone on the pairing's routing tokens: the
    // handshake still completes (the client verifies the daemon's signature),
    // then the only frame is an E2E `error{pairing_revoked}` — never a hello,
    // never a served channel.
    const epochToken2 = await deriveEpochRoutingToken(pairRoot, currentEpoch())
    const refusal = await dialRevoked(epochToken2, parsed.daemonX25519Pub, parsed.daemonEd25519Pub)
    expect(refusal.frames).toEqual([
      expect.objectContaining({ t: "error", code: "pairing_revoked" }),
    ])
    expect(refusal.closed).toBe(true)

    // The tombstone is persisted with the routing tokens only — no pair root.
    const file = JSON.parse(await readFile(join(tmp, "pairings.json"), "utf8"))
    expect(file.pairings).toEqual([])
    expect(file.revoked).toHaveLength(1)
    expect(file.revoked[0].fingerprint).toBe(fingerprint)
    expect(file.revoked[0].pairRoot).toBeUndefined()
    expect(file.revoked[0].routes.map((r: { token: string }) => r.token)).toContain(epochToken2)
  })

  /** Dial a revoked pairing's routing token, run the client handshake, and
   *  collect every decrypted frame until the channel closes. */
  async function dialRevoked(
    token: string,
    daemonX25519Pub: string,
    daemonEd25519Pub: string,
  ): Promise<{ frames: unknown[]; closed: boolean }> {
    // Let the revoked loops' sockets leave the broker before the tombstone's
    // park is the one we splice with.
    await new Promise(r => setTimeout(r, 150))
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(token)}`)
    const started = await startClientHandshake({
      daemonX25519Pub,
      daemonEd25519Pub,
      offerToken: token,
      clientName: "revoked",
    })
    const wrapped = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 4_000 },
    )
    const frames: unknown[] = []
    wrapped.onFrame(f => frames.push(f))
    const closed = await new Promise<boolean>(resolve => {
      if (!wrapped.isOpen) resolve(true)
      wrapped.onClose(() => resolve(true))
      setTimeout(() => resolve(false), 4_000)
    })
    return { frames, closed }
  }

  it("a live channel is told pairing_revoked when its pairing is revoked", async () => {
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
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const parsed = await parseOfferUrl(offer.url)
    const { client: first, session } = await clientAccept(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(parsed.token)}`),
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      parsed.token,
      "phone",
    )
    await first.ready()
    await first.close()
    const pairRoot = await derivePairRoot(session)
    const fingerprint = (await registry.list())[0]!.fingerprint

    // Reconnect over the epoch token, then revoke while it's live.
    const token = await deriveEpochRoutingToken(pairRoot, currentEpoch())
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(token)}`)
    const started = await startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      offerToken: token,
      clientName: "phone",
    })
    const wrapped = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 4_000 },
    )
    const frames: { t: string; code?: string }[] = []
    wrapped.onFrame(f => frames.push(f as { t: string; code?: string }))
    await vi.waitFor(() => expect(frames.map(f => f.t)).toContain("hello"))
    const closed = new Promise<void>(resolve => wrapped.onClose(() => resolve()))

    await registry.revoke(fingerprint)
    await closed
    expect(frames.at(-1)).toMatchObject({ t: "error", code: "pairing_revoked" })
  })

  it("revokedGraceMs: 0 keeps no tombstone — a revoked client finds no daemon", async () => {
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialRv(url, signal),
      serve: makeServe(),
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
      revokedGraceMs: 0,
    })
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const parsed = await parseOfferUrl(offer.url)
    const { client, session } = await clientAccept(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(parsed.token)}`),
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      parsed.token,
      "phone",
    )
    await client.ready()
    await client.close()
    const pairRoot = await derivePairRoot(session)
    expect(await registry.revoke((await registry.list())[0]!.fingerprint)).toBe(true)

    await new Promise(r => setTimeout(r, 100))
    const token = await deriveEpochRoutingToken(pairRoot, currentEpoch())
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(token)}`)
    const started = await startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      offerToken: token,
      clientName: "revoked",
    })
    const attempt = clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 300 },
    )
    await expect(attempt).rejects.toBeTruthy()
    const file = JSON.parse(await readFile(join(tmp, "pairings.json"), "utf8"))
    expect(file.revoked).toBeUndefined()
  })
})
