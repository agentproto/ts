/**
 * The policy→session link, read backwards: `policy_list`'s optional
 * `sessionId` and the equivalent `GET /policies?sessionId=` answer "what is
 * gating this session?" without a persisted reverse index — both transports
 * share `policyWatchesSession`, so they agree on what "watches" means.
 *
 * Drives the REAL `policy_list` MCP tool (via `registerOrchestrationTools`,
 * the production handler) and the REAL REST route (via `startHttpServer`),
 * against a stub supervisor whose `list()` is fixed — the filter is what's
 * under test, not the state machine.
 *
 * The load-bearing case is composition: the filter narrows, and the WP6
 * subtree scoping (a security boundary for nested orchestrators) still
 * decides what a scoped caller may see at all. A `sessionId` outside the
 * caller's subtree must not reach around it.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { policyWatchesSession } from "../supervisor.js"
import type { CompletionPolicySupervisor, PolicyRunState } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

// ── Fixtures ──────────────────────────────────────────────────────────

function makePolicy(policyId: string, sessionIds: string[]): PolicyRunState {
  return {
    policyId,
    sessionId: sessionIds[0]!,
    sessionIds,
    pending: [...sessionIds],
    status: "watching",
    retries: 0,
    startedAt: "2026-07-17T00:00:00.000Z",
  }
}

/** A supervisor whose `list()` is fixed — the filter is under test, not the
 *  state machine. Every other member is unreachable in these tests. */
function stubSupervisor(policies: PolicyRunState[]): CompletionPolicySupervisor {
  return {
    attach() {
      throw new Error("attach not used in this test")
    },
    getStatus: (policyId: string) => policies.find(p => p.policyId === policyId),
    cancel() {},
    async ack() {
      return undefined
    },
    list: () => policies,
    onSettle: () => () => {},
    shutdown() {},
  }
}

/** pol_solo watches sess_a alone; pol_group fans in over sess_b + sess_c;
 *  pol_other watches sess_d — nothing overlaps, so a filter's hit set is
 *  unambiguous. */
const POLICIES: PolicyRunState[] = [
  makePolicy("pol_solo", ["sess_a"]),
  makePolicy("pol_group", ["sess_b", "sess_c"]),
  makePolicy("pol_other", ["sess_d"]),
]

let acpCounter = 0
/** A fake ACP session — never receives turns here; it exists so the registry
 *  holds real descriptors for `collectSubtree` to walk. */
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(
  registry: SessionsRegistry,
  parentSessionId?: string,
  depth = 0,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth,
  })
}

/** Text of an MCP content block, or undefined if it isn't a text block. The
 *  SDK types `content` as `unknown` (the compatibility union widens it), so
 *  this narrows structurally rather than asserting a shape. */
function blockText(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined
  if (!("type" in block) || block.type !== "text") return undefined
  if (!("text" in block) || typeof block.text !== "string") return undefined
  return block.text
}

/** The SDK's own result type — a union whose legacy `{ toolResult }` branch
 *  carries no content, hence the `in` narrow below. */
type CallToolResult = Awaited<ReturnType<Client["callTool"]>>

function parseToolJson(result: CallToolResult): PolicyRunState[] {
  const blocks = "content" in result ? result.content : undefined
  if (!Array.isArray(blocks)) throw new Error("tool result has no content array")
  for (const block of blocks) {
    const text = blockText(block)
    if (text === undefined) continue
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error(`policy_list returned a non-array: ${text}`)
    return parsed
  }
  throw new Error("tool returned no text content")
}

/** Build a client over the real `policy_list` handler. */
async function mcpClient(opts: {
  supervisor: CompletionPolicySupervisor
  registry?: SessionsRegistry
  callerScope?: { ownerSessionId?: string }
}): Promise<Client> {
  const server = new McpServer({ name: "policy-filter-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry: opts.registry ?? createSessionsRegistry({ persist: false }),
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
    supervisor: opts.supervisor,
    ...(opts.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "policy-filter-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

async function listPolicies(client: Client, sessionId?: string): Promise<PolicyRunState[]> {
  return parseToolJson(
    await client.callTool({
      name: "policy_list",
      arguments: sessionId === undefined ? {} : { sessionId },
    }),
  )
}

const ids = (policies: PolicyRunState[]): string[] => policies.map(p => p.policyId)

// ── policyWatchesSession ──────────────────────────────────────────────

describe("policyWatchesSession", () => {
  it("matches the representative sessionId and every fan-in group member", () => {
    const group = makePolicy("pol_group", ["sess_b", "sess_c"])
    expect(policyWatchesSession(group, "sess_b")).toBe(true) // repr + member
    expect(policyWatchesSession(group, "sess_c")).toBe(true) // member only
    expect(policyWatchesSession(group, "sess_a")).toBe(false)
  })

  it("matches a legacy single-session policy on its sessionId", () => {
    expect(policyWatchesSession(makePolicy("pol_solo", ["sess_a"]), "sess_a")).toBe(true)
  })
})

// ── policy_list (MCP) ─────────────────────────────────────────────────

describe("policy_list — optional sessionId filter", () => {
  it("without sessionId, lists everything (behaviour unchanged)", async () => {
    const client = await mcpClient({ supervisor: stubSupervisor(POLICIES) })
    expect(ids(await listPolicies(client))).toEqual(["pol_solo", "pol_group", "pol_other"])
    await client.close()
  })

  it("with sessionId, lists only the policies watching that session", async () => {
    const client = await mcpClient({ supervisor: stubSupervisor(POLICIES) })
    expect(ids(await listPolicies(client, "sess_a"))).toEqual(["pol_solo"])
    await client.close()
  })

  it("matches a fan-in group member, not just the representative sessionId", async () => {
    const client = await mcpClient({ supervisor: stubSupervisor(POLICIES) })
    // sess_c is sessionIds[1] — invisible to a `sessionId`-only comparison.
    expect(ids(await listPolicies(client, "sess_c"))).toEqual(["pol_group"])
    await client.close()
  })

  it("returns an empty list for a session no policy watches", async () => {
    const client = await mcpClient({ supervisor: stubSupervisor(POLICIES) })
    expect(await listPolicies(client, "sess_unknown")).toEqual([])
    await client.close()
  })
})

// ── Composition with WP6 subtree scoping ──────────────────────────────

describe("policy_list — sessionId filter composes with subtree scoping", () => {
  /** Registry holding `owner → child`, plus an unrelated `stranger`. The
   *  policies are re-pointed at those real ids so `collectSubtree` decides. */
  function subtreeFixture(): {
    registry: SessionsRegistry
    ownerId: string
    childId: string
    strangerId: string
    policies: PolicyRunState[]
  } {
    const registry = createSessionsRegistry({ persist: false })
    const owner = spawnNode(registry)
    const child = spawnNode(registry, owner.id, 1)
    const stranger = spawnNode(registry)
    return {
      registry,
      ownerId: owner.id,
      childId: child.id,
      strangerId: stranger.id,
      policies: [
        makePolicy("pol_child", [child.id]),
        makePolicy("pol_stranger", [stranger.id]),
      ],
    }
  }

  it("a scoped caller filtering on its own subtree sees the match", async () => {
    const f = subtreeFixture()
    const client = await mcpClient({
      supervisor: stubSupervisor(f.policies),
      registry: f.registry,
      callerScope: { ownerSessionId: f.ownerId },
    })
    expect(ids(await listPolicies(client, f.childId))).toEqual(["pol_child"])
    await client.close()
  })

  it("a scoped caller cannot reach around the subtree boundary with sessionId", async () => {
    const f = subtreeFixture()
    const client = await mcpClient({
      supervisor: stubSupervisor(f.policies),
      registry: f.registry,
      callerScope: { ownerSessionId: f.ownerId },
    })
    // pol_stranger exists and genuinely watches strangerId — the filter alone
    // would match it. Subtree scoping runs first and it is out of scope, so
    // the filter can only narrow what's left: nothing.
    expect(await listPolicies(client, f.strangerId)).toEqual([])
    // Unfiltered, the same caller sees only its own subtree — the filter
    // never widened that.
    expect(ids(await listPolicies(client))).toEqual(["pol_child"])
    await client.close()
  })

  it("an unbound scope (no ownerSessionId) still sees nothing, filter or not", async () => {
    const f = subtreeFixture()
    const client = await mcpClient({
      supervisor: stubSupervisor(f.policies),
      registry: f.registry,
      callerScope: {},
    })
    expect(await listPolicies(client, f.childId)).toEqual([])
    expect(await listPolicies(client)).toEqual([])
    await client.close()
  })
})

// ── policy_list pagination (PR-7) ─────────────────────────────────────

/** Paginated envelope — only returned when `limit`/`cursor` is supplied. */
interface PolicyPage {
  items: PolicyRunState[]
  nextCursor?: string
  total?: number
}

function parseToolPage(result: CallToolResult): PolicyPage {
  const blocks = "content" in result ? result.content : undefined
  if (!Array.isArray(blocks)) throw new Error("tool result has no content array")
  for (const block of blocks) {
    const text = blockText(block)
    if (text === undefined) continue
    const parsed: PolicyPage = JSON.parse(text)
    if (!Array.isArray(parsed.items)) throw new Error(`policy_list page has no items array: ${text}`)
    return parsed
  }
  throw new Error("tool returned no text content")
}

async function listPolicyPage(
  client: Client,
  args: { limit: number; cursor?: string; sessionId?: string },
): Promise<PolicyPage> {
  return parseToolPage(await client.callTool({ name: "policy_list", arguments: args }))
}

describe("policy_list — limit/cursor pagination (additive)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const client = await mcpClient({ supervisor: stubSupervisor(POLICIES) })
    const unpaginated = ids(await listPolicies(client))
    expect(unpaginated).toHaveLength(3)
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = await listPolicyPage(client, { limit: 2, ...(cursor ? { cursor } : {}) })
      expect(page.total).toBe(3)
      union.push(...ids(page.items))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(unpaginated)
    await client.close()
  })

  it("a scoped caller's page total reflects subtree scoping — paginate runs AFTER scoping", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const owner = spawnNode(registry)
    const child = spawnNode(registry, owner.id, 1)
    const stranger = spawnNode(registry)
    const policies = [
      makePolicy("pol_child", [child.id]),
      makePolicy("pol_stranger", [stranger.id]),
    ]
    const client = await mcpClient({
      supervisor: stubSupervisor(policies),
      registry,
      callerScope: { ownerSessionId: owner.id },
    })
    // Scoped view = pol_child only; the stranger's policy is removed by
    // scoping BEFORE pagination ever sees the rows.
    const unpaginated = ids(await listPolicies(client))
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = await listPolicyPage(client, { limit: 1, ...(cursor ? { cursor } : {}) })
      expect(page.total).toBe(1)
      union.push(...ids(page.items))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(unpaginated)
    await client.close()
  })
})

// ── GET /policies?sessionId= (REST) ───────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
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

async function withServer(
  supervisor: CompletionPolicySupervisor,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () =>
      (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: createSessionsRegistry({ persist: false }),
    supervisor,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("GET /policies?sessionId=", () => {
  async function get(base: string, query = ""): Promise<PolicyRunState[]> {
    const res = await fetch(`${base}/policies${query}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { policies: PolicyRunState[] }
    return body.policies
  }

  it("without the param, returns the full list (behaviour unchanged)", async () => {
    await withServer(stubSupervisor(POLICIES), async base => {
      expect(ids(await get(base))).toEqual(["pol_solo", "pol_group", "pol_other"])
    })
  })

  it("narrows to the policies watching that session, fan-in members included", async () => {
    await withServer(stubSupervisor(POLICIES), async base => {
      expect(ids(await get(base, "?sessionId=sess_a"))).toEqual(["pol_solo"])
      expect(ids(await get(base, "?sessionId=sess_c"))).toEqual(["pol_group"])
    })
  })

  it("returns an empty list for a session no policy watches", async () => {
    await withServer(stubSupervisor(POLICIES), async base => {
      expect(await get(base, "?sessionId=sess_unknown")).toEqual([])
    })
  })
})
