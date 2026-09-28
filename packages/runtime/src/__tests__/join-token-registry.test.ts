/**
 * Unit tests for `createJoinTokenRegistry` (SANDBOX-VISIBILITY-JOIN). Drives a
 * fake "box" directly (in-process transport, see frame-harness.ts) using
 * `startClientHandshake` + `clientHandshakeOverSink` — the exact client-side
 * primitives a joining daemon uses — so these tests exercise the real crypto,
 * not a mock of it. `addHost` (normally `hostRegistry.add`) is faked so these
 * tests stay scoped to the join-token protocol itself.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clientHandshakeOverSink, type FrameSink } from "@agentproto/acp/tunnel"
import {
  startClientHandshake,
  encodePairingMessage,
  decodePairingReply,
  deriveOfferTokens,
  parseOfferUrl,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { generateIdentity, type DaemonIdentity } from "@agentproto/secrets/identity"
import { createJoinTokenRegistry } from "../join-token-registry.js"
import { connect } from "./frame-harness.js"

const HANDSHAKE_TIMEOUT_MS = 2_000

/** Play the box side of one join: parse the token, dial it, hand over
 *  `clientName` verbatim (the JSON envelope under test). */
async function dialAsBox(
  tokenUrl: string,
  dial: (route: string) => Promise<FrameSink>,
  clientNameJson: unknown,
): Promise<PairingSession> {
  const offer = await parseOfferUrl(tokenUrl, { now: Date.now() })
  const { route, auth } = await deriveOfferTokens(offer.secret)
  const raw = await dial(route)
  const started = await startClientHandshake({
    daemonX25519Pub: offer.daemonX25519Pub,
    daemonEd25519Pub: offer.daemonEd25519Pub,
    authToken: auth,
    clientName: JSON.stringify(clientNameJson),
  })
  let session: PairingSession | null = null
  const wrapped = await clientHandshakeOverSink(
    raw,
    encodePairingMessage(started.hello),
    async replyBytes => {
      session = await started.complete(decodePairingReply(replyBytes))
      return session
    },
    { timeoutMs: HANDSHAKE_TIMEOUT_MS },
  )
  if (!session) throw new Error("fake box: handshake did not complete")
  wrapped.close("box join complete")
  return session
}

describe("createJoinTokenRegistry", () => {
  let tmp: string
  let joinTokensPath: string
  let identity: DaemonIdentity

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentproto-join-tokens-"))
    joinTokensPath = join(tmp, "join-tokens.json")
    identity = await generateIdentity()
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  /** Wire a registry whose `dial` splices straight to a fake box via
   *  frame-harness — no real network, real pair/v2 crypto both ways. */
  function makeRegistry(addHost: (...args: unknown[]) => unknown) {
    let capturedRoute: string | undefined
    const dial = vi.fn(async (wsUrl: string) => {
      const url = new URL(wsUrl.replace(/^ws/, "http"))
      capturedRoute = url.searchParams.get("t") ?? undefined
      const { a, b } = connect()
      // `a` is handed back to the registry (plays "daemon"); `b` is this
      // test's box-side endpoint.
      pendingBoxSink = b
      return a
    })
    let pendingBoxSink: FrameSink | undefined
    const registry = createJoinTokenRegistry({
      loadIdentity: async () => identity,
      joinTokensPath,
      dial,
      addHost: addHost as (offerUrl: string, name?: string, meta?: unknown) => Promise<unknown>,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    })
    return {
      registry,
      dial,
      getBoxSink: (): FrameSink => {
        if (!pendingBoxSink) throw new Error("dial was not called yet")
        return pendingBoxSink
      },
      getRoute: (): string => {
        if (!capturedRoute) throw new Error("dial was not called yet")
        return capturedRoute
      },
    }
  }

  it("create() mints a token, persists it 0600, and never echoes the secret from list()", async () => {
    const { registry } = makeRegistry(vi.fn())
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })
    expect(created.name).toBe("ci-reviewer")
    expect(created.token).toContain("scope=host")
    expect(created.token).toContain("agentproto://pair?")

    const list = await registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: created.id, name: "ci-reviewer", useCount: 0 })
    expect(list[0]).not.toHaveProperty("secret")

    const file = JSON.parse(await readFile(joinTokensPath, "utf8"))
    expect(file.v).toBe(1)
    expect(file.tokens).toHaveLength(1)
    expect(file.tokens[0].id).toBe(created.id)
    await registry.shutdown()
  })

  it("a box dialing the minted token, presenting its own offer URL, results in addHost being called", async () => {
    const addHost = vi.fn().mockResolvedValue({ fingerprint: "box-fp", name: "ci-reviewer-pr1492" })
    const { registry, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })

    await vi.waitFor(() => getBoxSink())
    const boxSink = getBoxSink()
    const dialBox = async (): Promise<FrameSink> => boxSink

    const session = await dialAsBox(created.token, dialBox, {
      offerUrl: "agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=" + "0".repeat(32) + "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host",
      name: "ci-reviewer-pr1492",
      provider: "e2b",
      sandboxId: "sbx_abc123",
      labels: { pr: "1492" },
    })
    expect(session.peerFingerprint).toBeTruthy()

    await vi.waitFor(() => expect(addHost).toHaveBeenCalled())
    expect(addHost).toHaveBeenCalledWith(
      expect.stringContaining("scope=host"),
      "ci-reviewer-pr1492",
      { joined: true, provider: "e2b", sandboxId: "sbx_abc123", labels: { pr: "1492" } },
    )

    const list = await registry.list()
    expect(list[0]!.useCount).toBe(1)
    expect(list[0]!.lastUsedAt).toBeTruthy()
    await registry.shutdown()
  })

  it("synthesizes '<token name> #<pr>' when the box self-reports a pr label but no name (SANDBOX-VISIBILITY-JOIN #1) — the box never knows the token's own name", async () => {
    const addHost = vi.fn().mockResolvedValue({ fingerprint: "box-fp" })
    const { registry, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })
    await vi.waitFor(() => getBoxSink())
    const boxSink = getBoxSink()

    await dialAsBox(created.token, async () => boxSink, {
      offerUrl: "agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=" + "0".repeat(32) + "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host",
      provider: "e2b",
      labels: { pr: "1536", repo: "agentproto/ts" },
    })

    await vi.waitFor(() => expect(addHost).toHaveBeenCalled())
    expect(addHost).toHaveBeenCalledWith(
      expect.stringContaining("scope=host"),
      "ci-reviewer #1536",
      { joined: true, provider: "e2b", labels: { pr: "1536", repo: "agentproto/ts" } },
    )
    await registry.shutdown()
  })

  it("falls back to the bare token name when the box self-reports neither a name nor a pr label", async () => {
    const addHost = vi.fn().mockResolvedValue({ fingerprint: "box-fp" })
    const { registry, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })
    await vi.waitFor(() => getBoxSink())
    const boxSink = getBoxSink()

    await dialAsBox(created.token, async () => boxSink, {
      offerUrl: "agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=" + "0".repeat(32) + "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host",
    })

    await vi.waitFor(() => expect(addHost).toHaveBeenCalled())
    expect(addHost).toHaveBeenCalledWith(expect.stringContaining("scope=host"), "ci-reviewer", { joined: true })
    await registry.shutdown()
  })

  it("re-parks after a join — the SAME token can be used by a second box", async () => {
    const addHost = vi.fn().mockResolvedValue({ fingerprint: "box-fp" })
    const { registry, dial, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })

    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(i + 1))
      const boxSink = getBoxSink()
      await dialAsBox(created.token, async () => boxSink, { offerUrl: `agentproto://pair?v=2&rv=ws%3A%2F%2Fbox.invalid%2Fv1&id=${"0".repeat(32)}&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host`, name: `box-${i}` })
      await vi.waitFor(() => expect(addHost).toHaveBeenCalledTimes(i + 1))
    }
    await registry.shutdown()
  })

  it("rejects a wrong auth token without incrementing useCount", async () => {
    const addHost = vi.fn()
    const { registry, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })
    await vi.waitFor(() => getBoxSink())

    // Present a hello sealed with the RIGHT daemon keys but a WRONG auth
    // token (as if a different, invalid token were used).
    const offer = await parseOfferUrl(created.token, { now: Date.now() })
    const raw = await getBoxSink()
    const started = await startClientHandshake({
      daemonX25519Pub: offer.daemonX25519Pub,
      daemonEd25519Pub: offer.daemonEd25519Pub,
      authToken: "not-the-real-auth-token",
      clientName: JSON.stringify({ offerUrl: "agentproto://pair?v=2&rv=ws%3A%2F%2Fx&id=" + "0".repeat(32) + "&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host" }),
    })
    await expect(
      clientHandshakeOverSink(
        raw,
        encodePairingMessage(started.hello),
        async replyBytes => started.complete(decodePairingReply(replyBytes)),
        { timeoutMs: HANDSHAKE_TIMEOUT_MS },
      ),
    ).rejects.toThrow()

    expect(addHost).not.toHaveBeenCalled()
    const list = await registry.list()
    expect(list[0]!.useCount).toBe(0)
    await registry.shutdown()
  })

  it("revoke() stops the accept loop and list() still shows the token with revokedAt", async () => {
    const { registry, dial } = makeRegistry(vi.fn())
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000 })
    await vi.waitFor(() => expect(dial).toHaveBeenCalled())
    const dialCallsBeforeRevoke = dial.mock.calls.length

    expect(await registry.revoke("ci-reviewer")).toBe(true)
    const list = await registry.list()
    expect(list[0]!.revokedAt).toBeTruthy()

    // No further dials after revoke (loop stopped, not just failing auth).
    await new Promise(r => setTimeout(r, 50))
    expect(dial.mock.calls.length).toBe(dialCallsBeforeRevoke)

    expect(await registry.revoke("ci-reviewer")).toBe(false)
    expect(await registry.revoke("no-such-token")).toBe(false)
  })

  it("maxUses: a token exhausted after N uses is not re-parked", async () => {
    const addHost = vi.fn().mockResolvedValue({ fingerprint: "box-fp" })
    const { registry, dial, getBoxSink } = makeRegistry(addHost)
    const created = await registry.create({ name: "ci-reviewer", ttlMs: 60_000, maxUses: 1 })

    await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1))
    const boxSink = getBoxSink()
    await dialAsBox(created.token, async () => boxSink, { offerUrl: `agentproto://pair?v=2&rv=ws%3A%2F%2Fx&id=${"0".repeat(32)}&pk=AA&sk=BB&s=cc&exp=9999999999&scope=host` })
    await vi.waitFor(() => expect(addHost).toHaveBeenCalledTimes(1))

    // Give the loop a chance to re-park (it should NOT, maxUses exhausted).
    await new Promise(r => setTimeout(r, 50))
    expect(dial.mock.calls.length).toBe(1)

    const list = await registry.list()
    expect(list[0]!.useCount).toBe(1)
    await registry.shutdown()
  })
})
