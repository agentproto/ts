import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"

/**
 * MCP surface for the find/recap feature: `session_search` mirrors
 * `sessions find` (id-prefix/label/cwd matching, compact session_list shape),
 * `session_recap` returns the resume shape, and an unknown id refuses
 * gracefully (an MCP error result, not a crash). Hermetic.
 */

let tmp: string
let persistPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-search-mcp-"))
  persistPath = join(tmp, "sessions.json")
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeAgent(reply: string): AgentSessionLike {
  return {
    sessionId: "acp-1",
    async *send() {
      yield { kind: "text-delta", text: reply }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function harness(): Promise<{
  client: Client
  reg: ReturnType<typeof createSessionsRegistry>
  close: () => Promise<void>
}> {
  const reg = createSessionsRegistry({ persistPath })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry: reg, workspace: tmp })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, reg, close: () => client.close() }
}

const json = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
  JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}")

describe("session_search / session_recap MCP tools", () => {
  it("session_search matches by label, cwd and id prefix and returns compact rows", async () => {
    const { client, reg, close } = await harness()
    reg.spawnAgent({ id: "sess_aaa111", workspaceSlug: "default", cwd: join(tmp, "projA"), adapterSlug: "claude-code", agentSession: makeAgent("a"), label: "chat 16:56:28" })
    reg.spawnAgent({ id: "sess_bbb222", workspaceSlug: "default", cwd: join(tmp, "projB"), adapterSlug: "hermes", agentSession: makeAgent("b"), title: "Fix login" })

    const byLabel = json(await client.callTool({ name: "session_search", arguments: { query: "16:56" } }))
    expect((byLabel.sessions as Array<{ id: string }>).map(s => s.id)).toEqual(["sess_aaa111"])

    const byCwd = json(await client.callTool({ name: "session_search", arguments: { query: "projB" } }))
    expect((byCwd.sessions as Array<{ id: string }>).map(s => s.id)).toEqual(["sess_bbb222"])

    const byPrefix = json(await client.callTool({ name: "session_search", arguments: { query: "sess_bbb" } }))
    expect((byPrefix.sessions as Array<{ id: string }>).map(s => s.id)).toEqual(["sess_bbb222"])

    // Compact session_list shape: id/kind/status/adapterSlug present.
    const row = (byPrefix.sessions as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({ id: "sess_bbb222", kind: "agent-cli", status: "running", adapterSlug: "hermes" })

    await close()
    reg.shutdown()
  })

  it("session_recap returns the resume shape after a turn", async () => {
    const { client, reg, close } = await harness()
    reg.spawnAgent({ id: "sess_recap1", workspaceSlug: "default", cwd: tmp, adapterSlug: "claude-code", agentSession: makeAgent("the answer"), label: "recap me" })
    await reg.sendPrompt("sess_recap1", "the question")
    reg.flushSessionIndexes()

    const recap = json(await client.callTool({ name: "session_recap", arguments: { id: "sess_recap1", last: 5 } }))
    expect(recap).toMatchObject({ id: "sess_recap1", status: "running", alive: true, label: "recap me", adapter: "claude-code", turnsCompleted: 1 })
    expect((recap.prompts as Array<{ text: string }>).map(p => p.text)).toContain("the question")
    expect(recap.lastOutputText).toBe("the answer")
    expect(Array.isArray(recap.children)).toBe(true)

    await close()
    reg.shutdown()
  })

  it("session_recap refuses gracefully on an unknown id", async () => {
    const { client, reg, close } = await harness()
    const result = await client.callTool({ name: "session_recap", arguments: { id: "sess_nope" } })
    expect(result.isError).toBe(true)
    await close()
    reg.shutdown()
  })
})
