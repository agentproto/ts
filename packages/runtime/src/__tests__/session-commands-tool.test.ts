/**
 * `session_commands` — the paginated slash-command list.
 *
 * The list a harness advertises can be long (60+ entries on a skill-heavy
 * harness) and used to travel inside every `agent_start` answer. It now
 * travels page by page: `limit`/`cursor` walk it, `name` (prefix) and
 * `scope` narrow it, `fields` picks the row keys and `full:true` brings the
 * harness' own `input`/`_meta` blobs back.
 */

import { describe, it, expect } from "vitest"
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

async function* neverResolving(): AsyncIterable<AgentStreamEvent> {
  await new Promise(() => {}) // never resolves — keeps the session "running"
}

function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_1`,
    send: neverResolving,
    async cancel() {},
    async close() {},
  }
}

/** 60 slash-commands, half of them in the "project" scope. */
const COMMANDS = Array.from({ length: 60 }, (_, i) => ({
  name: `/skill-${i}`,
  description: `Skill ${i} description lorem ipsum dolor sit amet consectetur`,
  input: { hint: `/skill-${i} [args]` },
  _meta: { scope: i % 2 === 0 ? "user" : "project" },
}))

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  sessionId: string
  close: () => Promise<void>
}> {
  const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd() })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  const desc: SessionDescriptor = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fakeAgentSession("agent"),
    adapterSlug: "fake",
  })
  desc.availableCommands = COMMANDS

  return { client, registry, sessionId: desc.id, close: () => client.close() }
}

function textOf(result: unknown): string {
  return (result as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "{}"
}

interface CommandRow {
  name: string
  description?: string
  hint?: string
  scope?: string
  input?: { hint?: string } | null
  _meta?: { scope?: string }
}

interface Page {
  items: CommandRow[]
  nextCursor?: string
  total?: number
}

/** Walk pages of `limit` until nextCursor is absent; return the union. */
async function walk(
  client: Client,
  sessionId: string,
  limit: number,
  extraArgs: Record<string, unknown> = {},
): Promise<CommandRow[]> {
  const union: CommandRow[] = []
  let cursor: string | undefined
  do {
    const result = await client.callTool({
      name: "session_commands",
      arguments: {
        sessionId,
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

describe("session_commands", () => {
  it("pages through the 60 commands with no duplicate and no gap", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const union = await walk(client, sessionId, 17)
      expect(union).toHaveLength(60)
      expect(new Set(union.map(c => c.name)).size).toBe(60)
      expect(union.map(c => c.name)).toEqual(COMMANDS.map(c => c.name))
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("filters by name prefix", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const rows = await walk(client, sessionId, 50, { name: "/skill-1" })
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(r => r.name.startsWith("/skill-1"))).toBe(true)
      // /skill-1, /skill-1x… — the exact prefix set of the reference list.
      expect(rows.map(r => r.name)).toEqual(
        COMMANDS.filter(c => c.name.startsWith("/skill-1")).map(c => c.name),
      )
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("filters by scope", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const rows = await walk(client, sessionId, 50, { scope: "project" })
      expect(rows).toHaveLength(30)
      expect(rows.every(r => r.scope === "project")).toBe(true)
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("serves compact rows by default and the raw entry with full:true", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const compact = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_commands",
            arguments: { sessionId, limit: 5 },
          }),
        ),
      ) as Page
      expect(compact.items[0]).toEqual({
        name: "/skill-0",
        description: "Skill 0 description lorem ipsum dolor sit amet consectetur",
        hint: "/skill-0 [args]",
        scope: "user",
      })

      const full = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_commands",
            arguments: { sessionId, limit: 5, full: true },
          }),
        ),
      ) as Page
      expect(full.items[0]?.input).toEqual({ hint: "/skill-0 [args]" })
      expect(full.items[0]?._meta).toEqual({ scope: "user" })
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("applies the fields allowlist", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const page = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_commands",
            arguments: { sessionId, limit: 5, fields: ["name", "scope"] },
          }),
        ),
      ) as Page
      expect(Object.keys(page.items[0]!).sort()).toEqual(["name", "scope"])
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("caps a call with no limit at 50 rows and hands back a cursor", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const body = JSON.parse(
        textOf(
          await client.callTool({
            name: "session_commands",
            arguments: { sessionId },
          }),
        ),
      ) as { commands: CommandRow[]; total?: number; truncated?: boolean; nextCursor?: string }
      expect(body.commands).toHaveLength(50)
      expect(body.total).toBe(60)
      expect(body.truncated).toBe(true)
      expect(body.nextCursor).toBeTruthy()
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("keeps one page of 200 commands under 25 KB", async () => {
    const { client, sessionId, close, registry } = await buildHarness()
    try {
      const text = textOf(
        await client.callTool({
          name: "session_commands",
          arguments: { sessionId, limit: 200 },
        }),
      )
      const size = Buffer.byteLength(text, "utf8")
      expect(size, `a page of commands weighs ${size} bytes (budget 25000)`).toBeLessThanOrEqual(25_000)
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("errors on an unknown session", async () => {
    const { client, close, registry } = await buildHarness()
    try {
      const result = (await client.callTool({
        name: "session_commands",
        arguments: { sessionId: "sess_nope" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
      expect(result.isError).toBe(true)
      expect(result.content?.[0]?.text).toContain("no session")
    } finally {
      await close()
      registry.shutdown()
    }
  })
})
