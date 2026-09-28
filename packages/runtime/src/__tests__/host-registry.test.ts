/**
 * Unit tests for `createHostRegistry` (DEVICES-PLAN PR-C) — the "client" half
 * of pair/v2, living daemon-side. Drives a fake "daemon" directly (in-process
 * transport, see frame-harness.ts) using `respondToHandshake` +
 * `daemonHandshakeOverSink` — the exact daemon-side primitives
 * `pairing-registry.ts` uses — so these tests exercise the real crypto, not a
 * mock of it.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, readFile, stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  daemonHandshakeOverSink,
  createTunnelServer,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  decodePairingHello,
  encodePairingMessage,
  respondToHandshake,
  derivePairRoot,
  deriveEpochTokens,
  deriveOfferTokens,
  currentEpoch,
  encodeOfferUrl,
  OFFER_VERSION,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { generateIdentity, identityFingerprint, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createHostRegistry, type HostRegistry } from "../host-registry.js"
import { connect, type Middleware } from "./frame-harness.js"

function stubUpstream(delayMs = 0): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      return {
        status: 200,
        headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ ok: true, path: String(url) })).buffer,
      }
    }),
  )
}

/** Build a host-scoped (or plain) offer URL for `identity`, plus the tokens a
 *  fake daemon needs to verify the first handshake against. */
async function makeOffer(
  identity: DaemonIdentity,
  opts: { scope?: "host"; rendezvousUrl?: string } = {},
): Promise<{ url: string; auth: string; fingerprint: string; secret: string }> {
  const secret = randomBytes(16).toString("base64url")
  const { auth } = await deriveOfferTokens(secret)
  const fingerprint = await identityFingerprint(identity.x25519.pub)
  const url = encodeOfferUrl({
    v: OFFER_VERSION,
    rendezvousUrl: opts.rendezvousUrl ?? "ws://broker.invalid/v1",
    fingerprint,
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    secret,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...(opts.scope ? { scope: opts.scope } : {}),
  })
  return { url, auth, fingerprint, secret }
}

/** Play the daemon side of one handshake attempt over `sink`, verifying the
 *  presented auth token with `verifyAuthToken`, then serve a real tunnel
 *  server over it (a stubbed upstream must be in place — `stubUpstream()`).
 *  Resolves with the derived session once the handshake completes. */
async function runFakeDaemon(
  sink: FrameSink,
  identity: DaemonIdentity,
  verifyAuthToken: (token: string) => boolean | Promise<boolean>,
): Promise<PairingSession> {
  let session: PairingSession | null = null
  const wrapped: E2eFrameSink = await daemonHandshakeOverSink(
    sink,
    async helloBytes => {
      const hello = decodePairingHello(helloBytes)
      const result = await respondToHandshake(hello, { identity, verifyAuthToken })
      session = result.session
      return { reply: encodePairingMessage(result.reply), keys: result.session }
    },
    { timeoutMs: 2_000 },
  )
  createTunnelServer({
    sink: wrapped,
    authorize: r => r,
    httpUpstream: "http://127.0.0.1:1/upstream",
    label: "fake-host",
    pty: false,
  })
  if (!session) throw new Error("fake daemon: handshake did not complete")
  return session
}

describe("createHostRegistry", () => {
  let tmp: string
  let hostsPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-hosts-"))
    hostsPath = join(tmp, "hosts.json")
    stubUpstream()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  describe("add()", () => {
    it("refuses a non-host-scoped offer with no dial attempted", async () => {
      const identity = await generateIdentity()
      const { url } = await makeOffer(identity) // no scope
      const dial = vi.fn()
      const registry = createHostRegistry({ hostsPath, dial })
      await expect(registry.add(url)).rejects.toThrow(/not host-scoped/)
      await expect(registry.add(url)).rejects.toThrow(/pair offer --host/)
      expect(dial).not.toHaveBeenCalled()
    })

    it("on a valid host-scoped offer, persists a HostRecord and returns the summary", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const record: Middleware = (frame, deliver) => deliver(frame)
      const dial = vi.fn(async () => {
        const { a, b } = connect(record, record)
        void runFakeDaemon(a, identity, token => token === auth)
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, dialTimeoutMs: 2_000 })

      const result = await registry.add(url, "office-mac")
      expect(result).toEqual({ fingerprint, name: "office-mac", rendezvousUrl: "ws://broker.invalid/v1" })

      const list = await registry.list()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        fingerprint,
        name: "office-mac",
        daemonX25519Pub: identity.x25519.pub,
        daemonEd25519Pub: identity.ed25519.pub,
        rendezvousUrl: "ws://broker.invalid/v1",
      })
      expect(typeof list[0]!.pairRoot).toBe("string")

      // Persisted 0600, atomic-written, matches the in-memory view.
      const st = await stat(hostsPath)
      expect(st.mode & 0o777).toBe(0o600)
      const file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.v).toBe(1)
      expect(file.hosts).toHaveLength(1)
      expect(file.hosts[0].fingerprint).toBe(fingerprint)
    })

    it("defaults the name to the fingerprint when none is given", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        void runFakeDaemon(a, identity, token => token === auth)
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial })
      const result = await registry.add(url)
      expect(result.name).toBe(fingerprint)
    })

    it("upserts by fingerprint — re-adding the same host replaces its record, keeping createdAt", async () => {
      const identity = await generateIdentity()
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        const offer = lastOffer
        void runFakeDaemon(a, identity, token => token === offer!.auth)
        return b
      })
      let lastOffer: Awaited<ReturnType<typeof makeOffer>> | undefined
      const registry = createHostRegistry({ hostsPath, dial })

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "first-name")
      const createdAt1 = (await registry.list())[0]!.createdAt

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "renamed")
      const list = await registry.list()
      expect(list).toHaveLength(1)
      expect(list[0]!.name).toBe("renamed")
      expect(list[0]!.createdAt).toBe(createdAt1)
    })

    it("rejects when the dial fails", async () => {
      const identity = await generateIdentity()
      const { url } = await makeOffer(identity, { scope: "host" })
      const registry = createHostRegistry({
        hostsPath,
        dial: async () => {
          throw new Error("connection refused")
        },
        dialTimeoutMs: 500,
      })
      await expect(registry.add(url)).rejects.toThrow(/connection refused/)
      expect(await registry.list()).toEqual([])
    })
  })

  describe("list / rename / revoke", () => {
    async function addOneHost(registry: HostRegistry, identity: DaemonIdentity, name: string): Promise<string> {
      const { url, fingerprint } = await makeOffer(identity, { scope: "host" })
      const result = await registry.add(url, name)
      expect(result.fingerprint).toBe(fingerprint)
      return fingerprint
    }

    it("round-trips through the JSON file", async () => {
      const identityA = await generateIdentity()
      const identityB = await generateIdentity()
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        void runFakeDaemon(a, currentIdentity, () => true)
        return b
      })
      let currentIdentity: DaemonIdentity = identityA
      const registry = createHostRegistry({ hostsPath, dial })

      currentIdentity = identityA
      const fpA = await addOneHost(registry, identityA, "host-a")
      currentIdentity = identityB
      const fpB = await addOneHost(registry, identityB, "host-b")

      expect((await registry.list()).map(h => h.fingerprint).sort()).toEqual([fpA, fpB].sort())

      expect(await registry.rename(fpA, "renamed-a")).toBe(true)
      expect((await registry.list()).find(h => h.fingerprint === fpA)?.name).toBe("renamed-a")
      expect(await registry.rename("no-such-host", "x")).toBe(false)
      expect(await registry.rename("host-b", "renamed-b")).toBe(true) // by current name

      expect(await registry.revoke(fpA)).toBe(true)
      expect((await registry.list()).map(h => h.fingerprint)).toEqual([fpB])
      expect(await registry.revoke(fpA)).toBe(false)

      // Reload from disk independently — proves persistence, not just memory.
      const file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts).toHaveLength(1)
      expect(file.hosts[0].fingerprint).toBe(fpB)
      expect(file.hosts[0].name).toBe("renamed-b")
    })

    it("rename rejects an empty name", async () => {
      const identity = await generateIdentity()
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        void runFakeDaemon(a, identity, () => true)
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial })
      const fp = await addOneHost(registry, identity, "host-a")
      await expect(registry.rename(fp, "   ")).rejects.toThrow(/empty/)
    })
  })

  describe("forwardHttp()", () => {
    it("rejects with 'no host matched' when the target is unknown, without dialing", async () => {
      const dial = vi.fn()
      const registry = createHostRegistry({ hostsPath, dial })
      await expect(registry.forwardHttp("no-such-host", { method: "GET", path: "/health" })).rejects.toThrow(
        /no host matched "no-such-host"/,
      )
      expect(dial).not.toHaveBeenCalled()
    })

    it("dials the current epoch, forwards the request, and updates lastSeen + isOnline", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      // Slow the stubbed upstream so the online window is wide enough for
      // vi.waitFor's polling to observe it — the round-trip is otherwise
      // fast enough (fully in-process) to flip back to false before the
      // first poll ever runs.
      stubUpstream(60)

      // The fake daemon accepts the offer auth (for `add()`) or, once it
      // knows the pair root (derived from the `add()` handshake's own
      // session), that epoch's auth (for a `forwardHttp` reconnect) —
      // mirroring what a real daemon's standing pairing verifies.
      let pairRootServer: string | null = null
      const verifyAuthToken = async (token: string): Promise<boolean> => {
        if (token === auth) return true
        if (!pairRootServer) return false
        const epoch = currentEpoch()
        for (const e of [epoch, epoch - 1]) {
          if (token === (await deriveEpochTokens(pairRootServer, e)).auth) return true
        }
        return false
      }
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        void runFakeDaemon(a, identity, verifyAuthToken).then(async session => {
          pairRootServer = await derivePairRoot(session)
        })
        return b
      })

      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      // Let the add() handshake's fake daemon finish deriving pairRootServer.
      await vi.waitFor(() => expect(pairRootServer).not.toBeNull())

      expect(registry.isOnline(fingerprint)).toBe(false)
      const pending = registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      await vi.waitFor(() => expect(registry.isOnline(fingerprint)).toBe(true))
      const res = await pending
      expect(res.status).toBe(200)
      expect(JSON.parse(Buffer.from(res.body).toString("utf8")).ok).toBe(true)
      expect(registry.isOnline(fingerprint)).toBe(false)

      const list = await registry.list()
      expect(list[0]!.lastSeen).not.toBe(list[0]!.createdAt)
    })

    it("surfaces a re-pair hint when every attempt hangs up on the hello", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      let addDone = false
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        if (!addDone) {
          void runFakeDaemon(a, identity, token => token === auth)
        } else {
          // Simulate a peer that hangs up immediately (e.g. reverted to
          // pair/v1): close without ever completing the handshake.
          a.close("simulated hang up")
        }
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 500, dialTimeoutMs: 500 })
      await registry.add(url, "office-mac")
      addDone = true

      await expect(registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })).rejects.toThrow(
        /could not reach host/,
      )
    })
  })

  describe("forwardHttpStream()", () => {
    it("rejects with 'no host matched' when the target is unknown, without dialing", async () => {
      const dial = vi.fn()
      const registry = createHostRegistry({ hostsPath, dial })
      await expect(
        registry.forwardHttpStream("no-such-host", { method: "GET", path: "/health" }),
      ).rejects.toThrow(/no host matched "no-such-host"/)
      expect(dial).not.toHaveBeenCalled()
    })

    it("dials, streams the response, and keeps isOnline true until the body is fully drained", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      stubUpstream(60)

      let pairRootServer: string | null = null
      const verifyAuthToken = async (token: string): Promise<boolean> => {
        if (token === auth) return true
        if (!pairRootServer) return false
        const epoch = currentEpoch()
        for (const e of [epoch, epoch - 1]) {
          if (token === (await deriveEpochTokens(pairRootServer, e)).auth) return true
        }
        return false
      }
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        void runFakeDaemon(a, identity, verifyAuthToken).then(async session => {
          pairRootServer = await derivePairRoot(session)
        })
        return b
      })

      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await vi.waitFor(() => expect(pairRootServer).not.toBeNull())

      expect(registry.isOnline(fingerprint)).toBe(false)
      const res = await registry.forwardHttpStream(fingerprint, { method: "GET", path: "/health" })
      expect(res.status).toBe(200)
      // Headers arrived but the body hasn't been drained yet — unlike
      // forwardHttp, the tunnel client (and isOnline) must stay up for the
      // whole stream lifetime, not just the initial round-trip.
      expect(registry.isOnline(fingerprint)).toBe(true)

      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const body = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8")
      expect(JSON.parse(body).ok).toBe(true)

      await vi.waitFor(() => expect(registry.isOnline(fingerprint)).toBe(false))
    })

    it("surfaces a re-pair hint when every attempt hangs up on the hello", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      let addDone = false
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        if (!addDone) {
          void runFakeDaemon(a, identity, token => token === auth)
        } else {
          a.close("simulated hang up")
        }
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 500, dialTimeoutMs: 500 })
      await registry.add(url, "office-mac")
      addDone = true

      await expect(
        registry.forwardHttpStream(fingerprint, { method: "GET", path: "/health" }),
      ).rejects.toThrow(/could not reach host/)
    })
  })
})
