/**
 * Unit tests for the device-registry additions to `PairingRegistry`
 * (DEVICES-PLAN PR-A): `rename`, `isOnline`, and the standalone
 * `readPairingsSnapshot` reader. In-process transport (see
 * pairing-integration.test.ts's first describe block) — no real rendezvous
 * needed for these.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTunnelServer,
  clientHandshakeOverSink,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  parseOfferUrl,
  deriveOfferTokens,
} from "@agentproto/secrets/pairing"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import {
  createPairingRegistry,
  readPairingsSnapshot,
  type PairingChannelContext,
  type PairingChannelHandle,
  type PairingRegistry,
} from "../pairing-registry.js"
import { connect, type Middleware } from "./frame-harness.js"

function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => ({
      status: 200,
      headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ ok: true, path: String(url) })).buffer,
    })),
  )
}

function makeServe(): (sink: E2eFrameSink, ctx: PairingChannelContext) => PairingChannelHandle {
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

async function clientAccept(
  rawSink: FrameSink,
  daemonX25519Pub: string,
  daemonEd25519Pub: string,
  authToken: string,
  name: string,
): Promise<E2eFrameSink> {
  const started = await startClientHandshake({ daemonX25519Pub, daemonEd25519Pub, authToken, clientName: name })
  return clientHandshakeOverSink(rawSink, encodePairingMessage(started.hello), async replyBytes =>
    started.complete(decodePairingReply(replyBytes)),
  )
}

describe("PairingRegistry: rename / isOnline", () => {
  let tmp: string
  let identity: DaemonIdentity
  let registry: PairingRegistry | null = null

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-devices-"))
    identity = await generateIdentity()
    stubUpstream()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    if (registry) await registry.shutdown().catch(() => {})
    registry = null
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  async function pairOnce(
    name: string,
    createOfferInput: { scope?: "host" } = {},
  ): Promise<{ fingerprint: string; client: E2eFrameSink }> {
    let clientSink: FrameSink | null = null
    const record: Middleware = (frame, deliver) => deliver(frame)
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
    const offer = await registry.createOffer({ ttlMs: 60_000, ...createOfferInput })
    await vi.waitFor(() => expect(clientSink).not.toBeNull())
    const parsed = await parseOfferUrl(offer.url)
    const offerTokens = await deriveOfferTokens(parsed.secret)
    const client = await clientAccept(clientSink!, parsed.daemonX25519Pub, parsed.daemonEd25519Pub, offerTokens.auth, name)
    await vi.waitFor(async () => expect((await registry!.list()).length).toBe(1))
    const fingerprint = (await registry.list())[0]!.fingerprint
    return { fingerprint, client }
  }

  it("rename by fingerprint updates the record and persists", async () => {
    const { fingerprint, client } = await pairOnce("jeremy@laptop")
    client.close("done")

    expect(await registry!.rename(fingerprint, "  laptop (renamed)  ")).toBe(true)
    const list = await registry!.list()
    expect(list[0]!.name).toBe("laptop (renamed)")

    // Re-load from disk to prove it was persisted, not just mutated in memory.
    const snapshot = await readPairingsSnapshot(join(tmp, "pairings.json"))
    expect(snapshot[0]!.name).toBe("laptop (renamed)")
  })

  it("rename by current name also works", async () => {
    const { client } = await pairOnce("jeremy@laptop")
    client.close("done")
    expect(await registry!.rename("jeremy@laptop", "new-name")).toBe(true)
    expect((await registry!.list())[0]!.name).toBe("new-name")
  })

  it("rename returns false for an unknown target, without throwing", async () => {
    const { client } = await pairOnce("jeremy@laptop")
    client.close("done")
    expect(await registry!.rename("no-such-device", "x")).toBe(false)
  })

  it("rename rejects an empty name", async () => {
    const { client } = await pairOnce("jeremy@laptop")
    client.close("done")
    await expect(registry!.rename("jeremy@laptop", "   ")).rejects.toThrow(/empty/)
  })

  it("isOnline reflects a live channel, then goes false once it's closed", async () => {
    const { fingerprint, client } = await pairOnce("jeremy@laptop")
    // `pairOnce` only waits for `list()` to show the record, which lands
    // (in-memory) before `onPaired`'s `persist()` resolves — `isOnline` only
    // flips after that whole call returns, so poll rather than assert inline.
    await vi.waitFor(() => expect(registry!.isOnline(fingerprint)).toBe(true))
    expect(registry!.isOnline("no-such-fp")).toBe(false)

    const closed = new Promise<void>(resolve => client.onClose(() => resolve()))
    client.close("done")
    await closed
    await vi.waitFor(() => expect(registry!.isOnline(fingerprint)).toBe(false))
  })

  it("createOffer({scope:'host'}) mints an offer whose URL carries scope=host", async () => {
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: async () => connect().b,
      serve: makeServe(),
      handshakeTimeoutMs: 1_000,
    })
    const offer = await registry.createOffer({ ttlMs: 60_000, scope: "host" })
    expect(offer.scope).toBe("host")
    expect(offer.url).toContain("scope=host")
    const parsed = await parseOfferUrl(offer.url)
    expect(parsed.scope).toBe("host")
  })

  it("createOffer with no scope mints a plain offer (no scope on the result or URL)", async () => {
    registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: async () => connect().b,
      serve: makeServe(),
      handshakeTimeoutMs: 1_000,
    })
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    expect(offer.scope).toBeUndefined()
    expect(offer.url).not.toContain("scope")
  })

  it("a host-scoped offer's resulting PairingRecord carries scope: host", async () => {
    const { client } = await pairOnce("office-mac", { scope: "host" })
    client.close("done")
    const [rec] = await registry!.list()
    expect(rec?.scope).toBe("host")
  })

  it("a plain offer's resulting PairingRecord has no scope key at all", async () => {
    const { client } = await pairOnce("jeremy@laptop")
    client.close("done")
    const [rec] = await registry!.list()
    expect(rec).not.toHaveProperty("scope")
  })

  it("scope is never taken from the client's hello — only from this daemon's own offer record", async () => {
    // The hello payload (handshake.ts's HelloPayload) has no scope field at
    // all, so there is nothing for a malicious/confused client to send that
    // could elevate a plain offer to host scope. A host-scoped offer yields
    // scope: host regardless of the client's chosen name/label.
    const { client } = await pairOnce("not-named-host-in-any-way", { scope: "host" })
    client.close("done")
    const [rec] = await registry!.list()
    expect(rec?.scope).toBe("host")
  })
})

describe("readPairingsSnapshot", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-pair-snapshot-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("returns [] when the file doesn't exist", async () => {
    expect(await readPairingsSnapshot(join(tmp, "missing.json"))).toEqual([])
  })

  it("returns [] on malformed JSON instead of throwing", async () => {
    const path = join(tmp, "pairings.json")
    await writeFile(path, "not json", "utf8")
    expect(await readPairingsSnapshot(path)).toEqual([])
  })

  it("parses a v2 file verbatim", async () => {
    const path = join(tmp, "pairings.json")
    const record = {
      clientPub: "pub",
      name: "laptop",
      fingerprint: "fp1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
      pairRoot: "root",
      rendezvousUrl: "wss://rdv.example/v1",
    }
    await writeFile(path, JSON.stringify({ v: 2, pairings: [record] }), "utf8")
    expect(await readPairingsSnapshot(path)).toEqual([record])
  })

  it("flags a v1 file's records as legacy", async () => {
    const path = join(tmp, "pairings.json")
    const record = {
      clientPub: "pub",
      name: "old-laptop",
      fingerprint: "fp1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
      pairRoot: "root",
      rendezvousUrl: "wss://rdv.example/v1",
    }
    await writeFile(path, JSON.stringify({ v: 1, pairings: [record] }), "utf8")
    expect(await readPairingsSnapshot(path)).toEqual([{ ...record, legacy: true }])
  })
})
