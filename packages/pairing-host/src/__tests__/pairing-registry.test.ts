import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTunnelServer, type E2eFrameSink, type FrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { parseOfferUrl, deriveOfferTokens } from "@agentproto/secrets/pairing"
import {
  createPairingRegistry,
  type PairingChannelContext,
  type PairingChannelHandle,
  type PairingHostRegistry,
} from "../index.js"
import { FakeRendezvous, pairViaOffer, reconnect } from "./fixtures.js"

describe("pairing registry over an in-memory rendezvous", () => {
  let tmp: string
  let identity: DaemonIdentity
  const registries: PairingHostRegistry[] = []
  const served: PairingChannelContext[] = []

  const make = (rv: FakeRendezvous): PairingHostRegistry => {
    const registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: rv.dial,
      serve: (sink: E2eFrameSink, ctx): PairingChannelHandle => {
        served.push(ctx)
        const server = createTunnelServer({ sink, authorize: () => null, label: "test-host", pty: false })
        return { close: () => server.close() }
      },
      handshakeTimeoutMs: 5_000,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
    })
    registries.push(registry)
    return registry
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-host-"))
    identity = await generateIdentity()
    served.length = 0
  })
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdown().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("offer -> accept reaches serve, persists a pairing", async () => {
    const rv = new FakeRendezvous()
    const registry = make(rv)
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")

    const hello = await client.ready()
    expect(hello.label).toBe("test-host")
    expect(served).toHaveLength(1)
    expect(served[0]).toMatchObject({ mode: "offer", name: "phone" })

    const listed = await registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe("phone")
    expect(listed[0]?.local).toBeUndefined()
    const file = JSON.parse(await readFile(join(tmp, "pairings.json"), "utf8"))
    expect(file.v).toBe(2)
    expect(file.pairings).toHaveLength(1)
    expect(file.localDevices).toBeUndefined()
    await client.close()
  })

  it("a paired device reconnects after a host restart", async () => {
    const rv = new FakeRendezvous()
    const first = make(rv)
    const offer = await first.createOffer({ ttlMs: 60_000 })
    const { client, pairRoot, daemon } = await pairViaOffer(rv, offer.url, "phone")
    await client.ready()
    await client.close()
    const [fingerprint] = (await first.list()).map(p => p.fingerprint)
    await first.shutdown()

    // "Restart": a fresh registry over the same pairings.json.
    const second = make(rv)
    await second.startAutoconnect()
    const client2 = await reconnect(rv, pairRoot, daemon, "phone")
    expect((await client2.ready()).label).toBe("test-host")
    expect(served.at(-1)).toMatchObject({ mode: "reconnect", fingerprint })
    expect(second.isOnline(fingerprint as string)).toBe(true)
    await client2.close()
    // Let the loop re-park before afterEach shuts down (see the abort-vs-dial
    // window in runLoop: a shutdown landing between dial and handshake waits
    // out handshakeTimeoutMs).
    await new Promise(r => setTimeout(r, 100))
  })
})


describe("pairing registry — post-handshake diagnostics (BOOTSTRAP P4 item 2)", () => {
  let tmp: string
  let identity: DaemonIdentity
  const registries: PairingHostRegistry[] = []

  const make = (rv: FakeRendezvous, log?: (line: string) => void): PairingHostRegistry => {
    const registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: rv.dial,
      serve: (sink: E2eFrameSink): PairingChannelHandle => {
        const server = createTunnelServer({ sink, authorize: () => null, label: "test-host", pty: false })
        return { close: () => server.close() }
      },
      handshakeTimeoutMs: 5_000,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      ...(log ? { log } : {}),
    })
    registries.push(registry)
    return registry
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-host-p4-"))
    identity = await generateIdentity()
  })
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdown().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  /** Dial the loop for `route` and speak garbage instead of a proper
   *  pair/v2 hello — the daemon-side handshake must reject, and the failure
   *  must be LOGGED (naming the step), not swallowed like before. */
  async function dialGarbageClient(rv: FakeRendezvous, offerUrl: string): Promise<void> {
    const parsed = await parseOfferUrl(offerUrl)
    const tokens = await deriveOfferTokens(parsed.secret)
    const raw = await rv.dialClient(tokens.route)
    raw.send({ t: "garbage" } as unknown as Parameters<FrameSink["send"]>[0])
  }

  it("logs a handshake failure naming the step, and rate-limits repeats", async () => {
    const rv = new FakeRendezvous()
    const logs: string[] = []
    const registry = make(rv, line => logs.push(line))
    const created = await registry.createOffer({ ttlMs: 60_000 })

    await dialGarbageClient(rv, created.url)
    await vi.waitFor(() => {
      expect(logs.some(l => l.includes("handshake for offer:") && l.includes("expected an e2e_handshake frame"))).toBe(true)
    })

    // A second failure on the SAME loop key (same offer route — the loop
    // re-parks after its backoff) within the log gate's window is suppressed.
    await vi.waitFor(async () => {
      await dialGarbageClient(rv, created.url)
    })
    await new Promise(r => setTimeout(r, 150))
    expect(logs.filter(l => l.includes("handshake for offer:"))).toHaveLength(1)
  })

  it("the post-reply remote close reason reaches the daemon log via the e2e hook (field-evidence hook)", async () => {
    const rv = new FakeRendezvous()
    const logs: string[] = []
    const registry = make(rv, line => logs.push(line))
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")
    await vi.waitFor(() => expect(logs.some(l => l.includes("channel up"))).toBe(true))

    ;(client as unknown as { close: (reason?: string) => void }).close("flap: transport reset")
    await vi.waitFor(() => {
      // `daemonHandshakeOverSink`'s log hook (wired in the accept-loop) is
      // the field evidence's exact spot: the reason WAS captured at this
      // layer and discarded. It must now reach the log, labelled with the
      // loop key.
      const line = logs.find(l => l.includes("daemon handshake channel closed by remote after reply"))
      expect(line).toBeDefined()
      expect(line).toContain("handshake channel closed by remote after reply")
    })
  })

  it("the channel-closed log carries the remote close reason", async () => {
    const rv = new FakeRendezvous()
    const logs: string[] = []
    const registry = make(rv, line => logs.push(line))
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")
    await vi.waitFor(() => expect(logs.some(l => l.includes("channel up"))).toBe(true))

    ;(client as unknown as { close: (reason?: string) => void }).close("flap: transport reset")
    await vi.waitFor(() => {
      // The closed log now names WHY the channel came down. A TunnelClient's
      // own close is relayed by the E2E layer as the generic "client.close"
      // label; a transport-level reason (the case the instrumentation is
      // for — a flap mid-conversation) flows through verbatim. Assert a
      // reason is present, not a bare "(remote closed without a reason)".
      // (Match the per-channel line specifically — the e2e hook's
      // "handshake channel closed by remote after reply" line also contains
      // the words "channel closed".)
      const line = logs.find(l => /channel closed \(\w+\) for/.test(l))
      expect(line).toBeDefined()
      expect(line).not.toContain("remote closed without a reason")
      expect(line).toMatch(/channel closed \(\w+\) for [0-9a-f]+: \S/)
    })
  })
})
