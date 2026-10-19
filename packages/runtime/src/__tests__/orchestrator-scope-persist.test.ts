/**
 * Orchestrator scope-token persistence — tokens survive a daemon restart.
 *
 * The registry persists to `orchestrator-scopes.json` (mode 0600, atomic
 * tmp+rename, debounced) when given a `persistPath`, and loads it back
 * synchronously at creation — so the `/mcp/orchestrator?scope=<token>`
 * URLs already baked into session descriptors keep authorizing after a
 * bounce, with no session restart. Legacy tokens minted by a
 * pre-persistence daemon are re-adopted from the descriptors that still
 * reference them, never wider than the DEFAULT tool subset.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

import {
  DEFAULT_ORCHESTRATOR_TOOLS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  adoptLegacyOrchestratorScopes,
  pruneOrchestratorScopesOnBoot,
} from "../orchestrator-gateway.js"
import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createRuntimeEvents } from "../events.js"

function tmpPersistPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agentproto-orch-scope-")),
    "orchestrator-scopes.json",
  )
}

function tmpTranscriptDir(): string {
  return join(mkdtempSync(join(tmpdir(), "agentproto-orch-scope-tr-")), "transcripts")
}

function fakeSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

describe("orchestrator scope-token registry — persistence", () => {
  it("round-trips mint → reload: verify returns the same tools, depth, limits, role and owner", () => {
    const persistPath = tmpPersistPath()
    const reg = createScopeTokenRegistry({ persistPath })
    const scope = reg.mint({
      tools: ["agent_start", "session_list", "command_execute"], // narrowed ⊆ default
      depth: 2,
      maxDepth: 5,
      maxChildren: 3,
      role: "supervisor",
    })
    reg.bindOwner(scope.token, "ses_owner")
    reg.flushSync()

    // Simulated restart: a fresh registry from the SAME file.
    const reloaded = createScopeTokenRegistry({ persistPath })
    const got = reloaded.verify(scope.token)
    expect(got).not.toBeNull()
    expect([...got!.tools].sort()).toEqual(["agent_start", "session_list"])
    expect(got!.depth).toBe(2)
    expect(got!.maxDepth).toBe(5)
    expect(got!.maxChildren).toBe(3)
    expect(got!.role).toBe("supervisor")
    expect(got!.ownerSessionId).toBe("ses_owner")
  })

  it("revoke is persisted — the token stays dead across a reload", () => {
    const persistPath = tmpPersistPath()
    const reg = createScopeTokenRegistry({ persistPath })
    const keep = reg.mint()
    const drop = reg.mint()
    reg.flushSync()
    // Reload sees both…
    const mid = createScopeTokenRegistry({ persistPath })
    expect(mid.verify(drop.token)).not.toBeNull()
    mid.revoke(drop.token)
    mid.flushSync()
    // …and the next reload sees only the survivor.
    const reloaded = createScopeTokenRegistry({ persistPath })
    expect(reloaded.verify(drop.token)).toBeNull()
    expect(reloaded.verify(keep.token)).not.toBeNull()
  })

  it("creates the persist file with mode 0600", () => {
    const persistPath = tmpPersistPath()
    const reg = createScopeTokenRegistry({ persistPath })
    reg.mint()
    reg.flushSync()
    expect(statSync(persistPath).mode & 0o777).toBe(0o600)
  })

  it("a corrupt or missing file yields an empty registry without throwing", () => {
    const corrupt = tmpPersistPath()
    writeFileSync(corrupt, "not-json{{{", "utf8")
    const reg = createScopeTokenRegistry({ persistPath: corrupt })
    expect(reg.verify("anything")).toBeNull()
    // …and the registry is still fully usable.
    expect(reg.verify(reg.mint().token)).not.toBeNull()

    const missing = join(
      mkdtempSync(join(tmpdir(), "agentproto-orch-scope-m-")),
      "no-such-dir",
      "orchestrator-scopes.json",
    )
    const reg2 = createScopeTokenRegistry({ persistPath: missing })
    expect(reg2.verify("anything")).toBeNull()
    expect(reg2.verify(reg2.mint().token)).not.toBeNull()
  })

  it("in-memory default (no persistPath) still works and writes no file", () => {
    const reg = createScopeTokenRegistry()
    const scope = reg.mint()
    reg.bindOwner(scope.token, "ses_x")
    expect(reg.verify(scope.token)).not.toBeNull()
    reg.revoke(scope.token)
    expect(reg.verify(scope.token)).toBeNull()
    reg.flushSync() // no-op, must not throw
  })
})

describe("adoptLegacyOrchestratorScopes", () => {
  function makeRegistry() {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const registry = createSessionsRegistry({
      sessionEvents,
      persist: false,
      transcriptDir: tmpTranscriptDir(),
    })
    return registry
  }

  const orchRef = (token: string) =>
    `http://127.0.0.1:18790/mcp/orchestrator?scope=${token}`

  it("adopts an unknown token from a live session's mcpServers (owner, depth, default tools)", () => {
    const sessions = makeRegistry()
    const parent = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("legacy_parent"),
      adapterSlug: "mock",
      depth: 0,
    })
    const child = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("legacy_child"),
      adapterSlug: "mock",
      parentSessionId: parent.id,
      depth: 1,
      mcpServers: [
        { name: "agentproto", transport: "http", ref: orchRef("deadbeef".repeat(8)) },
      ],
    })

    const scopes = createScopeTokenRegistry()
    const token = "deadbeef".repeat(8)
    const adopted = adoptLegacyOrchestratorScopes(scopes, sessions.list())
    expect(adopted).toBe(1)

    const scope = scopes.verify(token)
    expect(scope).not.toBeNull()
    expect(scope!.ownerSessionId).toBe(child.id)
    expect(scope!.depth).toBe(1) // one ancestor via parentSessionId
    // Never wider than the default — exactly the default subset.
    expect([...scope!.tools].sort()).toEqual([...DEFAULT_ORCHESTRATOR_TOOLS].sort())
    expect(scope!.role).toBe("supervisor")
    expect(scope!.maxDepth).toBe(DEFAULT_MAX_DEPTH)
    expect(scope!.maxChildren).toBe(DEFAULT_MAX_CHILDREN)
  })

  it("never widens tools: an already-known (narrowed) token is NOT overwritten", () => {
    const sessions = makeRegistry()
    const live = createScopeTokenRegistry()
    const narrowedScope = live.mint({ tools: ["agent_start"] })

    sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("legacy_narrow"),
      adapterSlug: "mock",
      depth: 0,
      mcpServers: [
        {
          name: "agentproto",
          transport: "http",
          ref: orchRef(narrowedScope.token),
        },
      ],
    })
    adoptLegacyOrchestratorScopes(live, sessions.list())
    // Still the narrowed set — adoption never widens a known token.
    const after = live.verify(narrowedScope.token)
    expect([...after!.tools]).toEqual(["agent_start"])
  })

  it("skips terminal non-resumable sessions and non-orchestrator refs", () => {
    const sessions = makeRegistry()
    const dead = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("legacy_dead"),
      adapterSlug: "mock",
      depth: 0,
      mcpServers: [
        { name: "agentproto", transport: "http", ref: orchRef("b".repeat(64)) },
      ],
    })
    sessions.kill(dead.id)
    // Strip the resume essentials → no longer resumable → not adopted.
    dead.adapterSessionId = undefined

    const unrelated = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("legacy_unrelated"),
      adapterSlug: "mock",
      depth: 0,
      mcpServers: [
        // Plain daemon /mcp mount, not the orchestrator sub-gateway.
        { name: "agentproto", transport: "http", ref: "http://127.0.0.1:18790/mcp" },
      ],
    })

    const scopes = createScopeTokenRegistry()
    const adopted = adoptLegacyOrchestratorScopes(scopes, sessions.list())
    expect(adopted).toBe(0)
    expect(scopes.verify("b".repeat(64))).toBeNull()
    expect(unrelated.id).toBeTruthy()
  })
})

describe("pruneOrchestratorScopesOnBoot", () => {
  function makeRegistry() {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    return createSessionsRegistry({
      sessionEvents,
      persist: false,
      transcriptDir: tmpTranscriptDir(),
    })
  }

  const orchRef = (token: string) =>
    `http://127.0.0.1:18790/mcp/orchestrator?scope=${token}`

  it("drops an owned scope whose owner is absent from the registry; keeps killed+resumable; drops exited+non-resumable", () => {
    const sessions = makeRegistry()
    const scopes = createScopeTokenRegistry()

    // (a) owner absent → dropped.
    const orphanOwned = scopes.mint()
    scopes.bindOwner(orphanOwned.token, "ses_gone_forever")

    // (b) owner killed but still resumable (boot-killed history row) → KEPT.
    const killable = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("prune_resumable"),
      adapterSlug: "mock",
      depth: 0,
    })
    const killedResumable = scopes.mint()
    scopes.bindOwner(killedResumable.token, killable.id)
    sessions.kill(killable.id)

    // (c) owner exited AND non-resumable → dropped.
    const doomed = sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("prune_doomed"),
      adapterSlug: "mock",
      depth: 0,
    })
    const exitedDoomed = scopes.mint()
    scopes.bindOwner(exitedDoomed.token, doomed.id)
    sessions.kill(doomed.id)
    doomed.adapterSessionId = undefined // strip resume essentials

    const dropped = pruneOrchestratorScopesOnBoot(scopes, sessions.list())
    expect(dropped).toBe(2)
    expect(scopes.verify(orphanOwned.token)).toBeNull()
    expect(scopes.verify(exitedDoomed.token)).toBeNull()
    expect(scopes.verify(killedResumable.token)).not.toBeNull()
  })

  it("drops an unowned scope no descriptor references; keeps one an alive descriptor still carries", () => {
    const sessions = makeRegistry()
    const scopes = createScopeTokenRegistry()

    // Unowned + unreferenced (spawn died before bindOwner) → garbage.
    const garbage = scopes.mint()

    // Unowned + still referenced by a live child's persisted mcpServers
    // (crash between adapter start and bindOwner) → kept.
    const live = scopes.mint()
    sessions.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession("prune_unowned_live"),
      adapterSlug: "mock",
      depth: 0,
      mcpServers: [
        { name: "agentproto", transport: "http", ref: orchRef(live.token) },
      ],
    })

    const dropped = pruneOrchestratorScopesOnBoot(scopes, sessions.list())
    expect(dropped).toBe(1)
    expect(scopes.verify(garbage.token)).toBeNull()
    expect(scopes.verify(live.token)).not.toBeNull()
  })

  it("prune is persisted — a reload after boot prune does not resurrect the dropped tokens", () => {
    const sessions = makeRegistry()
    const persistPath = tmpPersistPath()
    const scopes = createScopeTokenRegistry({ persistPath })
    // Owned by a session the registry does not know → dropped.
    const ownedOrphan = scopes.mint()
    scopes.bindOwner(ownedOrphan.token, "ses_absent")
    // Unowned and unreferenced → dropped.
    const unowned = scopes.mint()
    scopes.flushSync()

    const boot = createScopeTokenRegistry({ persistPath })
    expect(pruneOrchestratorScopesOnBoot(boot, sessions.list())).toBe(2)
    boot.flushSync()

    const reloaded = createScopeTokenRegistry({ persistPath })
    expect(reloaded.verify(ownedOrphan.token)).toBeNull()
    expect(reloaded.verify(unowned.token)).toBeNull()
  })
})

// ── HTTP-level restart simulation ────────────────────────────────────

describe("orchestrator scope-token persistence — HTTP gate across a simulated restart", () => {
  function freePort(): Promise<number> {
    return new Promise((res, rej) => {
      const srv = createServer()
      srv.once("error", rej)
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as AddressInfo).port
        srv.close(() => res(port))
      })
    })
  }

  function noopConversations(): ConversationStore {
    return {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    }
  }

  function noopHeartbeat(): HeartbeatRunner {
    return {
      start() {},
      stop() {},
      async fireNow() {},
    }
  }

  async function withOrchestratorServer(
    verify: ReturnType<typeof createScopeTokenRegistry>["verify"],
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const port = await freePort()
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const registry = createSessionsRegistry({
      sessionEvents,
      persist: false,
      transcriptDir: tmpTranscriptDir(),
    })
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      registry,
      sessionEvents,
      eventRing,
    })
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      orchestratorMcpServerFactory: factory,
      verifyOrchestratorScope: verify,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  const mcpHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }

  it("a token minted before a restart still authorizes after the registry is re-created from the same file", async () => {
    const persistPath = tmpPersistPath()

    // Boot 1: mint + bind, as `agent_start(orchestrator: true)` would.
    const before = createScopeTokenRegistry({ persistPath })
    const scope = before.mint()
    before.bindOwner(scope.token, "ses_orchestrator")
    before.flushSync()

    // The token authorizes on the live registry.
    await withOrchestratorServer(before.verify, async base => {
      const res = await fetch(`${base}/mcp/orchestrator?scope=${scope.token}`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        }),
      })
      expect(res.status).not.toBe(401)
    })

    // Simulated daemon restart: a brand-new registry from the SAME file.
    const after = createScopeTokenRegistry({ persistPath })
    const restored = after.verify(scope.token)
    expect(restored).not.toBeNull()
    expect(restored!.ownerSessionId).toBe("ses_orchestrator")

    await withOrchestratorServer(after.verify, async base => {
      const client = new Client({ name: "child", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp/orchestrator?scope=${scope.token}`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual([...DEFAULT_ORCHESTRATOR_TOOLS].sort())
      await client.close()
    })

    // Contrast: an EMPTY registry (no persist file load) rejects the same
    // token — proving the file, not the process, is what carries it.
    const empty = createScopeTokenRegistry()
    await withOrchestratorServer(empty.verify, async base => {
      const res = await fetch(`${base}/mcp/orchestrator?scope=${scope.token}`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      })
      expect(res.status).toBe(401)
    })
  })
})
