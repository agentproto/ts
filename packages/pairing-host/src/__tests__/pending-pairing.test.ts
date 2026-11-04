/**
 * AIP-59 §3.7: a first-contact handshake creates a PENDING pairing. It is
 * held in memory only, cannot drive anything, and is not listed or persisted
 * until the operator confirms it. A decline, the offer TTL, or a restart
 * drops it.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTunnelServer, type E2eFrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import {
  createPairingRegistry,
  type PairingChannelHandle,
  type PairingHostRegistry,
} from "../index.js"
import { FakeRendezvous, pairViaOffer } from "./fixtures.js"

describe("pending pairings (AIP-59 §3.7)", () => {
  let tmp: string
  let identity: DaemonIdentity
  const registries: PairingHostRegistry[] = []
  let clock: number

  const make = (rv: FakeRendezvous): PairingHostRegistry => {
    const registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: rv.dial,
      serve: (sink: E2eFrameSink): PairingChannelHandle => {
        const server = createTunnelServer({
          sink,
          authorize: () => null,
          httpUpstream: "http://127.0.0.1:1/upstream",
          label: "test-host",
          pty: false,
        })
        return { close: () => server.close() }
      },
      handshakeTimeoutMs: 5_000,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      now: () => clock,
    })
    registries.push(registry)
    return registry
  }

  async function pendingPaired(rv: FakeRendezvous, registry: PairingHostRegistry) {
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    const paired = await pairViaOffer(rv, offer.url, "phone")
    await paired.client.ready()
    const [pending] = await registry.listPending()
    expect(pending).toBeDefined()
    return { ...paired, pending: pending! }
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-pending-"))
    identity = await generateIdentity()
    clock = Date.now() - 1_000
  })
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdown().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("confirm promotes the pending pairing into pairings.json and opens the gate", async () => {
    const rv = new FakeRendezvous()
    const registry = make(rv)
    const { client, pending } = await pendingPaired(rv, registry)

    // Not listed, not persisted, not online while pending.
    expect(await registry.list()).toEqual([])
    expect(registry.isOnline(pending.fingerprint)).toBe(false)
    await expect(readFile(join(tmp, "pairings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    // A pending pairing can drive nothing: an app path is refused, not served.
    const refused = await client.forwardHttp({
      method: "GET",
      path: `/d/${pending.fingerprint}/apps/@agentik/session-chat/ui/`,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain("pairing_pending")

    expect(await registry.confirmPending(pending.code)).toBe(true)
    expect(await registry.listPending()).toEqual([])
    const listed = await registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: "phone", fingerprint: pending.fingerprint })
    const file = JSON.parse(await readFile(join(tmp, "pairings.json"), "utf8"))
    expect(file.pairings).toHaveLength(1)
    expect(file.pairings[0].fingerprint).toBe(pending.fingerprint)
    await client.close()
  })

  it("decline drops the pending pairing without persisting it", async () => {
    const rv = new FakeRendezvous()
    const registry = make(rv)
    const { client, pending } = await pendingPaired(rv, registry)

    expect(await registry.declinePending(pending.code)).toBe(true)
    expect(await registry.listPending()).toEqual([])
    expect(await registry.list()).toEqual([])
    await expect(readFile(join(tmp, "pairings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await client.close().catch(() => {})
  })

  it("the offer TTL drops a pending pairing that is never confirmed", async () => {
    const rv = new FakeRendezvous()
    const registry = make(rv)
    const { client, pending } = await pendingPaired(rv, registry)

    clock += 61_000
    expect(await registry.listPending()).toEqual([])
    expect(await registry.confirmPending(pending.code)).toBe(false)
    expect(await registry.list()).toEqual([])
    await client.close().catch(() => {})
  })

  it("a restart with a pending pairing leaves nothing in pairings.json", async () => {
    const rv = new FakeRendezvous()
    const first = make(rv)
    const { client } = await pendingPaired(rv, first)
    await client.close().catch(() => {})
    await first.shutdown()

    const second = make(rv)
    await second.startAutoconnect()
    expect(await second.list()).toEqual([])
    expect(await second.listPending()).toEqual([])
    await expect(readFile(join(tmp, "pairings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
