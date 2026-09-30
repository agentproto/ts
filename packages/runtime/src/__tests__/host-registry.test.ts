/**
 * Unit tests for `createHostRegistry` (DEVICES-PLAN PR-C) — the "client" half
 * of pair/v2, living daemon-side. Drives a fake "daemon" directly (in-process
 * transport, see frame-harness.ts) using `respondToHandshake` +
 * `daemonHandshakeOverSink` — the exact daemon-side primitives
 * `pairing-registry.ts` uses — so these tests exercise the real crypto, not a
 * mock of it.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises"
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
import { createHostRegistry, readHostsSnapshot, type HostRegistry } from "../host-registry.js"
import { connect, type Middleware } from "./frame-harness.js"

const realSetTimeout = globalThis.setTimeout

/** Advance fake timers in steps, yielding real time between steps: a poll's
 *  crypto/dial work is real async, so its follow-up timer is only scheduled a
 *  few real ms after the previous fake tick fired. */
async function advanceInSteps(totalMs: number, stepMs: number): Promise<void> {
  for (let done = 0; done < totalMs; done += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
    await new Promise<void>(r => realSetTimeout(r, 10))
  }
}

function stubUpstream(delayMs = 0, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      return {
        status,
        headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ ok: status < 300, path: String(url) })).buffer,
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

/** `add()`'s handshake verifies the offer's one-time `auth`; every
 *  later `forwardHttp()` reconnects on that pair's EPOCH tokens instead
 *  (see `connectToHost`) — this fake daemon accepts both, exactly like
 *  the "dials the current epoch" test above. */
function makeEpochAwareDial(identity: DaemonIdentity, offerAuth: string) {
  // `pairRootServer` must be captured ONCE, from `add()`'s own
  // handshake session — same as a real daemon deriving it once at
  // `add()` time and reusing it for every later epoch-token
  // verification. Each `forwardHttp()` handshake below establishes its
  // OWN fresh ephemeral session (new sendKey/recvKey), so re-deriving
  // "the pair root" from THAT session on every call — instead of only
  // the first — would silently diverge from `record.pairRoot` (fixed
  // at `add()` time) the moment a second `forwardHttp()` runs.
  let pairRootServer: string | null = null
  const verifyAuthToken = async (token: string): Promise<boolean> => {
    if (token === offerAuth) return true
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
      if (pairRootServer === null) pairRootServer = await derivePairRoot(session)
    }).catch(() => undefined) // a rejected attempt (skewed injected clock) is retried by the client
    return b
  })
  // The server-side `.then()` above (capturing `pairRootServer`) is a
  // fire-and-forget promise, not awaited by `add()` itself — a test
  // that dials `forwardHttp()` right after `add()` resolves can race
  // ahead of it (exactly the race the "dials the current epoch" test
  // above guards against with its own `vi.waitFor`). Callers here must
  // await this before their first `forwardHttp()` call.
  const waitReady = (): Promise<void> => vi.waitFor(() => expect(pairRootServer).not.toBeNull())
  return { dial, waitReady }
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

    it("the 'no host matched' error carries the pairing-direction hint (recap E9)", async () => {
      const registry = createHostRegistry({ hostsPath, dial: vi.fn() })
      await expect(registry.forwardHttp("no-such-host", { method: "GET", path: "/health" })).rejects.toThrow(
        /roles may be inverted; see `agentproto pair --help`/,
      )
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

      // onlineGraceMs: 0 — this case pins the strictly in-flight half of isOnline.
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, onlineGraceMs: 0 })
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

  describe("getSessionsSnapshot() (SANDBOX-VISIBILITY-JOIN #3)", () => {
    it("caches a successful GET /sessions* forwardHttp response, keyed by exact path", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await waitReady()

      expect(registry.getSessionsSnapshot(fingerprint, "/sessions")).toBeUndefined()
      await registry.forwardHttp(fingerprint, { method: "GET", path: "/sessions" })

      const snapshot = registry.getSessionsSnapshot(fingerprint, "/sessions")
      expect(snapshot).toBeDefined()
      expect(snapshot!.stale).toBe(true)
      expect(typeof snapshot!.capturedAt).toBe("string")
      expect(JSON.parse(Buffer.from(snapshot!.body).toString("utf8")).ok).toBe(true)

      // A different path (e.g. one session's own output) isn't the same
      // cache entry.
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions/abc/output")).toBeUndefined()
    })

    it("does not cache a non-GET or a non-/sessions path", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await waitReady()

      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      expect(registry.getSessionsSnapshot(fingerprint, "/health")).toBeUndefined()
    })

    it("returns undefined for an unknown host, without throwing", () => {
      const registry = createHostRegistry({ hostsPath, dial: vi.fn() })
      expect(registry.getSessionsSnapshot("no-such-host", "/sessions")).toBeUndefined()
    })

    it("does not cache a non-2xx /sessions response — a transient 500 must not be served forever as 'last-known-good'", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await waitReady()

      stubUpstream(0, 500)
      const res = await registry.forwardHttp(fingerprint, { method: "GET", path: "/sessions" })
      expect(res.status).toBe(500)
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions")).toBeUndefined()
    })

    it("never matches a lookalike path like /sessions-admin/... as a /sessions* path", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await waitReady()

      await registry.forwardHttp(fingerprint, { method: "GET", path: "/sessions-admin/danger" })
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions-admin/danger")).toBeUndefined()
    })

    it("caps distinct cached paths per host, evicting the oldest first", async () => {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
      await registry.add(url, "office-mac")
      await waitReady()

      // MAX_CACHED_SESSION_PATHS_PER_HOST is 32 — 40 distinct session output
      // paths should evict the earliest ones.
      for (let i = 0; i < 40; i++) {
        await registry.forwardHttp(fingerprint, { method: "GET", path: `/sessions/s${i}/output` })
      }
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions/s0/output")).toBeUndefined()
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions/s39/output")).toBeDefined()
    })
  })

  describe("ended hosts: mark and gc (SANDBOX-VISIBILITY-JOIN #3)", () => {
    const H = 3_600_000
    const D = 24 * H

    /** A join-added host through the real `add()` path, with an injectable clock. */
    async function joinedRegistry(opts: Partial<Parameters<typeof createHostRegistry>[0]> = {}, name = "ci-reviewer #1536") {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      const t0 = Date.now()
      let clock = t0
      const registry = createHostRegistry({
        hostsPath,
        dial,
        now: () => clock,
        handshakeTimeoutMs: 2_000,
        snapshotIntervalMs: 0,
        ...opts,
      })
      await registry.add(url, name, { joined: true })
      await waitReady()
      return { registry, fingerprint, dial, t0, advance: (ms: number) => (clock += ms) }
    }

    function rawHost(over: Record<string, unknown>): Record<string, unknown> {
      return {
        fingerprint: "a".repeat(32),
        name: "ci-reviewer #1",
        daemonX25519Pub: "pk",
        daemonEd25519Pub: "sk",
        rendezvousUrl: "wss://rdv.example/v1",
        pairRoot: "root",
        createdAt: "2026-09-29T00:00:00.000Z",
        lastSeen: "2026-09-29T00:00:00.000Z",
        addedVia: "join",
        ...over,
      }
    }

    it("marks a join-added host ended once unreachable past the TTL (default 2h), stamped when the TTL lapsed", async () => {
      const { registry, t0, advance } = await joinedRegistry()
      advance(H + 60_000)
      expect((await registry.list())[0]?.ended).toBeUndefined()

      advance(2 * H) // now 3h1m past the last contact
      const [rec] = await registry.list()
      expect(rec).toMatchObject({ ended: true, endReason: "ttl" })
      expect(Date.parse(rec!.endedAt!)).toBe(t0 + 2 * H)
      expect(JSON.parse(await readFile(hostsPath, "utf8")).hosts[0]).toMatchObject({ ended: true, endReason: "ttl" })
      expect(registry.isOnline(rec!.fingerprint)).toBe(false)
    })

    it("a host reached within the TTL is not ended", async () => {
      const { registry, fingerprint, advance } = await joinedRegistry({ onlineGraceMs: 1_000 })
      advance(H + 30 * 60_000)
      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      advance(H + 30 * 60_000) // 3h since join, 1.5h since last contact
      expect((await registry.list())[0]?.ended).toBeUndefined()
    })

    it("endedTtlMs is configurable and 0 disables ending", async () => {
      const short = await joinedRegistry({ endedTtlMs: 1_000 })
      short.advance(2_000)
      expect((await short.registry.list())[0]?.ended).toBe(true)

      const off = await joinedRegistry({ endedTtlMs: 0, hostsPath: join(tmp, "off.json") }, "other")
      off.advance(365 * D)
      expect((await off.registry.list())[0]?.ended).toBeUndefined()
    })

    it("deletes an ended join host after the retention (default 7 days) and persists the deletion", async () => {
      const { registry, advance } = await joinedRegistry()
      advance(3 * H)
      expect(await registry.list()).toHaveLength(1) // ended, retained
      advance(6 * D)
      expect(await registry.list()).toHaveLength(1) // 6d3h since join = 6d1h since ended
      advance(2 * D)
      expect(await registry.list()).toHaveLength(0)
      expect(JSON.parse(await readFile(hostsPath, "utf8")).hosts).toHaveLength(0)
    })

    it("endedRetentionMs is configurable and 0 keeps ended hosts forever", async () => {
      const keep = await joinedRegistry({ endedRetentionMs: 0 })
      keep.advance(365 * D)
      expect((await keep.registry.list())[0]?.ended).toBe(true)

      const quick = await joinedRegistry({ endedTtlMs: 1_000, endedRetentionMs: 5_000, hostsPath: join(tmp, "quick.json") }, "quick")
      quick.advance(2_000)
      expect(await quick.registry.list()).toHaveLength(1)
      quick.advance(5_000)
      expect(await quick.registry.list()).toHaveLength(0)
    })

    it("never deletes (or ends) a manually added host — it only shows stale", async () => {
      const hosts = [
        rawHost({ fingerprint: "b".repeat(32), name: "office-mac", addedVia: "manual" }),
        rawHost({ fingerprint: "c".repeat(32), name: "old-record-no-marker", addedVia: undefined, lastSeen: "2026-09-29T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z" }),
        rawHost({ fingerprint: "d".repeat(32), name: "ci-old", ended: true, endedAt: "2026-09-01T00:00:00.000Z", endReason: "ttl" }),
      ]
      await writeFile(hostsPath, JSON.stringify({ v: 1, hosts }))
      const fresh = createHostRegistry({ hostsPath, dial: vi.fn(), snapshotIntervalMs: 0, now: () => Date.parse("2027-01-01T00:00:00.000Z") })
      const listed = await fresh.list()
      expect(listed.map(h => h.name).sort()).toEqual(["office-mac", "old-record-no-marker"])
      for (const h of listed) {
        expect(h.ended).toBeUndefined()
        expect(h.stale).toBe(true)
      }
      const file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts.map((h: { name: string }) => h.name).sort()).toEqual(["office-mac", "old-record-no-marker"])
      expect(file.hosts.some((h: { stale?: boolean }) => h.stale !== undefined)).toBe(false) // computed, never persisted
    })

    it("a manual host reached recently is not stale", async () => {
      await writeFile(hostsPath, JSON.stringify({ v: 1, hosts: [rawHost({ name: "office-mac", addedVia: "manual" })] }))
      const registry = createHostRegistry({
        hostsPath,
        dial: vi.fn(),
        snapshotIntervalMs: 0,
        now: () => Date.parse("2026-09-29T01:00:00.000Z"),
      })
      expect((await registry.list())[0]?.stale).toBeUndefined()
    })

    it("sweep() applies the lifecycle to a freshly loaded file without anyone calling list()", async () => {
      await writeFile(
        hostsPath,
        JSON.stringify({
          v: 1,
          hosts: [
            rawHost({ fingerprint: "a".repeat(32), name: "stale-ci", lastSeen: "2026-09-29T00:00:00.000Z" }),
            rawHost({ fingerprint: "b".repeat(32), name: "ancient-ci", lastSeen: "2026-08-01T00:00:00.000Z" }),
          ],
        }),
      )
      const registry = createHostRegistry({
        hostsPath,
        dial: vi.fn(),
        snapshotIntervalMs: 0,
        now: () => Date.parse("2026-09-29T05:00:00.000Z"),
      })
      await registry.sweep()
      const file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts).toHaveLength(1)
      expect(file.hosts[0]).toMatchObject({ name: "stale-ci", ended: true, endReason: "ttl" })
    })

    it("markEnded ends a join host immediately (goodbye), is idempotent, and refuses manual or unknown hosts", async () => {
      const { registry, fingerprint, advance } = await joinedRegistry()
      expect(registry.isOnline(fingerprint)).toBe(true)
      advance(1_000)
      expect(await registry.markEnded(fingerprint)).toBe(true)
      const [rec] = await registry.list()
      expect(rec).toMatchObject({ ended: true, endReason: "goodbye" })
      expect(registry.isOnline(fingerprint)).toBe(false)
      const endedAt = rec!.endedAt
      advance(1_000)
      expect(await registry.markEnded(fingerprint)).toBe(true)
      expect((await registry.list())[0]?.endedAt).toBe(endedAt)
      expect(JSON.parse(await readFile(hostsPath, "utf8")).hosts[0]).toMatchObject({ ended: true, endReason: "goodbye" })

      expect(await registry.markEnded("nope")).toBe(false)

      const identity = await generateIdentity()
      const offer = await makeOffer(identity, { scope: "host" })
      const manual = createHostRegistry({
        hostsPath: join(tmp, "manual-hosts.json"),
        snapshotIntervalMs: 0,
        dial: vi.fn(async () => {
          const { a, b } = connect()
          void runFakeDaemon(a, identity, token => token === offer.auth).catch(() => undefined) // later epoch dials are refused; not under test
          return b
        }),
      })
      await manual.add(offer.url, "office-mac")
      expect(await manual.markEnded("office-mac")).toBe(false)
      expect((await manual.list())[0]?.ended).toBeUndefined()
    })

    it("re-adding an ended host's fingerprint (a rejoin) makes it live again", async () => {
      const identity = await generateIdentity()
      let offer = await makeOffer(identity, { scope: "host" })
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        const o = offer
        void runFakeDaemon(a, identity, token => token === o.auth).catch(() => undefined) // later epoch dials are refused; not under test
        return b
      })
      const registry = createHostRegistry({ hostsPath, dial, snapshotIntervalMs: 0 })
      await registry.add(offer.url, "ci-reviewer #9", { joined: true })
      await registry.markEnded(offer.fingerprint)
      expect((await registry.list())[0]?.ended).toBe(true)

      offer = await makeOffer(identity, { scope: "host" })
      await registry.add(offer.url, "ci-reviewer #9", { joined: true })
      expect((await registry.list())[0]?.ended).toBeUndefined()
    })

    it("stops polling a host once it is ended, and never resumes polling an ended host at boot", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const identity = await generateIdentity()
        const offer = await makeOffer(identity, { scope: "host" })
        const { dial, waitReady } = makeEpochAwareDial(identity, offer.auth)
        const registry = createHostRegistry({
          hostsPath,
          dial,
          handshakeTimeoutMs: 2_000,
          snapshotIntervalMs: 15_000,
          snapshotActiveIntervalMs: 5_000,
        })
        await registry.add(offer.url, "ci-reviewer #10", { joined: true })
        await waitReady()
        await registry.markEnded(offer.fingerprint)
        const dials = dial.mock.calls.length
        await advanceInSteps(60_000, 5_000)
        expect(dial.mock.calls.length).toBe(dials)

        const reloaded = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, snapshotIntervalMs: 15_000 })
        await reloaded.start()
        await advanceInSteps(60_000, 5_000)
        expect(dial.mock.calls.length).toBe(dials)
      } finally {
        vi.useRealTimers()
      }
    })

    it("addedVia: 'manual' is sticky — a manually-added host re-joined later via a token is never ended", async () => {
      const identity = await generateIdentity()
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        const offer = lastOffer
        void runFakeDaemon(a, identity, token => token === offer!.auth).catch(() => undefined) // later epoch dials are refused; not under test
        return b
      })
      let lastOffer: Awaited<ReturnType<typeof makeOffer>> | undefined
      let clock = Date.now()
      const registry = createHostRegistry({ hostsPath, dial, now: () => clock, snapshotIntervalMs: 0, endedTtlMs: 1_000 })

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "office-mac") // the human ceremony first

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "office-mac (rejoined)", { joined: true }) // same fingerprint, now via token

      clock += 2_000
      const [rec] = await registry.list()
      expect(rec?.ended).toBeUndefined()
      expect(await registry.markEnded(lastOffer.fingerprint)).toBe(false)
    })

    it("addedVia: a join-added host later manually re-added flips to 'manual' — an explicit human action takes ownership", async () => {
      const identity = await generateIdentity()
      const dial = vi.fn(async () => {
        const { a, b } = connect()
        const offer = lastOffer
        void runFakeDaemon(a, identity, token => token === offer!.auth).catch(() => undefined) // later epoch dials are refused; not under test
        return b
      })
      let lastOffer: Awaited<ReturnType<typeof makeOffer>> | undefined
      let clock = Date.now()
      const registry = createHostRegistry({ hostsPath, dial, now: () => clock, snapshotIntervalMs: 0, endedTtlMs: 1_000 })

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "ci-reviewer #1536", { joined: true })

      lastOffer = await makeOffer(identity, { scope: "host" })
      await registry.add(lastOffer.url, "renamed-by-human") // no meta — a manual re-add

      clock += 2_000
      expect((await registry.list())[0]?.ended).toBeUndefined()
    })
  })

  describe("online, lastSeen and proactive snapshots (join visibility round 2)", () => {
    /** Upstream whose /sessions and /sessions/:id/output answers can be
     *  swapped between polls, like a runner mid-review. */
    function stubSessions(state: { sessions: Array<Record<string, unknown>>; lines: Record<string, string[]> }): void {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          const u = new URL(String(url))
          const out = u.pathname.match(/^\/upstream\/sessions\/([^/]+)\/output$/)
          const body = out
            ? { sessionId: out[1], status: "running", lines: state.lines[out[1]!] ?? [] }
: { sessions: state.sessions }
          return {
            status: 200,
            headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
            arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
          }
        }),
      )
    }

    async function joinedHost(opts: Parameters<typeof createHostRegistry>[0] extends infer D ? Partial<D> : never = {}) {
      const identity = await generateIdentity()
      const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
      const { dial, waitReady } = makeEpochAwareDial(identity, auth)
      let clock = Date.now()
      const registry = createHostRegistry({
        hostsPath,
        dial,
        now: () => clock,
        handshakeTimeoutMs: 2_000,
        snapshotIntervalMs: 0,
        ...opts,
      })
      await registry.add(url, "ci-reviewer #1553", { joined: true })
      await waitReady()
      return { registry, fingerprint, dial, advance: (ms: number) => (clock += ms) }
    }

    it("online: true right after a join and for the grace window after a successful forward, then decays", async () => {
      const { registry, fingerprint, advance } = await joinedHost({ onlineGraceMs: 10_000 })
      expect(registry.isOnline(fingerprint)).toBe(true) // the join handshake itself proved it reachable

      advance(11_000)
      expect(registry.isOnline(fingerprint)).toBe(false)

      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      expect(registry.isOnline(fingerprint)).toBe(true)
      advance(9_000)
      expect(registry.isOnline(fingerprint)).toBe(true)
      advance(2_000)
      expect(registry.isOnline(fingerprint)).toBe(false)
    })

    it("a host that never connected (unknown fingerprint) is not online", async () => {
      const registry = createHostRegistry({ hostsPath, dial: vi.fn() })
      expect(registry.isOnline("nope")).toBe(false)
    })

    it("lastSeen moves on every successful forward (in memory) and is persisted at most once per throttle window", async () => {
      const { registry, fingerprint, advance } = await joinedHost({ lastSeenPersistIntervalMs: 60_000 })
      const created = (await registry.list())[0]!
      expect(created.lastSeen).toBe(created.createdAt)

      advance(5_000)
      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      const afterFirst = (await registry.list())[0]!
      expect(Date.parse(afterFirst.lastSeen)).toBe(Date.parse(created.createdAt) + 5_000)
      // Throttled: within the window the disk copy still has the join-time value.
      let file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts[0].lastSeen).toBe(created.lastSeen)

      advance(61_000)
      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      const afterSecond = (await registry.list())[0]!
      expect(Date.parse(afterSecond.lastSeen)).toBe(Date.parse(afterFirst.lastSeen) + 61_000)
      file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts[0].lastSeen).toBe(afterSecond.lastSeen)
    })

    it("snapshotNow captures the session list + output tails, served stale once the host is unreachable", async () => {
      const state = {
        sessions: [
          { id: "sess_a", status: "running", lastActivityAt: "2026-09-28T20:00:00Z" },
          { id: "sess_b", status: "exited", lastActivityAt: "2026-09-28T19:00:00Z" },
        ],
        lines: { sess_a: ["turn 1", "VERDICT: approve"], sess_b: ["old"] },
      }
      stubSessions(state)
      const { registry, fingerprint, dial } = await joinedHost({ snapshotIntervalMs: 60_000 })

      expect(await registry.snapshotNow(fingerprint)).toBe(true)

      // The host is gone: every further dial fails.
      dial.mockImplementation(async () => {
        throw new Error("handshake timed out")
      })
      await expect(registry.forwardHttp(fingerprint, { method: "GET", path: "/sessions" })).rejects.toThrow(
        /could not reach host/,
      )

      const list = registry.getSessionsSnapshot(fingerprint, "/sessions")
      expect(list?.stale).toBe(true)
      expect(typeof list?.capturedAt).toBe("string")
      expect(JSON.parse(Buffer.from(list!.body).toString("utf8")).sessions.map((s: { id: string }) => s.id)).toEqual([
        "sess_a",
        "sess_b",
      ])

      // Output, both with and without the query the callers actually send
      // (device_sessions with no lastN sends a bare trailing "?").
      for (const path of ["/sessions/sess_a/output", "/sessions/sess_a/output?", "/sessions/sess_a/output?lastN=1"]) {
        const out = registry.getSessionsSnapshot(fingerprint, path)
        expect(out?.stale, path).toBe(true)
        const body = JSON.parse(Buffer.from(out!.body).toString("utf8"))
        expect(body.lines.at(-1)).toBe("VERDICT: approve")
        if (path.endsWith("lastN=1")) expect(body.lines).toEqual(["VERDICT: approve"])
      }
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions/sess_zzz/output")).toBeUndefined()
    })

    it("a later capture with an EMPTY session list merges instead of replacing: the prior session, status 'gone', and its output survive", async () => {
      const state = {
        sessions: [{ id: "sess_a", status: "running", lastActivityAt: "2026-09-28T20:00:00Z" }],
        lines: { sess_a: ["turn 1", "VERDICT: approve"] },
      }
      stubSessions(state)
      const { registry, fingerprint } = await joinedHost({ snapshotIntervalMs: 60_000 })
      expect(await registry.snapshotNow(fingerprint)).toBe(true)

      state.sessions = []
      state.lines["sess_a"] = []
      expect(await registry.snapshotNow(fingerprint)).toBe(true)

      const list = registry.getSessionsSnapshot(fingerprint, "/sessions")
      expect(list?.stale).toBe(true)
      const rows = JSON.parse(Buffer.from(list!.body).toString("utf8")).sessions
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: "sess_a", status: "gone" })
      expect(rows[0].lastActivityAt).toBe("2026-09-28T20:00:00Z")

      // The kept output is servable for the merged "gone" session —
      // device_sessions with a sessionId returns it, not a 404/empty.
      for (const path of [
        "/sessions/sess_a/output",
        "/sessions/sess_a/output?lastN=10",
        "/sessions/sess_a/output?clean=1",
      ]) {
        const out = registry.getSessionsSnapshot(fingerprint, path)
        expect(out?.stale, path).toBe(true)
        const body = JSON.parse(Buffer.from(out!.body).toString("utf8"))
        expect(body.lines).toContain("VERDICT: approve")
        expect(body.lines).toEqual(["turn 1", "VERDICT: approve"])
        if (path.endsWith("lastN=10")) expect(body.lines.length).toBeLessThanOrEqual(10)
      }
    })

    it("an exited session present in the new list is captured with its output tail", async () => {
      const state = {
        sessions: [
          { id: "sess_live", status: "exited", lastActivityAt: "2026-09-28T21:00:00Z" },
          { id: "sess_old", status: "exited", lastActivityAt: "2026-09-27T00:00:00Z" },
        ],
        lines: { sess_live: ["working…", "VERDICT: approve"], sess_old: ["stale"] },
      }
      stubSessions(state)
      const { registry, fingerprint } = await joinedHost({ snapshotIntervalMs: 60_000 })
      expect(await registry.snapshotNow(fingerprint)).toBe(true)

      const out = registry.getSessionsSnapshot(fingerprint, "/sessions/sess_live/output?lastN=2")
      expect(out?.stale).toBe(true)
      const body = JSON.parse(Buffer.from(out!.body).toString("utf8"))
      expect(body.sessionId).toBe("sess_live")
      expect(body.lines).toEqual(["working…", "VERDICT: approve"])
      // An exited row is in the stored list (not only running ones).
      const rows = JSON.parse(
        Buffer.from(registry.getSessionsSnapshot(fingerprint, "/sessions")!.body).toString("utf8"),
      ).sessions
      expect(rows.find((r: { id: string }) => r.id === "sess_live")?.status).toBe("exited")
    })

    it("the merged list stays capped: at most SNAPSHOT_MAX_SESSIONS rows survive", async () => {
      const sessions = Array.from({ length: 25 }, (_, i) => ({
        id: `s${String(i).padStart(2, "0")}`,
        status: "exited",
        lastActivityAt: new Date(Date.parse("2026-09-28T00:00:00Z") + i * 60_000).toISOString(),
      }))
      const state = { sessions, lines: Object.fromEntries(sessions.map(s => [s.id, ["tail"]])) }
      stubSessions(state)
      const { registry, fingerprint } = await joinedHost({ snapshotIntervalMs: 60_000 })
      expect(await registry.snapshotNow(fingerprint)).toBe(true)
      // Now the box is empty except it reports one brand-new session.
      state.sessions = [{ id: "fresh", status: "running", lastActivityAt: "2026-09-29T00:00:00Z" }]
      expect(await registry.snapshotNow(fingerprint)).toBe(true)

      const rows = JSON.parse(
        Buffer.from(registry.getSessionsSnapshot(fingerprint, "/sessions")!.body).toString("utf8"),
      ).sessions
      expect(rows).toHaveLength(20)
      expect(rows[0]).toMatchObject({ id: "fresh" })
      expect(rows.some((r: { id: string }) => r.id === "s00")).toBe(false) // oldest dropped
      expect(rows.some((r: { id: string }) => r.id === "s05")).toBe(false) // and the next five
      expect(rows.some((r: { id: string }) => r.id === "s06")).toBe(true) // newest 19 gone-rows kept
    })

    it("the background poll starts on join, takes a snapshot on its own, and backs off (never gives up) once unreachable", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const state = {
          sessions: [{ id: "sess_a", status: "running", lastActivityAt: "2026-09-28T20:00:00Z" }],
          lines: { sess_a: ["working…"] },
        }
        stubSessions(state)
        const { registry, fingerprint, dial } = await joinedHost({
          snapshotIntervalMs: 15_000,
          snapshotActiveIntervalMs: 5_000,
          snapshotMaxFailures: 2,
          probeBackoffMaxMs: 60_000,
        })
        // Nobody asked for anything — the first poll fires on its own, one
        // active-interval after the join.
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(registry.getSessionsSnapshot(fingerprint, "/sessions")).toBeDefined())

        // A running session speeds the cadence up: the next poll is 5s out, and
        // picks up new output.
        state.lines["sess_a"] = ["working…", "VERDICT: approve"]
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => {
          const out = registry.getSessionsSnapshot(fingerprint, "/sessions/sess_a/output")
          expect(JSON.parse(Buffer.from(out!.body).toString("utf8")).lines).toContain("VERDICT: approve")
        })

        // The runner exits: polls fail; after 2 the loop backs off (doubling to
        // the cap) but keeps probing, and keeps the last capture.
        const dialsBefore = dial.mock.calls.length
        dial.mockImplementation(async () => {
          throw new Error("gone")
        })
        await advanceInSteps(120_000, 5_000)
        const failedPolls = dial.mock.calls.length - dialsBefore
        expect(failedPolls).toBeGreaterThanOrEqual(4) // >= 2 polls x (current + previous epoch attempt)
        expect(failedPolls).toBeLessThanOrEqual(10)
        expect((await registry.list())[0]?.lastError).toMatch(/gone/)

        const settled = dial.mock.calls.length
        await advanceInSteps(300_000, 5_000)
        const laterPolls = dial.mock.calls.length - settled
        expect(laterPolls).toBeGreaterThanOrEqual(2) // still probing
        expect(laterPolls).toBeLessThanOrEqual(12) // but at the capped 60s cadence, not every 5s
        expect(registry.getSessionsSnapshot(fingerprint, "/sessions/sess_a/output")?.stale).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a failed contact leaves online false and records lastProbeAt/lastError; a later success clears the error", async () => {
      const { registry, fingerprint, dial, advance } = await joinedHost({ onlineGraceMs: 10_000 })
      const working = dial.getMockImplementation()!

      advance(11_000)
      dial.mockImplementation(async () => {
        throw new Error("handshake timed out")
      })
      await expect(registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })).rejects.toThrow(/could not reach host/)
      expect(registry.isOnline(fingerprint)).toBe(false)
      const failed = (await registry.list())[0]!
      expect(failed.lastError).toBe("handshake timed out")
      expect(Date.parse(failed.lastProbeAt!)).toBe(Date.parse(failed.createdAt) + 11_000)
      expect(failed.lastSeen).toBe(failed.createdAt) // a failed attempt is not "seen"
      expect(JSON.parse(await readFile(hostsPath, "utf8")).hosts[0].lastError).toBe("handshake timed out")

      // Same error again: memory updates, disk is left alone.
      const mtime = (await stat(hostsPath)).mtimeMs
      await new Promise(r => setTimeout(r, 25))
      advance(1_000)
      await expect(registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })).rejects.toThrow()
      expect((await stat(hostsPath)).mtimeMs).toBe(mtime)
      expect(Date.parse((await registry.list())[0]!.lastProbeAt!)).toBe(Date.parse(failed.createdAt) + 12_000)

      dial.mockImplementation(working)
      await registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })
      expect(registry.isOnline(fingerprint)).toBe(true)
      const recovered = (await registry.list())[0]!
      expect(recovered.lastError).toBeUndefined()
      expect(JSON.parse(await readFile(hostsPath, "utf8")).hosts[0].lastError).toBeUndefined()
    })

    it("after 5 consecutive failed dials it logs the re-pair remediation hint ONCE — a later success resets the streak", async () => {
      const hintLines: string[] = []
      const { registry, fingerprint, dial, advance } = await joinedHost({
        log: (line: string) => hintLines.push(line),
        onlineGraceMs: 10_000,
      })
      const working = dial.getMockImplementation()!
      advance(11_000)
      dial.mockImplementation(async () => {
        throw new Error("handshake timed out")
      })
      const hints = (): number => hintLines.filter(l => /devices add/.test(l) && /pair offer --host/.test(l)).length
      // 5 consecutive failures: exactly one log line at the threshold.
      for (let i = 0; i < 5; i++) {
        await expect(
          registry.forwardHttp(fingerprint, { method: "GET", path: "/health" }),
        ).rejects.toThrow(/could not reach host/)
      }
      expect(hints()).toBe(1)
      // The streak never re-logs on further failures of the same arc.
      advance(1_000)
      await expect(
        registry.forwardHttp(fingerprint, { method: "GET", path: "/health" }),
      ).rejects.toThrow()
      expect(hints()).toBe(1)

      // A successful dial resets the counter: 5 fresh failures log again, not earlier.
      dial.mockImplementation(working)
      await new Promise(r => setTimeout(r, 25))
      advance(1_000)
      await expect(registry.forwardHttp(fingerprint, { method: "GET", path: "/health" })).resolves.toBeDefined()
      expect(registry.isOnline(fingerprint)).toBe(true)
      dial.mockImplementation(async () => {
        throw new Error("handshake timed out")
      })
      // ...and once more after the reset: the fifth failure after the streak
      // reset logs again (the first four do not).
      for (let i = 0; i < 5; i++) {
        advance(1_000)
        await expect(
          registry.forwardHttp(fingerprint, { method: "GET", path: "/health" }),
        ).rejects.toThrow()
      }
      expect(hints()).toBe(2)
    })

    it("start() resumes polling join-added hosts loaded from disk (a daemon restart), and skips manual hosts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        stubSessions({ sessions: [{ id: "sess_a", status: "exited" }], lines: { sess_a: ["done"] } })
        const identity = await generateIdentity()
        const joined = await makeOffer(identity, { scope: "host" })
        const { dial, waitReady } = makeEpochAwareDial(identity, joined.auth)
        const first = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, snapshotIntervalMs: 0 })
        await first.add(joined.url, "ci-reviewer #1566", { joined: true })
        await waitReady()

        // Same file, a "new daemon process": nothing polls until start().
        const second = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, snapshotIntervalMs: 15_000 })
        const dialsBefore = dial.mock.calls.length
        await vi.advanceTimersByTimeAsync(30_000)
        expect(dial.mock.calls.length).toBe(dialsBefore)

        await second.start()
        await vi.advanceTimersByTimeAsync(6_000)
        await vi.waitFor(() => expect(second.getSessionsSnapshot(joined.fingerprint, "/sessions")).toBeDefined())
        const row = (await second.list())[0]!
        expect(row.lastProbeAt).toBeDefined()
        expect(second.isOnline(joined.fingerprint)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("caps concurrent background probes at probeConcurrency", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const hosts = Array.from({ length: 5 }, (_, i) => ({
          fingerprint: String(i).repeat(32),
          name: `ci-${i}`,
          daemonX25519Pub: "pk",
          daemonEd25519Pub: "sk",
          rendezvousUrl: "wss://rdv.example/v1",
          pairRoot: "root",
          createdAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          addedVia: "join",
        }))
        await writeFile(hostsPath, JSON.stringify({ v: 1, hosts }))
        let inFlight = 0
        let peak = 0
        const dial = vi.fn(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise(r => setTimeout(r, 1_000))
          inFlight--
          throw new Error("down")
        })
        const registry = createHostRegistry({
          hostsPath,
          dial,
          snapshotIntervalMs: 60_000,
          snapshotActiveIntervalMs: 1_000,
          probeConcurrency: 2,
        })
        await registry.start()
        await advanceInSteps(20_000, 500)
        expect(dial.mock.calls.length).toBeGreaterThanOrEqual(5)
        expect(peak).toBeLessThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a manually-added host is not polled in the background", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        stubSessions({ sessions: [], lines: {} })
        const identity = await generateIdentity()
        const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
        const { dial, waitReady } = makeEpochAwareDial(identity, auth)
        const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, snapshotIntervalMs: 1_000 })
        await registry.add(url, "office-mac") // no meta.joined
        await waitReady()
        const dials = dial.mock.calls.length
        await vi.advanceTimersByTimeAsync(30_000)
        expect(dial.mock.calls.length).toBe(dials)
        expect(registry.getSessionsSnapshot(fingerprint, "/sessions")).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it("revoking a host drops its snapshot and stops its poll", async () => {
      stubSessions({ sessions: [{ id: "sess_a" }], lines: { sess_a: ["x"] } })
      const { registry, fingerprint } = await joinedHost({ snapshotIntervalMs: 60_000 })
      expect(await registry.snapshotNow(fingerprint)).toBe(true)
      expect(await registry.revoke(fingerprint)).toBe(true)
      expect(registry.getSessionsSnapshot(fingerprint, "/sessions")).toBeUndefined()
      expect(await registry.snapshotNow(fingerprint)).toBe(false)
    })

    it("snapshotNow is a no-op false when snapshots are disabled or the host is unknown", async () => {
      const { registry, fingerprint } = await joinedHost({ snapshotIntervalMs: 0 })
      expect(await registry.snapshotNow(fingerprint)).toBe(false)
      const other = createHostRegistry({ hostsPath, dial: vi.fn(), snapshotIntervalMs: 1_000 })
      expect(await other.snapshotNow("no-such-host")).toBe(false)
    })
  })

  describe("pruning old unlabeled join hosts (pre-#1542 records)", () => {
    function legacyRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
      const fp = "f675351f" + "0".repeat(24)
      return {
        fingerprint: fp,
        name: fp,
        daemonX25519Pub: "pk",
        daemonEd25519Pub: "sk",
        rendezvousUrl: "wss://rdv.example/v1",
        pairRoot: "root",
        createdAt: "2026-09-28T14:23:07.000Z",
        lastSeen: "2026-09-28T14:23:07.000Z",
        ...over,
      }
    }

    it("prunes a legacy fingerprint-named, never-reached host past the TTL — and only that one", async () => {
      const legacyJoined = legacyRecord()
      const manualNamed = legacyRecord({ fingerprint: "a".repeat(32), name: "office-mac" })
      const manualUsed = legacyRecord({ fingerprint: "b".repeat(32), name: "b".repeat(32), lastSeen: "2026-09-29T10:00:00.000Z" })
      const explicitManual = legacyRecord({ fingerprint: "c".repeat(32), name: "c".repeat(32), addedVia: "manual" })
      await writeFile(hostsPath, JSON.stringify({ v: 1, hosts: [legacyJoined, manualNamed, manualUsed, explicitManual] }))

      const registry = createHostRegistry({
        hostsPath,
        dial: vi.fn(),
        now: () => Date.parse("2026-10-06T00:00:00.000Z"), // 7d+ after every lastSeen above except manualUsed's
      })
      const names = (await registry.list()).map(h => h.name).sort()
      expect(names).toEqual(["office-mac", "b".repeat(32), "c".repeat(32)].sort())
      const file = JSON.parse(await readFile(hostsPath, "utf8"))
      expect(file.hosts).toHaveLength(3)
    })

    it("never touches pairings.json (clients / `pair offer` pairings) when pruning", async () => {
      const pairingsPath = join(tmp, "pairings.json")
      const pairings = JSON.stringify({ v: 2, pairings: [{ fingerprint: "p".repeat(32), name: "jeremy@laptop" }] })
      await writeFile(pairingsPath, pairings)
      await writeFile(hostsPath, JSON.stringify({ v: 1, hosts: [legacyRecord()] }))
      const registry = createHostRegistry({ hostsPath, dial: vi.fn(), now: () => Date.parse("2026-10-20T00:00:00.000Z") })
      expect(await registry.list()).toHaveLength(0)
      expect(await readFile(pairingsPath, "utf8")).toBe(pairings)
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

      const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000, onlineGraceMs: 0 })
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

/** `readHostsSnapshot` — the read-only `readPairingsSnapshot` twin
 *  (`agentproto doctor`'s devices check; BOOTSTRAP P3 item 4). */
describe("readHostsSnapshot", () => {
  it("returns the persisted records read-only; [] for a missing or malformed file", async () => {
    const tpl = await mkdtemp(join(tmpdir(), "agentproto-hosts-snap-"))
    try {
      const path = join(tpl, "hosts.json")
      expect(await readHostsSnapshot(path)).toEqual([])
      expect(await readHostsSnapshot(join(tpl, "missing.json"))).toEqual([])

      const rec = {
        fingerprint: "a".repeat(32),
        name: "win-studio",
        daemonX25519Pub: "b64-1",
        daemonEd25519Pub: "b64-2",
        rendezvousUrl: "ws://rdv/v1",
        pairRoot: "b64-3",
        createdAt: "2026-09-30T00:00:00.000Z",
        lastSeen: "2026-09-30T00:00:00.000Z",
        lastProbeAt: "2026-09-30T01:00:00.000Z",
        lastError: "handshake timed out",
      }
      await writeFile(path, JSON.stringify({ v: 1, hosts: [rec] }), "utf8")
      const snapshots = await readHostsSnapshot(path)
      expect(snapshots).toEqual([rec])
      // Read-only: untouched bytes afterwards.
      expect(JSON.parse(await readFile(path, "utf8")).hosts).toHaveLength(1)

      await writeFile(path, "{ not json", "utf8")
      expect(await readHostsSnapshot(path)).toEqual([])
    } finally {
      await rm(tpl, { recursive: true, force: true }).catch(() => {})
    }
  })
})
describe("createHostRegistry — post-handshake diagnostics (BOOTSTRAP P4 item 2)", () => {
  let tmp: string
  let hostsPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-hosts-p4-"))
    hostsPath = join(tmp, "hosts.json")
    stubUpstream()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  /** A fake daemon that completes the pair/v2 handshake — the Noise exchange
   *  the flap evidence shows SUCCEEDING — then closes the channel WITHOUT
   *  ever serving (so the tunnel `hello` frame never arrives). This is the
   *  exact shape a revoked-pairing tombstone close or a persist failure on
   *  the host produces. */
  function makeHandshakeThenCloseDial(identity: DaemonIdentity, offerAuth: string, closeReason: string) {
    let pairRootServer: string | null = null
    const verifyAuthToken = async (token: string): Promise<boolean> => {
      if (token === offerAuth) return true
      if (!pairRootServer) return false
      const epoch = currentEpoch()
      for (const e of [epoch, epoch - 1]) {
        if (token === (await deriveEpochTokens(pairRootServer, e)).auth) return true
      }
      return false
    }
    const dial = vi.fn(async () => {
      const { a, b } = connect()
      void (async () => {
        let session: PairingSession | null = null
        const wrapped: E2eFrameSink = await daemonHandshakeOverSink(
          a,
          async helloBytes => {
            const hello = decodePairingHello(helloBytes)
            const result = await respondToHandshake(hello, { identity, verifyAuthToken })
            session = result.session
            return { reply: encodePairingMessage(result.reply), keys: result.session }
          },
          { timeoutMs: 2_000 },
        )
        if (pairRootServer === null && session) pairRootServer = await derivePairRoot(session)
        // Handshake done — die at the NEXT step, with a reason.
        wrapped.close(closeReason)
      })().catch(() => undefined)
      return b
    })
    const waitReady = (): Promise<void> => vi.waitFor(() => expect(pairRootServer).not.toBeNull())
    return { dial, waitReady }
  }

  it("rejects PROMPTLY with the remote close reason when the host closes after the handshake (never a 10s hello timeout)", async () => {
    const identity = await generateIdentity()
    const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
    const { dial, waitReady } = makeHandshakeThenCloseDial(identity, auth, "persist failed")
    const registry = createHostRegistry({ hostsPath, dial, handshakeTimeoutMs: 2_000 })
    await registry.add(url, "office-mac")
    await waitReady()

    const started = Date.now()
    // The old behaviour raced `client.ready()`'s full 10s hello timeout and
    // reported a generic "did not send hello"; the fix surfaces the close.
    await expect(
      registry.forwardHttp(fingerprint, { method: "GET", path: "/health" }),
    ).rejects.toThrow(/closed the channel after handshake: persist failed/)
    expect(Date.now() - started).toBeLessThan(9_000)
  })

  it("logs each failed attempt with the host's name + fingerprint and which step it died at", async () => {
    const identity = await generateIdentity()
    const { url, auth, fingerprint } = await makeOffer(identity, { scope: "host" })
    const { dial, waitReady } = makeHandshakeThenCloseDial(identity, auth, "revoked")
    const logs: string[] = []
    const registry = createHostRegistry({
      hostsPath,
      dial,
      handshakeTimeoutMs: 2_000,
      log: line => logs.push(line),
    })
    await registry.add(url, "office-mac")
    await waitReady()

    await expect(
      registry.forwardHttp(fingerprint, { method: "GET", path: "/health" }),
    ).rejects.toThrow(/closed the channel after handshake: revoked/)

    const attemptLines = logs.filter(l => l.includes("office-mac") && l.includes(fingerprint) && l.includes("attempt 1/2"))
    expect(attemptLines).toHaveLength(1)
    expect(attemptLines[0]).toMatch(/closed the channel after handshake: revoked/)
  })
})
