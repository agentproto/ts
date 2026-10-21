/**
 * One messaging ACL for every entry point (permissions.ts `decide()`):
 * `message_send` (MCP), `POST /sessions/:id/messages` (HTTP, both the
 * `?callerSessionId=` query and the `x-agentproto-caller-session-id`
 * header), `message_parent` (MCP) and the box parent relay
 * (`POST /relay/parent-message`) all reach the same allow/deny and the
 * same relation as `decide()` for every ordered pair of a small forest,
 * under both `allowSiblings` settings.
 *
 * Before this change the HTTP route ignored `allowSiblings` (a sibling was
 * refused there while `message_send` let it through), ignored the caller
 * header (a header-identified session was treated as the human operator)
 * and never granted `agentInterrupt` to a session sender.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { DEFAULT_MESSAGING_DEFAULTS, type ResolvedMessagingDefaults } from "../messaging-defaults.js"
import { decide } from "../permissions.js"
import {
  clearParentRelayGrants,
  mintParentRelayGrant,
  PARENT_RELAY_PATH,
  PARENT_RELAY_TOKEN_HEADER,
} from "../parent-relay.js"

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

const conversations = {
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
} as unknown as ConversationStore
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} } as unknown as HeartbeatRunner

function idle(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

type Body = Record<string, unknown> & { isError: boolean }

async function toolsAs(
  registry: SessionsRegistry,
  callerSessionId: string,
  policy: ResolvedMessagingDefaults,
) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry,
    callerSessionId,
    messagingAllowSiblings: policy.allowSiblings,
    messagingAgentInterrupt: policy.agentInterrupt,
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(ct)
  return {
    call: async (name: string, args: Record<string, unknown>): Promise<Body> => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      const text = r.content[0]!.text
      let body: Record<string, unknown>
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        body = { raw: text }
      }
      return { ...body, isError: r.isError === true }
    },
    close: () => client.close(),
  }
}

describe("messaging ACL parity across every entry point", () => {
  let tmp: string
  let registry: SessionsRegistry
  let policy: ResolvedMessagingDefaults
  let http: { stop: () => Promise<void> }
  let base: string
  let nodes: Record<string, SessionDescriptor>

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "acl-parity-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    policy = { ...DEFAULT_MESSAGING_DEFAULTS }
    const spawn = (label: string, parentSessionId?: string) =>
      registry.spawnAgent({
        workspaceSlug: "w",
        cwd: "/tmp",
        agentSession: idle(label),
        adapterSlug: "fake",
        label,
        ...(parentSessionId ? { parentSessionId, depth: 1 } : {}),
      })
    // P ─┬─ A ── G      S (stranger root)
    //    └─ B
    const P = spawn("P")
    const A = spawn("A", P.id)
    const B = spawn("B", P.id)
    const G = spawn("G", A.id)
    const S = spawn("S")
    nodes = { P, A, B, G, S }
    const port = await freePort()
    http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
      resolveMessagingDefaults: async () => policy,
    })
    base = `http://127.0.0.1:${port}`
  })
  afterEach(async () => {
    await http.stop()
    registry.shutdown()
    clearParentRelayGrants()
    rmSync(tmp, { recursive: true, force: true })
  })

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  for (const allowSiblings of [false, true]) {
    it(`message_send, HTTP ?callerSessionId=, HTTP header and decide() agree on every pair (allowSiblings=${allowSiblings})`, async () => {
      policy = { ...policy, allowSiblings }
      const ids = Object.keys(nodes)
      const disagreements: string[] = []
      for (const from of ids) {
        const tools = await toolsAs(registry, nodes[from]!.id, policy)
        try {
          for (const toName of ids) {
            const sender = nodes[from]!
            const recipient = nodes[toName]!
            const d = decide({ kind: "session", session: sender }, "session.message", { kind: "session", session: recipient }, {
              messaging: { allowSiblings },
            })
            const tool = await tools.call("message_send", { to: recipient.id, text: `${from}->${toName}`, urgency: "fyi" })
            const viaQuery = await post(`/sessions/${recipient.id}/messages?callerSessionId=${sender.id}`, {
              text: `${from}->${toName}`,
              urgency: "fyi",
            })
            const viaHeader = await post(
              `/sessions/${recipient.id}/messages`,
              { text: `${from}->${toName}`, urgency: "fyi" },
              { "x-agentproto-caller-session-id": sender.id },
            )
            const queryBody = (await viaQuery.json()) as Record<string, unknown>
            const headerBody = (await viaHeader.json()) as Record<string, unknown>
            const outcome = {
              decide: d.allow,
              tool: !tool.isError,
              query: viaQuery.status === 200,
              header: viaHeader.status === 200,
            }
            if (new Set(Object.values(outcome)).size !== 1) {
              disagreements.push(`${from}->${toName}: ${JSON.stringify(outcome)}`)
            }
            if (d.allow) {
              expect(tool.relation).toBe(d.relation)
              expect(queryBody.relation).toBe(d.relation)
              expect(headerBody.relation).toBe(d.relation)
            } else {
              expect(viaQuery.status).toBe(403)
              expect(viaHeader.status).toBe(403)
              expect(tool.error).toBe("forbidden_recipient")
            }
          }
        } finally {
          await tools.close()
        }
      }
      expect(disagreements).toEqual([])
    })
  }

  it("sibling with allowSiblings=true: the HTTP route now agrees with message_send (was 403 before)", async () => {
    policy = { ...policy, allowSiblings: true }
    const { A, B } = nodes as Record<string, SessionDescriptor>
    const r = await post(`/sessions/${B!.id}/messages?callerSessionId=${A!.id}`, { text: "hi sibling", urgency: "fyi" })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ relation: "sibling" })
  })

  it("a header-identified session is held to the tree ACL, not treated as the operator (was 200 as human before)", async () => {
    const { S, G } = nodes as Record<string, SessionDescriptor>
    const r = await post(`/sessions/${G!.id}/messages`, { text: "x", urgency: "fyi" }, { "x-agentproto-caller-session-id": S!.id })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: "forbidden_recipient", rule: "tree.none" })
  })

  it("an anonymous local caller still reaches every session, as the operator, with interrupt", async () => {
    for (const n of Object.values(nodes)) {
      const r = await post(`/sessions/${n.id}/messages`, { text: "operator note", urgency: "interrupt" })
      expect(r.status).toBe(200)
      // Idle recipient: the turn starts with the tier asked for, so a granted
      // interrupt reads back as "interrupt" (an un-granted one as "steer").
      expect(await r.json()).toMatchObject({ relation: "human", urgencyApplied: "interrupt" })
      const d = decide({ kind: "operator", via: "anonymous-local" }, "session.message.interrupt", { kind: "session", session: n })
      expect(d.allow).toBe(true)
    }
  })

  for (const agentInterrupt of ["deny", "allow"] as const) {
    it(`a session sender's interrupt follows agentInterrupt=${agentInterrupt} on the tool, the HTTP route and the relay`, async () => {
      policy = { ...policy, agentInterrupt }
      const expected = agentInterrupt === "allow" ? "interrupt" : "steer"
      const { P, A } = nodes as Record<string, SessionDescriptor>
      const tools = await toolsAs(registry, A!.id, policy)
      try {
        const viaTool = await tools.call("message_send", { to: P!.id, text: "t", urgency: "interrupt" })
        expect(viaTool.urgencyApplied).toBe(expected)
        const viaParent = await tools.call("message_parent", { message: "p", interrupt: true })
        expect(viaParent.urgencyApplied).toBe(expected)
      } finally {
        await tools.close()
      }
      const viaHttp = await post(`/sessions/${P!.id}/messages?callerSessionId=${A!.id}`, { text: "h", urgency: "interrupt" })
      expect(((await viaHttp.json()) as Record<string, unknown>).urgencyApplied).toBe(expected)
      const grant = mintParentRelayGrant({ parentSessionId: P!.id, boxSessionId: "box-1", url: base })
      const viaRelay = await post(
        PARENT_RELAY_PATH,
        { message: "r", urgency: "interrupt" },
        { [PARENT_RELAY_TOKEN_HEADER]: grant.token },
      )
      expect(viaRelay.status).toBe(200)
      expect(((await viaRelay.json()) as Record<string, unknown>).urgencyApplied).toBe(expected)
    })
  }

  it("message_parent and the relay deliver as `child`, exactly the relation decide() grants", async () => {
    const { P, G, A } = nodes as Record<string, SessionDescriptor>
    // message_parent from G reaches A (its recorded parent) only.
    const tools = await toolsAs(registry, G!.id, policy)
    try {
      const r = await tools.call("message_parent", { message: "up", urgency: "fyi" })
      expect(r.isError).toBe(false)
      expect(r.parentSessionId).toBe(A!.id)
      expect(
        decide({ kind: "session", session: G! }, "session.message", { kind: "session", session: A! }).relation,
      ).toBe("child")
    } finally {
      await tools.close()
    }
    const inboxA = registry.listInbox(A!.id) ?? []
    expect(inboxA.map(m => m.from.relation)).toEqual(["child"])

    // The relay: the grant names P, so P gets a `child` message.
    const grant = mintParentRelayGrant({ parentSessionId: P!.id, boxSessionId: "box-2", url: base })
    const relayed = await post(PARENT_RELAY_PATH, { message: "from the box", urgency: "fyi" }, {
      [PARENT_RELAY_TOKEN_HEADER]: grant.token,
    })
    expect(relayed.status).toBe(200)
    const inboxP = registry.listInbox(P!.id) ?? []
    expect(inboxP.at(-1)).toMatchObject({ text: "from the box", from: { relation: "child", sessionId: "box-2" } })
    expect(
      decide({ kind: "relay", boxSessionId: "box-2", parentSessionId: P!.id }, "session.message", {
        kind: "session",
        session: P!,
      }).allow,
    ).toBe(true)
  })

  it("permissions_explain answers with the same decision the entry points enforce", async () => {
    policy = { ...policy, allowSiblings: false }
    const { A, B, P } = nodes as Record<string, SessionDescriptor>
    const tools = await toolsAs(registry, A!.id, policy)
    try {
      const sib = await tools.call("permissions_explain", { action: "session.message", sessionId: B!.id })
      expect(sib).toMatchObject({
        ok: true,
        principal: { kind: "session", sessionId: A!.id },
        decision: { allow: false, rule: "messaging.allowSiblings", relation: "sibling", authoritative: true },
      })
      const up = await tools.call("permissions_explain", { action: "session.message", sessionId: P!.id })
      expect(up).toMatchObject({ decision: { allow: true, relation: "child", rule: "tree.child" } })
      // A session may not introspect an ancestor or an unrelated session...
      const asP = await tools.call("permissions_explain", { action: "session.drive", sessionId: B!.id, asSessionId: P!.id })
      expect(asP).toMatchObject({ isError: true, error: "forbidden_as_session" })
      const asS = await tools.call("permissions_explain", { action: "session.drive", asSessionId: nodes.S!.id })
      expect(asS).toMatchObject({ isError: true, error: "forbidden_as_session" })
      // ...but may explain a session in its own subtree.
      const asG = await tools.call("permissions_explain", { action: "session.message", sessionId: A!.id, asSessionId: nodes.G!.id })
      expect(asG).toMatchObject({ principal: { sessionId: nodes.G!.id }, decision: { allow: true, relation: "child" } })
      // An interrupt is never reported as allowed where the message is refused.
      policy = { ...policy, agentInterrupt: "allow" }
      const toolsAllow = await toolsAs(registry, nodes.S!.id, policy)
      try {
        const msg = await toolsAllow.call("permissions_explain", { action: "session.message", sessionId: A!.id })
        const intr = await toolsAllow.call("permissions_explain", { action: "session.message.interrupt", sessionId: A!.id })
        expect(msg).toMatchObject({ decision: { allow: false } })
        expect(intr).toMatchObject({ decision: { allow: false, rule: "session.message" } })
      } finally {
        await toolsAllow.close()
      }
      const notRouted = await tools.call("permissions_explain", { action: "config.write" })
      expect(notRouted).toMatchObject({ decision: { authoritative: false, rule: "not-routed" }, action: { routed: false } })
    } finally {
      await tools.close()
    }
  })
})
