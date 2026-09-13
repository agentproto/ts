/**
 * PR-2 additive pagination for the session list tools.
 *
 * When `limit`/`cursor` are supplied, the response becomes the shared
 * paginated envelope `{ items, nextCursor?, total }` (via `paginate` +
 * `toolText`). Without either param the output keeps the legacy
 * `{ sessions: [...] }` wrapper. PR-10: rows are COMPACT by default
 * (both branches); `full: true` / `compact: false` is the escape hatch
 * to the unprojected SessionDescriptor, and `fields` is a generic
 * per-item allowlist.
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

/** Walk pages of `limit` until nextCursor is absent; return the union. */
async function walk(
  client: Client,
  tool: string,
  limit: number,
  extraArgs: Record<string, unknown> = {},
): Promise<Page["items"]> {
  const union: Page["items"] = []
  let cursor: string | undefined
  do {
    const result = await client.callTool({
      name: tool,
      arguments: {
        limit,
        ...(cursor ? { cursor } : {}),
        ...extraArgs,
      },
    })
    const page = JSON.parse(textOf(result)) as Page
    union.push(...page.items)
    cursor = page.nextCursor
    expect(page.total, "total present on every page").toBeGreaterThan(0)
  } while (cursor)
  return union
}

describe("session list pagination (PR-2, additive)", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "session-list-pagination-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("session_list: page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const { client, registry, close } = await buildHarness()
    const spawned: SessionDescriptor[] = []
    for (let i = 0; i < 5; i++) {
      spawned.push(
        registry.spawnAgent({
          workspaceSlug: "default",
          cwd: workspace,
          agentSession: fakeAgentSession("agent"),
          adapterSlug: "fake",
        }),
      )
    }
    try {
      const unpaginated = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: {} })),
      ) as { sessions: SessionDescriptor[] }
      expect(unpaginated.sessions).toHaveLength(5)

      const union = await walk(client, "session_list", 2)
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("command_list: page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const { client, registry, close } = await buildHarness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        registry.recordCommand({
          workspaceSlug: "default",
          cwd: workspace,
          command: `cmd-${i}`,
          args: [],
          exitCode: 0,
          signal: null,
          durationMs: 5,
          stdout: "",
          stderr: "",
        }).id,
      )
    }
    try {
      const unpaginated = JSON.parse(
        textOf(await client.callTool({ name: "command_list", arguments: {} })),
      ) as { sessions: SessionDescriptor[] }
      expect(unpaginated.sessions).toHaveLength(5)

      const union = await walk(client, "command_list", 2)
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("terminal_sessions_list: page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const { client, registry, close } = await buildHarness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        registry.spawnPty({
          workspaceSlug: "default",
          cwd: workspace,
          argv: ["bash"],
          cols: 80,
          rows: 24,
        }).id,
      )
    }
    try {
      const unpaginated = JSON.parse(
        textOf(
          await client.callTool({ name: "terminal_sessions_list", arguments: {} }),
        ),
      ) as { sessions: SessionDescriptor[] }
      expect(unpaginated.sessions).toHaveLength(5)

      const union = await walk(client, "terminal_sessions_list", 2)
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("agent_sessions_list: page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const { client, registry, close } = await buildHarness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        registry.spawnAgent({
          workspaceSlug: "default",
          cwd: workspace,
          agentSession: fakeAgentSession("agent"),
          adapterSlug: "fake",
        }).id,
      )
    }
    try {
      const unpaginated = JSON.parse(
        textOf(
          await client.callTool({ name: "agent_sessions_list", arguments: {} }),
        ),
      ) as { sessions: SessionDescriptor[] }
      expect(unpaginated.sessions).toHaveLength(5)

      const union = await walk(client, "agent_sessions_list", 2)
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("without limit/cursor the output keeps the legacy {sessions:[...]} wrapper, rows COMPACT by default (PR-10)", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    try {
      const result = await client.callTool({ name: "session_list", arguments: {} })
      const parsed = JSON.parse(textOf(result)) as {
        sessions?: Array<Record<string, unknown>>
        items?: unknown[]
      }
      expect(parsed.sessions).toBeDefined()
      expect(parsed.items).toBeUndefined()

      // Compact projection: identity fields present, bulky echo dropped.
      const row = parsed.sessions?.[0]
      expect(row).toBeDefined()
      expect(row?.id).toBeDefined()
      expect(row?.status).toBeDefined()
      expect(row?.kind).toBe("agent-cli")
      expect(row?.adapterSlug).toBe("fake")
      expect(row?.cwd).toBe(workspace)
      expect(row).not.toHaveProperty("workspaceSlug")
      expect(row).not.toHaveProperty("pid")
      expect(row).not.toHaveProperty("argv")
      expect(row).not.toHaveProperty("contextContinuity")
      expect(row).not.toHaveProperty("availableCommands")
      expect(row).not.toHaveProperty("watcherDetails")
      expect(row).not.toHaveProperty("agentsMd")
      expect(row).not.toHaveProperty("auth")
      expect(row).not.toHaveProperty("accessProfile")
      expect(row).not.toHaveProperty("adapterConfigDir")

      // No pagination fields in the wrapper.
      const text = textOf(result)
      expect(text).not.toContain("\n")
      expect(text).not.toContain('"nextCursor"')
      expect(text).not.toContain('"total"')
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("full:true (and compact:false) is the escape hatch to the unprojected descriptor", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    try {
      for (const extra of [{ full: true }, { compact: false }]) {
        const result = await client.callTool({
          name: "session_list",
          arguments: { ...extra },
        })
        const parsed = JSON.parse(textOf(result)) as {
          sessions?: Array<Record<string, unknown>>
        }
        const row = parsed.sessions?.[0]
        expect(row?.workspaceSlug).toBe("default")
        expect(row?.startedAt).toBeDefined()
        expect(row).not.toHaveProperty("$$compact")
      }
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("paginated rows are compact by default (PR-10); full:true restores the full record", async () => {
    const { client, registry, close } = await buildHarness()
    for (let i = 0; i < 2; i++) {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
    }
    try {
      const compactPage = JSON.parse(
        textOf(await client.callTool({ name: "session_list", arguments: { limit: 2 } })),
      ) as Page
      expect(compactPage.items).toHaveLength(2)
      for (const item of compactPage.items) {
        expect(item.workspaceSlug).toBeUndefined()
        expect(item.id).toBeDefined()
      }

      const fullPage = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_list",
            arguments: { limit: 2, full: true },
          }),
        ),
      ) as Page
      for (const item of fullPage.items) {
        expect(item.workspaceSlug).toBe("default")
      }
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("fields is a generic per-item allowlist on the paginated envelope", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    try {
      const result = await client.callTool({
        name: "session_list",
        arguments: { limit: 1, full: true, fields: ["id", "status"] },
      })
      const page = JSON.parse(textOf(result)) as {
        items: Array<Record<string, unknown>>
      }
      expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(["id", "status"])
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("full:true is accepted and does not change the paginated envelope", async () => {
    const { client, registry, close } = await buildHarness()
    for (let i = 0; i < 3; i++) {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: workspace,
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
    }
    try {
      const result = await client.callTool({
        name: "session_list",
        arguments: { limit: 2, full: true },
      })
      const page = JSON.parse(textOf(result)) as Page
      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeDefined()
      expect(page.total).toBe(3)
    } finally {
      await close()
      registry.shutdown()
    }
  })
})
