/**
 * session_list is bounded by default (50 rows + nextCursor) and can read
 * known sessions by id without scanning the whole list.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type PtyFactory } from "../sessions.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  SessionDescriptor,
  SessionsRegistry,
} from "../sessions.js"

const fakePtyFactory: PtyFactory = () => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  close: () => Promise<void>
}> {
  const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd() })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, close: () => client.close() }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

interface Page {
  items: SessionDescriptor[]
  nextCursor?: string
  total?: number
}

interface Page {
  items: SessionDescriptor[]
  nextCursor?: string
  total?: number
}

describe("session_list default bound + ids filter", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "session-list-bound-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const spawn = (registry: SessionsRegistry, n: number): SessionDescriptor[] =>
    Array.from({ length: n }, () =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      }),
    )

  it("an unpaged call returns 50 rows plus truncated/total/nextCursor, and the cursor reaches the rest", async () => {
    const { client, registry, close } = await buildHarness()
    spawn(registry, 53)
    try {
      const first = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: {} })),
      ) as { sessions: SessionDescriptor[]; total: number; truncated?: boolean; nextCursor?: string }
      expect(first.sessions).toHaveLength(50)
      expect(first.total).toBe(53)
      expect(first.truncated).toBe(true)
      expect(first.nextCursor).toBeTruthy()

      const rest = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_list",
            arguments: { limit: 50, cursor: first.nextCursor },
          }),
        ),
      ) as Page
      expect(rest.items).toHaveLength(3)
      expect(rest.nextCursor).toBeUndefined()
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("a short list keeps the plain wrapper with no truncated marker", async () => {
    const { client, registry, close } = await buildHarness()
    spawn(registry, 3)
    try {
      const res = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: {} })),
      ) as { sessions: SessionDescriptor[]; truncated?: boolean }
      expect(res.sessions).toHaveLength(3)
      expect(res.truncated).toBeUndefined()
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("ids returns exactly the named sessions, as a string or a list", async () => {
    const { client, registry, close } = await buildHarness()
    const rows = spawn(registry, 4)
    const [a, b] = [rows[0]!.id, rows[2]!.id]
    try {
      const one = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: { ids: a } })),
      ) as { sessions: SessionDescriptor[] }
      expect(one.sessions.map(s => s.id)).toEqual([a])

      const two = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: { ids: [a, b, "sess_missing"] } })),
      ) as { sessions: SessionDescriptor[] }
      expect(two.sessions.map(s => s.id).sort()).toEqual([a, b].sort())
    } finally {
      await close()
      registry.shutdown()
    }
  })
})
