/**
 * End-to-end coverage for the CLI's client-side pairing transport — the actual
 * code `agentproto pair accept` / `pair exec` ship. Stands up a real rendezvous
 * broker + the runtime pairing registry (the daemon side), then drives the
 * CLI's own `acceptOffer` → `openPairChannel` → `createLoopbackBridge` path and
 * asserts an HTTP round-trip flows over the E2E channel — the routing seam a
 * child `agentproto <verb>` rides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import WebSocket from "ws"
import {
  createTunnelServer,
  wrapWebSocket,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createRendezvousServer, type RendezvousServer } from "@agentproto/rendezvous"
import {
  createPairingRegistry,
  type PairingChannelHandle,
  type PairingRegistry,
} from "@agentproto/runtime"
import { acceptOffer, openPairChannel, createLoopbackBridge } from "../pair-transport.js"
import { findClientPairing, loadClientPairings } from "../client-pairings.js"

/** The daemon's `serve`: a real tunnel server forwarding to a real upstream. */
function makeServe(upstreamUrl: string): (sink: E2eFrameSink) => PairingChannelHandle {
  return sink => {
    const server = createTunnelServer({
      sink,
      authorize: r => r,
      httpUpstream: upstreamUrl,
      label: "paired-daemon",
      pty: false,
    })
    return { close: () => server.close() }
  }
}

describe("CLI pairing transport (accept → reconnect → bridge)", () => {
  let tmp: string
  let prevHome: string | undefined
  let identity: DaemonIdentity
  let rendezvous: RendezvousServer
  let rvUrl: string
  let upstream: Server
  let upstreamUrl: string
  let registry: PairingRegistry | null = null
  const openSockets: WebSocket[] = []

  function dialRv(url: string, signal: AbortSignal): Promise<FrameSink> {
    const ws = new WebSocket(url)
    openSockets.push(ws)
    return new Promise((resolve, reject) => {
      ws.once("open", () =>
        resolve(wrapWebSocket(ws as unknown as Parameters<typeof wrapWebSocket>[0])),
      )
      ws.once("error", err => reject(err))
      signal.addEventListener("abort", () => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error("aborted"))
      })
    })
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-cli-pair-"))
    prevHome = process.env["AGENTPROTO_HOME"]
    process.env["AGENTPROTO_HOME"] = tmp
    identity = generateIdentity()

    // A real upstream that echoes the requested path, so the whole path — the
    // test's real `fetch` → loopback bridge → E2E channel → daemon tunnel →
    // upstream — exercises without any global stubbing.
    upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    upstream.listen(0, "127.0.0.1")
    await once(upstream, "listening")
    const uaddr = upstream.address()
    upstreamUrl = `http://127.0.0.1:${uaddr && typeof uaddr === "object" ? uaddr.port : 0}`

    rendezvous = createRendezvousServer({ parkTimeoutMs: 5_000 })
    const { port } = await rendezvous.listen(0, "127.0.0.1")
    rvUrl = `ws://127.0.0.1:${port}/v1`
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env["AGENTPROTO_HOME"]
    else process.env["AGENTPROTO_HOME"] = prevHome
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
    await new Promise<void>(r => upstream.close(() => r()))
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  function startDaemon(): PairingRegistry {
    return createPairingRegistry({
      loadIdentity: async () => identity,
      pairingsPath: join(tmp, "pairings.json"),
      defaultRendezvousUrl: rvUrl,
      dial: (url, signal) => dialRv(url, signal),
      serve: makeServe(upstreamUrl),
      handshakeTimeoutMs: 4_000,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    })
  }

  it("acceptOffer persists a client pairing pinned to the daemon fingerprint", async () => {
    registry = startDaemon()
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))

    const result = await acceptOffer(offer.url, "my-laptop")
    expect(result.fingerprint).toBe(offer.fingerprint)
    expect(result.name).toBe("my-laptop")

    const persisted = await findClientPairing("my-laptop")
    expect(persisted?.fingerprint).toBe(offer.fingerprint)
    expect(persisted?.rendezvousUrl).toBe(rvUrl)
    expect(typeof persisted?.pairRoot).toBe("string")
    // Daemon persisted its half too.
    await vi.waitFor(async () => expect((await registry!.list()).length).toBe(1))
  })

  it("openPairChannel reconnects with the epoch token and routes HTTP through the bridge", async () => {
    registry = startDaemon()
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    await acceptOffer(offer.url, "my-laptop")
    await vi.waitFor(async () => expect((await registry!.list()).length).toBe(1))

    const pairing = await findClientPairing("my-laptop")
    expect(pairing).toBeDefined()

    // The daemon's standing reconnect loop parks on the epoch routing token.
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    const channel = await openPairChannel(pairing!)
    const bridge = await createLoopbackBridge(channel.client)
    try {
      const res = await fetch(`${bridge.url}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; path: string }
      expect(body.ok).toBe(true)
      expect(body.path).toContain("/health")
    } finally {
      await bridge.close()
      await channel.close()
    }
  })

  it("a revoked pairing can no longer open a channel", async () => {
    registry = startDaemon()
    const offer = await registry.createOffer({ ttlMs: 60_000 })
    await vi.waitFor(() => expect(rendezvous.stats.parked).toBeGreaterThanOrEqual(1))
    await acceptOffer(offer.url, "doomed")
    await vi.waitFor(async () => expect((await registry!.list()).length).toBe(1))

    const pairing = await findClientPairing("doomed")
    // The daemon-side record is keyed by the CLIENT's fingerprint (the client
    // store pins the DAEMON's), so revoke against the daemon's own list.
    const daemonRecord = (await registry.list())[0]
    expect(await registry.revoke(daemonRecord!.fingerprint)).toBe(true)

    // The client record still exists locally, but the daemon no longer parks on
    // the epoch token, so both epoch attempts fail to splice → handshake never
    // readies → openPairChannel rejects.
    await new Promise(r => setTimeout(r, 100))
    await expect(
      openPairChannel(pairing!, { handshakeTimeoutMs: 400, dialTimeoutMs: 2_000 }),
    ).rejects.toBeTruthy()
    // The client store is untouched by a failed reconnect.
    expect((await loadClientPairings()).pairings).toHaveLength(1)
  }, 15_000)
})
