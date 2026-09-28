/**
 * Integration test wiring `createJoinTokenRegistry` to a REAL
 * `createHostRegistry` (not a faked `addHost`) — reproducing the incident on
 * PR #1536 (run 36438398607): a CI reviewer box joined the same home daemon
 * twice (same box identity/fingerprint, two separate `AGENTPROTO_JOIN`
 * dials), `join_token_list` showed `useCount: 2`, but `device_list` showed
 * only one host whose `lastSeen`/`createdAt` were BOTH stuck at the first
 * join.
 *
 * `join-token-registry.test.ts` and `host-registry.test.ts` each fake the
 * other half (`addHost`/`dial` respectively), so neither exercises the real
 * round trip: a join-token accept loop invoking a real `HostRegistry.add()`,
 * which itself dials BACK into the box's own self-minted offer — a SECOND
 * full pair/v2 handshake, on a different channel, that nothing in the accept
 * loop retries if it fails.
 *
 * What this actually found: `HostRegistry.add()`'s upsert-by-fingerprint
 * logic itself is fine (two successful `add()` calls for the same
 * fingerprint always refresh `lastSeen`/`name` — see
 * `host-registry.test.ts`'s "upserts by fingerprint" case). The real defect
 * is that `handleJoined()`'s `deps.addHost` call can fail (the box's
 * self-offer has a short TTL for a round trip that goes through a real
 * broker and is queued behind the accept loop's own processing) and that
 * failure was previously swallowed into a log line only — `useCount` still
 * bumps (it's recorded unconditionally, before the dial-back even starts),
 * so nothing in `join_token_list` or `device_list` ever showed it happened.
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  daemonHandshakeOverSink,
  clientHandshakeOverSink,
  createTunnelServer,
  type FrameSink,
  type E2eFrameSink,
} from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  decodePairingHello,
  encodePairingMessage,
  decodePairingReply,
  respondToHandshake,
  deriveOfferTokens,
  parseOfferUrl,
  encodeOfferUrl,
  OFFER_VERSION,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { generateIdentity, identityFingerprint, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createJoinTokenRegistry } from "../join-token-registry.js"
import { createHostRegistry, type HostJoinMeta } from "../host-registry.js"
import { connect } from "./frame-harness.js"

const TIMEOUT_MS = 2_000

function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      headers: { forEach: (_cb: (v: string, k: string) => void) => {} },
      arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
    })),
  )
}

/** Mint a fresh host-scoped self-offer for `identity`, as `joinAsBox` mints a
 *  new one on every box boot even when the box's identity (and therefore
 *  fingerprint) is stable across boots. */
async function makeSelfOffer(identity: DaemonIdentity): Promise<{ url: string; auth: string }> {
  const secret = randomBytes(16).toString("base64url")
  const { auth } = await deriveOfferTokens(secret)
  const fingerprint = await identityFingerprint(identity.x25519.pub)
  const url = encodeOfferUrl({
    v: OFFER_VERSION,
    rendezvousUrl: "ws://box.invalid/v1",
    fingerprint,
    daemonX25519Pub: identity.x25519.pub,
    daemonEd25519Pub: identity.ed25519.pub,
    secret,
    exp: Math.floor(Date.now() / 1000) + 600,
    scope: "host",
  })
  return { url, auth }
}

/** Play the box's CLIENT role for one `AGENTPROTO_JOIN` dial — mirrors
 *  `joinAsBox` in `serve.ts`: dial the token's route, hand over a
 *  self-offer URL plus a name in the sealed hello. */
async function joinAsBoxOnce(
  tokenUrl: string,
  sink: FrameSink,
  selfOfferUrl: string,
  name: string,
): Promise<PairingSession> {
  const offer = await parseOfferUrl(tokenUrl, { now: Date.now() })
  const { auth } = await deriveOfferTokens(offer.secret)
  const started = await startClientHandshake({
    daemonX25519Pub: offer.daemonX25519Pub,
    daemonEd25519Pub: offer.daemonEd25519Pub,
    authToken: auth,
    clientName: JSON.stringify({ offerUrl: selfOfferUrl, name }),
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    sink,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
      return session
    },
    { timeoutMs: TIMEOUT_MS },
  )
  if (!session) throw new Error("fake box: join handshake did not complete")
  wrapped.close("box join complete")
  return session
}

/** Play the box's DAEMON role for the home daemon's `HostRegistry.add()`
 *  dial-back into the box's self-offer — mirrors `host-registry.test.ts`'s
 *  `runFakeDaemon`. */
async function respondAsBoxDaemon(
  sink: FrameSink,
  identity: DaemonIdentity,
  expectedAuth: string,
): Promise<void> {
  let session: PairingSession | null = null
  const wrapped: E2eFrameSink = await daemonHandshakeOverSink(
    sink,
    async helloBytes => {
      const hello = decodePairingHello(helloBytes)
      const result = await respondToHandshake(hello, {
        identity,
        verifyAuthToken: token => token === expectedAuth,
      })
      session = result.session
      return { reply: encodePairingMessage(result.reply), keys: result.session }
    },
    { timeoutMs: TIMEOUT_MS },
  )
  createTunnelServer({
    sink: wrapped,
    authorize: r => r,
    httpUpstream: "http://127.0.0.1:1/upstream",
    label: "fake-box",
    pty: false,
  })
  if (!session) throw new Error("fake box daemon: handshake did not complete")
}

describe("join-token-registry + host-registry integration", () => {
  it("two AGENTPROTO_JOIN joins from the SAME box identity both land as one refreshed device", async () => {
    stubUpstream()
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-join-host-"))
    try {
      const hostsPath = join(tmp, "hosts.json")
      const joinTokensPath = join(tmp, "join-tokens.json")

      const homeIdentity = await generateIdentity()
      const boxIdentity = await generateIdentity()
      const boxFingerprint = await identityFingerprint(boxIdentity.x25519.pub)

      // The home daemon's HostRegistry.add() dials INTO whatever self-offer
      // the box most recently handed over — `currentSelfOfferAuth` tracks it
      // per join, exactly like a fresh box boot would.
      let currentSelfOfferAuth: string | undefined
      const hostDial = vi.fn(async () => {
        const { a, b } = connect()
        void respondAsBoxDaemon(a, boxIdentity, currentSelfOfferAuth!)
        return b
      })
      const hostRegistry = createHostRegistry({
        hostsPath,
        dial: hostDial,
        handshakeTimeoutMs: TIMEOUT_MS,
        dialTimeoutMs: TIMEOUT_MS,
      })

      // The join-token accept loop's own dial hands the fake box's socket
      // straight to whichever `joinAsBoxOnce` call is pending.
      let pendingBoxSink: FrameSink | undefined
      const joinDial = vi.fn(async () => {
        const { a, b } = connect()
        pendingBoxSink = b
        return a
      })
      const joinTokenRegistry = createJoinTokenRegistry({
        loadIdentity: async () => homeIdentity,
        joinTokensPath,
        dial: joinDial,
        addHost: (offerUrl, name, meta) =>
          hostRegistry.add(offerUrl, name, meta as HostJoinMeta | undefined),
        handshakeTimeoutMs: TIMEOUT_MS,
        reconnectMinMs: 10,
        reconnectMaxMs: 20,
      })

      const created = await joinTokenRegistry.create({ name: "ci-reviewer", ttlMs: 60_000 })

      for (let i = 0; i < 2; i++) {
        await vi.waitFor(() => expect(joinDial).toHaveBeenCalledTimes(i + 1))
        const boxSink = pendingBoxSink!
        const { url: selfOfferUrl, auth } = await makeSelfOffer(boxIdentity)
        currentSelfOfferAuth = auth
        await joinAsBoxOnce(created.token, boxSink, selfOfferUrl, `ci-reviewer-${i}`)

        // The join-token side always sees the join (useCount bumps
        // unconditionally, before the dial-back to the box even starts).
        await vi.waitFor(async () => {
          const list = await joinTokenRegistry.list()
          expect(list[0]!.useCount).toBe(i + 1)
        })

        // The real assertion: wait for THIS join's self-reported name to
        // land on the host record — a signal that `add()` for join i+1
        // actually completed, not just that a host from an earlier join
        // still happens to exist.
        await vi.waitFor(async () => {
          const hosts = await hostRegistry.list()
          expect(hosts).toHaveLength(1)
          expect(hosts[0]!.name).toBe(`ci-reviewer-${i}`)
        })
      }

      const hosts = await hostRegistry.list()
      expect(hosts).toHaveLength(1)
      expect(hosts[0]!.fingerprint).toBe(boxFingerprint)
      expect(hosts[0]!.name).toBe("ci-reviewer-1")
      // No failure should have been recorded against the token either.
      const tokens = await joinTokenRegistry.list()
      expect(tokens[0]!.lastJoinError).toBeUndefined()

      await joinTokenRegistry.shutdown()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("a failed addHost (e.g. the box's self-offer already expired) is surfaced on the token, not just logged", async () => {
    stubUpstream()
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-join-host-"))
    try {
      const joinTokensPath = join(tmp, "join-tokens.json")
      const homeIdentity = await generateIdentity()

      let pendingBoxSink: FrameSink | undefined
      const joinDial = vi.fn(async () => {
        const { a, b } = connect()
        pendingBoxSink = b
        return a
      })
      const addHost = vi.fn().mockRejectedValue(new Error("offer expired"))
      const joinTokenRegistry = createJoinTokenRegistry({
        loadIdentity: async () => homeIdentity,
        joinTokensPath,
        dial: joinDial,
        addHost,
        handshakeTimeoutMs: TIMEOUT_MS,
        reconnectMinMs: 10,
        reconnectMaxMs: 20,
      })

      const created = await joinTokenRegistry.create({ name: "ci-reviewer", ttlMs: 60_000 })
      await vi.waitFor(() => expect(joinDial).toHaveBeenCalledTimes(1))
      await joinAsBoxOnce(
        created.token,
        pendingBoxSink!,
        "agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=" +
          "0".repeat(32) +
          "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host",
        "ci-reviewer-0",
      )

      await vi.waitFor(() => expect(addHost).toHaveBeenCalledTimes(1))
      const tokens = await joinTokenRegistry.list()
      // useCount still bumps — the auth token itself was valid.
      expect(tokens[0]!.useCount).toBe(1)
      // ...but the failure to turn that join into a device must be visible
      // right here, not only in a log line nobody's watching.
      expect(tokens[0]!.lastJoinError).toContain("offer expired")
      expect(tokens[0]!.lastJoinErrorAt).toBeTruthy()

      await joinTokenRegistry.shutdown()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("a subsequent successful join clears a previously recorded lastJoinError", async () => {
    stubUpstream()
    const tmp = await mkdtemp(join(tmpdir(), "agentproto-join-host-"))
    try {
      const joinTokensPath = join(tmp, "join-tokens.json")
      const homeIdentity = await generateIdentity()

      let pendingBoxSink: FrameSink | undefined
      const joinDial = vi.fn(async () => {
        const { a, b } = connect()
        pendingBoxSink = b
        return a
      })
      const addHost = vi.fn().mockRejectedValueOnce(new Error("offer expired")).mockResolvedValue({
        fingerprint: "box-fp",
        name: "ci-reviewer-1",
      })
      const joinTokenRegistry = createJoinTokenRegistry({
        loadIdentity: async () => homeIdentity,
        joinTokensPath,
        dial: joinDial,
        addHost,
        handshakeTimeoutMs: TIMEOUT_MS,
        reconnectMinMs: 10,
        reconnectMaxMs: 20,
      })

      const created = await joinTokenRegistry.create({ name: "ci-reviewer", ttlMs: 60_000 })
      for (let i = 0; i < 2; i++) {
        await vi.waitFor(() => expect(joinDial).toHaveBeenCalledTimes(i + 1))
        await joinAsBoxOnce(
          created.token,
          pendingBoxSink!,
          "agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=" +
            "0".repeat(32) +
            "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host",
          `ci-reviewer-${i}`,
        )
        await vi.waitFor(() => expect(addHost).toHaveBeenCalledTimes(i + 1))
      }

      const tokens = await joinTokenRegistry.list()
      expect(tokens[0]!.useCount).toBe(2)
      expect(tokens[0]!.lastJoinError).toBeUndefined()
      expect(tokens[0]!.lastJoinErrorAt).toBeUndefined()

      await joinTokenRegistry.shutdown()
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})
