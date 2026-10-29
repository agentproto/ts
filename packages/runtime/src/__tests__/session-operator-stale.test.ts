/**
 * The stale flag of AIP-46 §Operator binding's digest: a session whose recorded
 * `operatorDigest` differs from the current digest the caller supplies is
 * reported by `session_list` and `session_role_refresh`. The daemon has no
 * operator resolver, so the caller (the host that composes the agent) brings
 * the current digest.
 */

import { describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const fakeSession = (): AgentSessionLike => ({
  sessionId: "acp_operator_stale",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {})
  },
  async cancel() {},
  async close() {},
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolJson = (result: any): any => JSON.parse(result.content[0].text)

async function harness() {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  const resolveAgentAdapter: AgentAdapterResolver = async () => {
    throw new Error("no adapter needed")
  }
  registerSessionTools(server, { workspace: process.cwd(), registry, resolveAgentAdapter, ptyEnabled: false })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  const spawn = (extra: Record<string, unknown>) =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeSession(),
      adapterSlug: "mock",
      ...extra,
    })
  return { client, registry, spawn }
}

describe("session_list operator stale flag", () => {
  it("flags a session whose recorded digest differs from the supplied current one", async () => {
    const { client, registry, spawn } = await harness()
    const stale = spawn({ operator: "operator:cto", operatorDigest: "sha256:old" })
    const fresh = spawn({ operator: "operator:cfo", operatorDigest: "sha256:same" })
    const plain = spawn({})
    const body = toolJson(
      await client.callTool({
        name: "session_list",
        arguments: { operatorDigests: { "operator:cto": "sha256:new", "ws://operators/cfo": "sha256:same" } },
      }),
    )
    const byId = new Map<string, any>(body.sessions.map((s: any) => [s.id, s]))
    expect(byId.get(stale.id)).toMatchObject({ operator: "operator:cto", operatorStale: true })
    expect(byId.get(fresh.id)).toMatchObject({ operator: "operator:cfo", operatorStale: false })
    expect(byId.get(plain.id)?.operator).toBeUndefined()
    expect(byId.get(plain.id)?.operatorStale).toBeUndefined()
    registry.shutdown()
  })

  it("reports nothing about staleness when no current digest is supplied", async () => {
    const { client, registry, spawn } = await harness()
    const s = spawn({ operator: "operator:cto", operatorDigest: "sha256:old" })
    const body = toolJson(await client.callTool({ name: "session_list", arguments: {} }))
    const row = body.sessions.find((r: any) => r.id === s.id)
    expect(row.operator).toBe("operator:cto")
    expect(row.operatorStale).toBeUndefined()
    registry.shutdown()
  })
})

describe("session_role_refresh operator stale flag", () => {
  it("reports a recorded digest that differs from the supplied one", async () => {
    const { client, registry, spawn } = await harness()
    const s = spawn({ operator: "operator:cto", operatorDigest: "sha256:old" })
    const body = toolJson(
      await client.callTool({
        name: "session_role_refresh",
        arguments: { idOrName: s.id, operatorDigest: "sha256:new" },
      }),
    )
    expect(body).toMatchObject({
      operator: "operator:cto",
      operatorStale: true,
      recordedOperatorDigest: "sha256:old",
      currentOperatorDigest: "sha256:new",
    })
    registry.shutdown()
  })

  it("reports not stale when the digests match", async () => {
    const { client, registry, spawn } = await harness()
    const s = spawn({ operator: "operator:cto", operatorDigest: "sha256:same" })
    const body = toolJson(
      await client.callTool({
        name: "session_role_refresh",
        arguments: { idOrName: s.id, operatorDigest: "sha256:same" },
      }),
    )
    expect(body.operatorStale).toBe(false)
    registry.shutdown()
  })
})
