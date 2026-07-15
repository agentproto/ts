import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HOSTED_RENDEZVOUS_URL,
  PairingError,
  parseOfferUrl,
} from "@agentproto/secrets/pairing"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import {
  createPairingRegistry,
  type PairingChannelHandle,
  type PairingRegistry,
  type PairingRegistryDeps,
} from "../pairing-registry.js"

/**
 * Precedence + transparency + opt-out for the hosted rendezvous default
 * (PLAN deliverables 2, 3, 4). These exercise `createOffer`'s decision alone —
 * they never complete a handshake, so `dial` just parks until shutdown and
 * `serve` is never called.
 */
describe("hosted rendezvous default", () => {
  let tmp: string
  let identity: DaemonIdentity
  let registry: PairingRegistry | null = null

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-rvdefault-"))
    identity = generateIdentity()
  })
  afterEach(async () => {
    if (registry) await registry.shutdown().catch(() => {})
    registry = null
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  /** A registry whose `dial` parks until the shutdown signal aborts it (so the
   *  offer loop makes exactly one attempt and never busy-spins) and whose
   *  `serve` is a never-invoked noop. `defaultRendezvousUrl` is threaded through
   *  only when provided, so we can test the "key absent" state too. */
  function makeRegistry(defaultRendezvousUrl?: string): PairingRegistry {
    const deps: PairingRegistryDeps = {
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      dial: (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          )
        }),
      serve: (): PairingChannelHandle => ({ close: async () => {} }),
      ...(defaultRendezvousUrl !== undefined ? { defaultRendezvousUrl } : {}),
    }
    return createPairingRegistry(deps)
  }

  it("applies the hosted default when nothing is configured", async () => {
    registry = makeRegistry() // no config key at all
    const offer = await registry.createOffer({ ttlMs: 60_000 })

    expect(offer.rendezvousUrl).toBe(HOSTED_RENDEZVOUS_URL)
    expect(offer.rendezvousIsHostedDefault).toBe(true)
    // The default is baked into the offer URL's `rv=`, so the client dials it too.
    expect(parseOfferUrl(offer.url).rendezvousUrl).toBe(HOSTED_RENDEZVOUS_URL)
  })

  it("lets `pairing.rendezvous` in config beat the hosted default", async () => {
    const configured = "wss://broker.example/v1"
    registry = makeRegistry(configured)
    const offer = await registry.createOffer({ ttlMs: 60_000 })

    expect(offer.rendezvousUrl).toBe(configured)
    expect(offer.rendezvousIsHostedDefault).toBe(false)
    expect(parseOfferUrl(offer.url).rendezvousUrl).toBe(configured)
  })

  it("lets an explicit `--rendezvous` beat config (and the default)", async () => {
    registry = makeRegistry("wss://broker.example/v1")
    const flag = "wss://flag.example/v1"
    const offer = await registry.createOffer({ ttlMs: 60_000, rendezvousUrl: flag })

    expect(offer.rendezvousUrl).toBe(flag)
    expect(offer.rendezvousIsHostedDefault).toBe(false)
  })

  it("treats `pairing.rendezvous: \"\"` as an explicit opt-out — offers fail closed", async () => {
    registry = makeRegistry("") // deliberate opt-out
    await expect(registry.createOffer({ ttlMs: 60_000 })).rejects.toBeInstanceOf(
      PairingError,
    )
    await expect(registry.createOffer({ ttlMs: 60_000 })).rejects.toThrow(
      /rendezvous disabled/i,
    )
  })

  it("honours `--rendezvous` even when config opts out with \"\"", async () => {
    registry = makeRegistry("")
    const flag = "wss://flag.example/v1"
    const offer = await registry.createOffer({ ttlMs: 60_000, rendezvousUrl: flag })

    expect(offer.rendezvousUrl).toBe(flag)
    expect(offer.rendezvousIsHostedDefault).toBe(false)
  })
})
