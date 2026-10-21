/**
 * PARENT RELAY - the full token lifecycle (PR #2162 review):
 *
 *  - the HOST keeps only the token's hash, persisted (0600) next to the
 *    sessions registry and reloaded at boot, so a host daemon restart does
 *    not turn a live box's relay into `relay_token_unknown`;
 *  - a grant is revoked when its box session OR its parent session ends, is
 *    archived or forgotten;
 *  - the periodic sweep renews a grant while both sessions are live, revokes
 *    it once either is dead and prunes expired ones;
 *  - `remoteParent` on `agent_start` is daemon-internal: a session caller
 *    cannot supply it, and a cron/routine `kind:"agent"` job strips it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { detachedAgentStartSchema } from "../agent-start-schema.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import {
  attachParentRelayStore,
  clearParentRelayGrants,
  hashParentRelayToken,
  mintParentRelayGrant,
  PARENT_RELAY_GRANTS_FILE,
  resolveParentRelayGrant,
  sweepParentRelayGrants,
  type ParentRelayLiveness,
} from "../parent-relay.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_relay_lifecycle",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnRow(registry: SessionsRegistry, parentSessionId?: string): string {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId, depth: 1 } : { depth: 0 }),
  }).id
}

const URL = "https://host.example"

beforeEach(() => {
  clearParentRelayGrants()
})

afterEach(() => {
  clearParentRelayGrants()
})

describe("parent relay: the host stores only a hash, and survives a restart", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parent-relay-store-"))
  })

  it("the grants file carries the token HASH, never the raw token, and is owner-only", () => {
    attachParentRelayStore({ dir })
    const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: "sess_b", url: URL })
    const path = join(dir, PARENT_RELAY_GRANTS_FILE)
    const raw = readFileSync(path, "utf8")
    expect(raw).not.toContain(remote.token)
    expect(raw).toContain(hashParentRelayToken(remote.token))
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    // The in-memory record does not hold the raw token either.
    const grant = resolveParentRelayGrant(remote.token)
    expect(JSON.stringify(grant)).not.toContain(remote.token)
  })

  it("a host daemon restart reloads the grant: the box's token is still known", () => {
    attachParentRelayStore({ dir })
    const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: "sess_b", url: URL })
    // The process dies: every in-memory grant is gone.
    clearParentRelayGrants()
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
    // The next boot attaches the same state dir and reloads.
    attachParentRelayStore({ dir })
    const grant = resolveParentRelayGrant(remote.token)
    expect(grant?.parentSessionId).toBe("sess_p")
    expect(grant?.boxSessionId).toBe("sess_b")
  })

  it("a registry with persistence attaches the store under its own state dir", () => {
    const registry = createSessionsRegistry({ persistPath: join(dir, "sessions.json") })
    try {
      const box = spawnRow(registry)
      const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: box, url: URL })
      const raw = readFileSync(join(dir, PARENT_RELAY_GRANTS_FILE), "utf8")
      expect(raw).toContain(hashParentRelayToken(remote.token))
      expect(raw).not.toContain(remote.token)
    } finally {
      registry.shutdown()
    }
  })

  it("an expired grant is not reloaded", () => {
    attachParentRelayStore({ dir })
    const remote = mintParentRelayGrant({
      parentSessionId: "sess_p",
      boxSessionId: "sess_b",
      url: URL,
      ttlMs: 1000,
      nowMs: 1000,
    })
    clearParentRelayGrants()
    attachParentRelayStore({ dir, nowMs: 5000 })
    expect(resolveParentRelayGrant(remote.token, 1500)).toBeUndefined()
  })
})

describe("parent relay: grants are revoked when either session ends", () => {
  it("the PARENT session ending revokes its children's grants", () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnRow(registry)
    const box = spawnRow(registry, parent)
    const remote = mintParentRelayGrant({ parentSessionId: parent, boxSessionId: box, url: URL })
    expect(resolveParentRelayGrant(remote.token)).toBeDefined()
    registry.kill(parent)
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
    registry.shutdown()
  })

  it("archiving a session revokes a grant it still takes part in", () => {
    const registry = createSessionsRegistry({ persist: false })
    const box = spawnRow(registry)
    registry.kill(box)
    // A grant that names an already-ended row (e.g. re-minted by a racing
    // restart) still dies with the row's archive.
    const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: box, url: URL })
    registry.archiveSession(box)
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
    registry.shutdown()
  })

  it("forgetting a session revokes a grant it still takes part in", () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnRow(registry)
    registry.kill(parent)
    const remote = mintParentRelayGrant({ parentSessionId: parent, boxSessionId: "sess_b", url: URL })
    registry.forget(parent)
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
    registry.shutdown()
  })
})

describe("parent relay: the sweep renews live grants and revokes dead ones", () => {
  let dir: string
  const state = new Map<string, ParentRelayLiveness>()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parent-relay-sweep-"))
    state.clear()
    attachParentRelayStore({ dir, liveness: id => state.get(id) ?? "unknown" })
  })

  it("a grant whose sessions are both live is renewed before it expires (no use needed)", () => {
    const now = 1_000_000
    const remote = mintParentRelayGrant({
      parentSessionId: "sess_p",
      boxSessionId: "sess_b",
      url: URL,
      ttlMs: 1000,
      nowMs: now,
    })
    state.set("sess_p", "live")
    state.set("sess_b", "live")
    // Past half the TTL: the sweep renews.
    expect(sweepParentRelayGrants(now + 600).renewed).toBe(1)
    // Alive past its ORIGINAL deadline, with no relay use at all.
    expect(resolveParentRelayGrant(remote.token, now + 1500)?.expiresAt).toBe(now + 600 + 1000)
    // ...and the renewal reached the disk.
    clearParentRelayGrants()
    attachParentRelayStore({ dir, nowMs: now + 1500 })
    expect(resolveParentRelayGrant(remote.token, now + 1500)).toBeDefined()
  })

  it("a grant whose box session is dead is revoked", () => {
    const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: "sess_b", url: URL })
    state.set("sess_p", "live")
    state.set("sess_b", "dead")
    expect(sweepParentRelayGrants().revoked).toBe(1)
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
  })

  it("a grant whose parent is dead is revoked", () => {
    const remote = mintParentRelayGrant({ parentSessionId: "sess_p", boxSessionId: "sess_b", url: URL })
    state.set("sess_p", "dead")
    state.set("sess_b", "live")
    expect(sweepParentRelayGrants().revoked).toBe(1)
    expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
  })

  it("an unknown session is neither renewed nor revoked: the grant still expires on its own", () => {
    const now = 1_000_000
    const remote = mintParentRelayGrant({
      parentSessionId: "sess_p",
      boxSessionId: "sess_b",
      url: URL,
      ttlMs: 1000,
      nowMs: now,
    })
    expect(sweepParentRelayGrants(now + 600)).toEqual({ pruned: 0, revoked: 0, renewed: 0 })
    expect(sweepParentRelayGrants(now + 1001).pruned).toBe(1)
    expect(resolveParentRelayGrant(remote.token, now + 1001)).toBeUndefined()
  })

  it("the registry's liveness probe drives the sweep (live rows renew, an ended row revokes)", () => {
    const registry = createSessionsRegistry({ persistPath: join(dir, "sessions.json") })
    try {
      const parent = spawnRow(registry)
      const box = spawnRow(registry, parent)
      const now = Date.now()
      const remote = mintParentRelayGrant({
        parentSessionId: parent,
        boxSessionId: box,
        url: URL,
        ttlMs: 1000,
        nowMs: now,
      })
      expect(sweepParentRelayGrants(now + 600).renewed).toBe(1)
      // The row ends without going through the exit funnel's revoke (it
      // already did here - so re-mint to prove the SWEEP catches a dead row).
      registry.kill(box)
      const again = mintParentRelayGrant({ parentSessionId: parent, boxSessionId: box, url: URL })
      expect(sweepParentRelayGrants().revoked).toBe(1)
      expect(resolveParentRelayGrant(again.token)).toBeUndefined()
      expect(resolveParentRelayGrant(remote.token)).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})

describe("parent relay: remoteParent is daemon-internal on agent_start", () => {
  async function harness(registry: SessionsRegistry, callerSessionId?: string) {
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry, ...(callerSessionId ? { callerSessionId } : {}) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return client
  }
  const remoteParent = { sessionId: "sess_host_parent", url: "https://attacker.example", token: "tok" }

  it("a session caller that supplies remoteParent is refused", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const caller = spawnRow(registry)
    const client = await harness(registry, caller)
    try {
      const result = (await client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock", remoteParent },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain("`remoteParent` is daemon-internal")
    } finally {
      await client.close()
      registry.shutdown()
    }
  })

  it("the root caller (the host daemon booting a box) is not refused on remoteParent", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const client = await harness(registry)
    try {
      const result = (await client.callTool({
        name: "agent_start",
        arguments: { adapter: "mock", remoteParent },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      // This harness has no adapter resolver, so the call stops there - but
      // NOT at the remoteParent gate.
      expect(result.content[0]!.text).not.toContain("daemon-internal")
    } finally {
      await client.close()
      registry.shutdown()
    }
  })

  it("a cron/routine agent job cannot carry remoteParent (it would fire later as a root call)", () => {
    const parsed = detachedAgentStartSchema.parse({ adapter: "mock", remoteParent })
    expect((parsed as Record<string, unknown>).remoteParent).toBeUndefined()
  })
})
