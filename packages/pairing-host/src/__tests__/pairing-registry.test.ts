import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTunnelServer, type E2eFrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
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
