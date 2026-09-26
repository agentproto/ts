import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises"
import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto"
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
  type TunnelFrame,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { seal } from "@agentproto/secrets/seal"
import {
  generateIdentity,
  verifyTranscript,
  type DaemonIdentity,
} from "@agentproto/secrets/identity"
import { createRendezvousServer, type RendezvousServer } from "@agentproto/rendezvous"
import {
  createPairingRegistry,
  type PairingChannelContext,
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
  authToken: string,
  name: string,
): Promise<{ client: TunnelClient; session: PairingSession }> {
  const started = await startClientHandshake({
    daemonX25519Pub,
    daemonEd25519Pub,
    authToken,
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

/**
 * A pair/v1 client, hand-rolled from the shipped v1 wire format (the code is
 * gone from `@agentproto/secrets`): seals `{clientPub, clientName, offerToken}`
 * with `v: 1`, verifies the daemon's transcript signature, and derives keys
 * under the v1 schedule (`agentproto/pair/v1`). Returns the wrapped sink.
 */
async function v1ClientHandshake(
  raw: FrameSink,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  offerToken: string,
): Promise<E2eFrameSink> {
  const e = generateKeyPairSync("x25519")
  const ePubDer = e.publicKey.export({ type: "spki", format: "der" })
  const ePub = ePubDer.toString("base64")
  const ct0 = await seal(
    JSON.stringify({ clientPub: ePub, clientName: "old@client", offerToken }),
    daemonX25519Pub,
  )
  const spki = (der: Buffer) => createPublicKey({ key: der, format: "der", type: "spki" })
  return clientHandshakeOverSink(
    raw,
    Buffer.from(JSON.stringify({ v: 1, ePub, ct0 }), "utf8"),
    async replyBytes => {
      const reply = JSON.parse(Buffer.from(replyBytes).toString("utf8"))
      if (reply.v !== 1) throw new Error(`v1 client got a v${reply.v} reply`)
      const dePubDer = Buffer.from(reply.dePub, "base64")
      const transcript = createHash("sha256").update(ePubDer).update(ct0, "utf8").update(dePubDer).digest()
      if (!(await verifyTranscript(daemonEd25519Pub, transcript, reply.sig))) {
        throw new Error("v1 client: bad daemon signature")
      }
      const ecdhE = diffieHellman({ privateKey: e.privateKey, publicKey: spki(dePubDer) })
      const ecdhS = diffieHellman({
        privateKey: e.privateKey,
        publicKey: spki(Buffer.from(daemonX25519Pub, "base64")),
      })
      const okm = Buffer.from(
        hkdfSync("sha256", Buffer.concat([ecdhE, ecdhS]), transcript, "agentproto/pair/v1", 64),
      )
      return { sendKey: okm.subarray(0, 32), recvKey: okm.subarray(32, 64) }
    },
    { timeoutMs: 3_000 },
  )
}

/** Every frame a wrapped sink delivers until it closes. */
function framesUntilClosed(sink: E2eFrameSink): Promise<TunnelFrame[]> {
  const frames: TunnelFrame[] = []
  return new Promise(resolve => {
    sink.onFrame(f => frames.push(f))
    sink.onClose(() => resolve(frames))
    if (!sink.isOpen) resolve(frames)
  })
}

/** What the rendezvous broker can attempt: dial the route it saw, then seal a
 *  well-formed pair/v2 hello to the daemon's PUBLIC key carrying `token` as the
 *  proof. Resolves "served" only if the daemon completed the handshake, and
 *  "refused" only if the daemon actively hung up — a timeout (nobody answered)
 *  proves nothing, so it throws. */
async function brokerAttempt(
  dial: () => Promise<FrameSink>,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  token: string,
): Promise<"refused" | "served"> {
  const raw = await dial()
  const started = await startClientHandshake({
    daemonX25519Pub,
    daemonEd25519Pub,
    authToken: token,
    clientName: "broker",
  })
  try {
    const sink = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 3_000 },
    )
    sink.close("adversary done")
    return "served"
  } catch (err) {
    if (err instanceof Error && /timed out/.test(err.message)) throw err
    return "refused"
  }
}

/** Resolve once at least `n` sockets are parked at `rv` — i.e. the daemon has
 *  (re-)parked. The broker drops what a client sends before its splice, so a
 *  client must not dial ahead of the daemon. */
async function daemonParked(rv: RendezvousServer, n: number): Promise<void> {
  await vi.waitFor(() => expect(rv.stats.parked).toBeGreaterThanOrEqual(n))
}

/** A base64url string the width of an auth token — a blind guess. */
function guessToken(): string {
  return randomBytes(32).toString("base64url")
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
    const dialedUrls: string[] = []
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: async url => {
        dialedUrls.push(url)
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
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const { client } = await clientAccept(
      clientSink!,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
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

    // The broker's upgrade URL carries only the route: never the offer secret,
    // never the auth token. And no relayed frame carries either in clear.
    expect(dialedUrls[0]).toContain(`t=${offerTokens.route}`)
    for (const url of dialedUrls) {
      expect(url).not.toContain(parsed.secret)
      expect(url).not.toContain(offerTokens.auth)
    }
    const relayed = JSON.stringify(wire)
    expect(relayed).not.toContain(parsed.secret)
    expect(relayed).not.toContain(offerTokens.auth)
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
      authToken: (await deriveOfferTokens(parsed.secret)).auth,
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
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const clientRaw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(offerTokens.route)}`)
    const { client, session } = await clientAccept(
      clientRaw,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
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

    // ── reconnect: dial the epoch route, prove the epoch auth ──
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const clientRaw2 = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`)
    const { client: client2 } = await clientAccept(
      clientRaw2,
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      epoch.auth, // sealed; the broker only ever saw epoch.route
      "jeremy@laptop",
    )
    await client2.ready()
    const res2 = await client2.forwardHttp({ method: "GET", path: "/health" })
    expect(res2.status).toBe(200)
    await client2.close()

    // ── revoke → the client is told, authenticated, that it was unpaired ──
    expect(await registry.revoke(fingerprint)).toBe(true)
    expect((await registry.list()).length).toBe(0)

    // The daemon keeps a tombstone on the pairing's epoch routes: a hello with
    // the epoch AUTH completes the (daemon-signed) handshake, then the only
    // frame is an E2E `error{pairing_revoked}` — never a hello, never served.
    const epoch2 = await deriveEpochTokens(pairRoot, currentEpoch())
    const refusal = await dialRevoked(epoch2, parsed.daemonX25519Pub, parsed.daemonEd25519Pub)
    expect(refusal).toEqual([expect.objectContaining({ t: "error", code: "pairing_revoked" })])

    // The broker knows the route; presenting it (or a guess) as the proof is
    // refused outright — the tombstone reveals nothing to it.
    await daemonParked(rendezvous, 2)
    const dialRoute = () => dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch2.route)}`)
    expect(await brokerAttempt(dialRoute, parsed.daemonX25519Pub, parsed.daemonEd25519Pub, epoch2.route)).toBe(
      "refused",
    )
    await daemonParked(rendezvous, 2)
    expect(await brokerAttempt(dialRoute, parsed.daemonX25519Pub, parsed.daemonEd25519Pub, guessToken())).toBe(
      "refused",
    )

    // The tombstone is persisted with route + auth per epoch — no pair root.
    const file = JSON.parse(await readFile(join(tmp, "pairings.json"), "utf8"))
    expect(file.pairings).toEqual([])
    expect(file.revoked).toHaveLength(1)
    expect(file.revoked[0].fingerprint).toBe(fingerprint)
    expect(file.revoked[0].pairRoot).toBeUndefined()
    expect(JSON.stringify(file.revoked)).not.toContain(pairRoot)
    expect(file.revoked[0].routes).toContainEqual({ epoch: currentEpoch(), ...epoch2 })
  })

  /** Dial a revoked pairing's epoch route, run the client handshake with the
   *  epoch auth, and collect every decrypted frame until the channel closes. */
  async function dialRevoked(
    tokens: { route: string; auth: string },
    daemonX25519Pub: string,
    daemonEd25519Pub: string,
  ): Promise<TunnelFrame[]> {
    // Let the revoked loops' sockets leave the broker before the tombstone's
    // park is the one we splice with.
    await new Promise(r => setTimeout(r, 150))
    await daemonParked(rendezvous, 1)
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(tokens.route)}`)
    const started = await startClientHandshake({
      daemonX25519Pub,
      daemonEd25519Pub,
      authToken: tokens.auth,
      clientName: "revoked",
    })
    const wrapped = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 4_000 },
    )
    return framesUntilClosed(wrapped)
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
    await daemonParked(rendezvous, 1)
    const parsed = await parseOfferUrl(offer.url)
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const { client: first, session } = await clientAccept(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(offerTokens.route)}`),
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
      "phone",
    )
    await first.ready()
    await first.close()
    const pairRoot = await derivePairRoot(session)
    const fingerprint = (await registry.list())[0]!.fingerprint

    // Reconnect on the epoch route, then revoke while it's live.
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
    await daemonParked(rendezvous, 1)
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`)
    const started = await startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      authToken: epoch.auth,
      clientName: "phone",
    })
    const wrapped = await clientHandshakeOverSink(
      raw,
      encodePairingMessage(started.hello),
      reply => started.complete(decodePairingReply(reply)),
      { timeoutMs: 4_000 },
    )
    const frames: TunnelFrame[] = []
    wrapped.onFrame(f => frames.push(f))
    await vi.waitFor(() => expect(frames.map(f => f.t)).toContain("hello"))
    const closed = new Promise<void>(resolve => wrapped.onClose(() => resolve()))

    await registry.revoke(fingerprint)
    await closed
    expect(frames.at(-1)).toMatchObject({ t: "error", code: "pairing_revoked" })
  }, 30_000)

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
    await daemonParked(rendezvous, 1)
    const parsed = await parseOfferUrl(offer.url)
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const { client, session } = await clientAccept(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(offerTokens.route)}`),
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
      "phone",
    )
    await client.ready()
    await client.close()
    const pairRoot = await derivePairRoot(session)
    expect(await registry.revoke((await registry.list())[0]!.fingerprint)).toBe(true)

    // Nobody parks on the routes any more: the handshake finds no daemon.
    await new Promise(r => setTimeout(r, 100))
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
    const raw = await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`)
    const started = await startClientHandshake({
      daemonX25519Pub: parsed.daemonX25519Pub,
      daemonEd25519Pub: parsed.daemonEd25519Pub,
      authToken: epoch.auth,
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
  }, 30_000)

  it("the broker's view (route + public offer data) can't spend an offer or get a reconnect served", async () => {
    const served: PairingChannelContext[] = []
    const serveReal = makeServe()
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialRv(url, signal),
      serve: (sink, ctx) => {
        served.push(ctx)
        return serveReal(sink)
      },
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })

    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const parsed = await parseOfferUrl(offer.url)
    // The adversary knows: the route (it's on the daemon's upgrade URL), the rv
    // URL, and the daemon's public keys. It does NOT know parsed.secret.
    const { route } = await deriveOfferTokens(parsed.secret)
    // The broker drops what a client sends before its splice, so (like a real
    // client) each attempt waits until the daemon has re-parked after the last.
    let parkedDaemons = 1
    const dialRoute = (r: string) => async () => {
      await daemonParked(rendezvous, parkedDaemons)
      return dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(r)}`)
    }
    const pk = parsed.daemonX25519Pub
    const sk = parsed.daemonEd25519Pub

    // pair/v2 hello proving the route (the pre-fix attack, re-tried) or a guess.
    expect(await brokerAttempt(dialRoute(route), pk, sk, route)).toBe("refused")
    expect(await brokerAttempt(dialRoute(route), pk, sk, guessToken())).toBe("refused")
    // The exact pair/v1 attack — offerToken = the route. Answered with the
    // re-pair notice and nothing else.
    const v1 = await v1ClientHandshake(await dialRoute(route)(), pk, sk, route)
    const v1Frames = await framesUntilClosed(v1)
    expect(v1Frames.map(f => f.t)).toEqual(["error", "hello"])

    expect(served).toHaveLength(0)
    expect(await registry.list()).toHaveLength(0)

    // The offer survived all of it: the legitimate client still pairs.
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const { client, session } = await clientAccept(
      await dialRoute(route)(),
      pk,
      sk,
      offerTokens.auth,
      "legit",
    )
    await client.ready()
    expect((await client.forwardHttp({ method: "GET", path: "/health" })).status).toBe(200)
    expect(served.map(c => c.mode)).toEqual(["offer"])
    await client.close()

    // ── reconnect: the broker logged today's epoch route ──
    parkedDaemons = 2 // current + previous epoch
    const pairRoot = await derivePairRoot(session)
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
    expect(await brokerAttempt(dialRoute(epoch.route), pk, sk, epoch.route)).toBe("refused")
    expect(await brokerAttempt(dialRoute(epoch.route), pk, sk, guessToken())).toBe("refused")
    // Replaying the route as a v1 proof (the pre-fix reconnect replay).
    const v1r = await v1ClientHandshake(await dialRoute(epoch.route)(), pk, sk, epoch.route)
    expect((await framesUntilClosed(v1r)).map(f => f.t)).toEqual(["error", "hello"])
    expect(served.map(c => c.mode)).toEqual(["offer"])

    // …while the paired client, proving the sealed epoch auth, is served.
    const { client: again } = await clientAccept(
      await dialRoute(epoch.route)(),
      pk,
      sk,
      epoch.auth,
      "legit",
    )
    await again.ready()
    expect(served.map(c => c.mode)).toEqual(["offer", "reconnect"])
    await again.close()
  }, 30_000)

  it("round trip: pair, then reconnect after the UTC day rolls over (current + previous epoch)", async () => {
    const DAY = 86_400_000
    let clock = DAY * 20_000 + DAY - 5_000 // five seconds before midnight
    const mk = () =>
      createPairingRegistry({
        loadIdentity: async () => identity,
        pairingsPath: join(tmp, "pairings.json"),
        defaultRendezvousUrl: rvUrl,
        dial: (url, signal) => dialRv(url, signal),
        serve: makeServe(),
        now: () => clock,
        handshakeTimeoutMs: 4_000,
        reconnectMinMs: 50,
        reconnectMaxMs: 200,
      })
    registry = mk()
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const parsed = await parseOfferUrl(offer.url)
    const offerTokens = await deriveOfferTokens(parsed.secret)
    await daemonParked(rendezvous, 1)
    const { client, session } = await clientAccept(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(offerTokens.route)}`),
      parsed.daemonX25519Pub,
      parsed.daemonEd25519Pub,
      offerTokens.auth,
      "roller",
    )
    await client.ready()
    await client.close()
    const pairRoot = await derivePairRoot(session)
    const day0 = currentEpoch(clock)

    // Midnight passes; the daemon restarts on the new day and autoconnects.
    await registry.shutdown()
    clock += 10_000
    registry = mk()
    await registry.startAutoconnect()
    expect(currentEpoch(clock)).toBe(day0 + 1)

    // A client already on the new day, and one whose clock still lags on the
    // old day: both are served, each proving that epoch's sealed auth.
    for (const e of [day0 + 1, day0]) {
      const t = await deriveEpochTokens(pairRoot, e)
      await daemonParked(rendezvous, 2)
      const { client: c } = await clientAccept(
        await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(t.route)}`),
        parsed.daemonX25519Pub,
        parsed.daemonEd25519Pub,
        t.auth,
        "roller",
      )
      await c.ready()
      expect((await c.forwardHttp({ method: "GET", path: "/health" })).status).toBe(200)
      await c.close()
    }

    // An epoch's auth only opens that epoch's route.
    const today = await deriveEpochTokens(pairRoot, day0 + 1)
    const yesterday = await deriveEpochTokens(pairRoot, day0)
    await daemonParked(rendezvous, 2)
    expect(
      await brokerAttempt(
        () => dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(today.route)}`),
        parsed.daemonX25519Pub,
        parsed.daemonEd25519Pub,
        yesterday.auth,
      ),
    ).toBe("refused")
  }, 30_000)

  it("a legacy pair/v1 pairings.json is reported, never served, and its v1 client is told to re-pair", async () => {
    const pairRoot = randomBytes(32).toString("base64")
    const legacyRecord = {
      clientPub: "legacy-client-pub",
      name: "old-laptop",
      fingerprint: "0123456789abcdef",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSeen: "2026-07-01T00:00:00.000Z",
      pairRoot,
      rendezvousUrl: rvUrl,
    }
    const pairingsPath = join(tmp, "pairings.json")
    await writeFile(pairingsPath, JSON.stringify({ v: 1, pairings: [legacyRecord] }), { mode: 0o600 })

    const logs: string[] = []
    const served: PairingChannelContext[] = []
    const serveReal = makeServe()
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath,
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialRv(url, signal),
      serve: (sink, ctx) => {
        served.push(ctx)
        return serveReal(sink)
      },
      log: line => logs.push(line),
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })
    await registry.startAutoconnect()

    // Reported on load, listed as legacy — not silently kept.
    expect(logs.join("\n")).toMatch(/pair\/v1.*agentproto pair offer/)
    expect(await registry.list()).toEqual([{ ...legacyRecord, legacy: true }])

    // The pairing's un-upgraded v1 client reconnects as it always did — its
    // epoch token as both route and proof — and gets the re-pair notice
    // inside a channel it can read, not a silent timeout.
    const epoch = await deriveEpochTokens(pairRoot, currentEpoch())
    await daemonParked(rendezvous, 2)
    const v1 = await v1ClientHandshake(
      await dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`),
      identity.x25519.pub,
      identity.ed25519.pub,
      epoch.route,
    )
    const frames = await framesUntilClosed(v1)
    expect(frames).toHaveLength(2)
    const [err, hello] = frames
    expect(err).toMatchObject({ t: "error", code: "pairing_protocol_outdated" })
    expect(err?.t === "error" && err.message).toMatch(/agentproto pair offer/)
    // A v1 TunnelClient surfaces only an unknown hello version (verbatim).
    expect(hello?.t === "hello" && hello.version).toMatch(/re-pair: run `agentproto pair offer`/)

    // Even a v2 hello with the right epoch auth isn't served on a v1 record.
    await daemonParked(rendezvous, 2)
    expect(
      await brokerAttempt(
        () => dialRv(`${rvUrl}?side=client&t=${encodeURIComponent(epoch.route)}`),
        identity.x25519.pub,
        identity.ed25519.pub,
        epoch.auth,
      ),
    ).toBe("refused")
    expect(served).toHaveLength(0)

    // Revocable like any pairing; the rewritten file is v2.
    expect(await registry.revoke("old-laptop")).toBe(true)
    expect(JSON.parse(await readFile(pairingsPath, "utf8"))).toEqual({ v: 2, pairings: [] })
  }, 30_000)
})
