import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FrameSink } from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { currentEpoch } from "@agentproto/secrets/pairing"
import {
  createPairingRegistry,
  type PairingChannelHandle,
  type PairingHostRegistry,
} from "../pairing-registry.js"

/** A parked rendezvous socket nobody ever joins: it never delivers a frame,
 *  so the daemon-side handshake waits out its timeout. With `closeOnSubscribe`
 *  it instead hangs up as soon as the handshake listens for a close, the
 *  "transport closed during handshake" failure. */
class SilentSink implements FrameSink {
  isOpen = true
  private closeHandlers = new Set<(reason?: string) => void>()
  constructor(private readonly closeOnSubscribe = false) {}
  send(): void {}
  close(reason?: string): void {
    if (!this.isOpen) return
    this.isOpen = false
    for (const handler of [...this.closeHandlers]) handler(reason)
  }
  onFrame(): () => void {
    return () => {}
  }
  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler)
    if (this.closeOnSubscribe) queueMicrotask(() => this.close("peer hung up"))
    return () => this.closeHandlers.delete(handler)
  }
}

describe("pairing loops: an idle park is not a logged failure", () => {
  let tmp: string
  let identity: DaemonIdentity
  const registries: PairingHostRegistry[] = []

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-idle-park-"))
    identity = await generateIdentity()
  })
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdown().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  function make(opts: { closeOnSubscribe?: boolean } = {}): {
    registry: PairingHostRegistry
    dials: string[]
    logs: string[]
  } {
    const dials: string[] = []
    const logs: string[] = []
    const registry = createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: "ws://broker.invalid/v1",
      dial: async url => {
        dials.push(url)
        return new SilentSink(opts.closeOnSubscribe)
      },
      serve: (): PairingChannelHandle => ({ close: async () => {} }),
      log: line => logs.push(line),
      handshakeTimeoutMs: 10,
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
    })
    registries.push(registry)
    return { registry, dials, logs }
  }

  /** A pairings.json holding one live tombstone (revoked an hour ago, grace
   *  not over), with route + auth tokens for the current and previous epoch. */
  async function writeTombstone(): Promise<void> {
    const at = Date.now()
    const epoch = currentEpoch(at)
    await writeFile(
      join(tmp, "pairings.json"),
      JSON.stringify({
        v: 2,
        pairings: [],
        revoked: [
          {
            fingerprint: "0123456789abcdef0123456789abcdef",
            name: "old phone",
            rendezvousUrl: "ws://broker.invalid/v1",
            revokedAt: new Date(at - 3_600_000).toISOString(),
            expiresAt: new Date(at + 86_400_000).toISOString(),
            routes: [epoch - 1, epoch].map(e => ({ epoch: e, route: `route-${e}`, auth: `auth-${e}` })),
          },
        ],
      }),
    )
  }

  it("a revoked pairing's tombstone keeps parking, without logging each park timeout", async () => {
    await writeTombstone()
    const { registry, dials, logs } = make()
    await registry.startAutoconnect()

    // The tombstone still parks on both epoch routes (that is how a stale
    // client learns it was revoked), cycling several times.
    await vi.waitFor(() => {
      expect(dials.filter(u => u.includes("route-")).length).toBeGreaterThanOrEqual(6)
    }, { timeout: 2_000 })
    expect(new Set(dials.map(u => new URL(u).searchParams.get("t")))).toEqual(
      new Set([`route-${currentEpoch(Date.now()) - 1}`, `route-${currentEpoch(Date.now())}`]),
    )
    // ...but nobody came, which is the expected outcome: nothing to log.
    expect(logs.filter(l => l.includes("handshake for"))).toEqual([])
  })

  it("an offer nobody accepts re-parks silently", async () => {
    const { registry, dials, logs } = make()
    await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(dials.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 })
    expect(logs.filter(l => l.includes("handshake for"))).toEqual([])
  })

  it("a peer hanging up mid-handshake is still logged, naming the step", async () => {
    const { registry, logs } = make({ closeOnSubscribe: true })
    await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => {
      expect(logs.some(l => l.includes("handshake for offer:") && l.includes("transport closed during handshake"))).toBe(
        true,
      )
    }, { timeout: 2_000 })
  })
})
