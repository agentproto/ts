/**
 * Cold history end-to-end: sessions the registry dropped at boot
 * (`HISTORY_CAP`) must still be reachable through the list/search/recap
 * tools, and `session_search`'s cursor must page past the first window.
 *
 * Hermetic: the registry's transcript base dir and persist path both point
 * at a temp dir, and the cold cache is reset per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { resetColdSessionCache } from "../session-cold-list.js"
import type { SessionIndexEntry } from "../session-index.js"

let tmp: string
let transcriptDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-cold-e2e-"))
  transcriptDir = join(tmp, "sessions")
  mkdirSync(transcriptDir, { recursive: true })
  resetColdSessionCache()
})

afterEach(() => {
  resetColdSessionCache()
  rmSync(tmp, { recursive: true, force: true })
})

function writeSidecar(entry: SessionIndexEntry): void {
  const dir = join(transcriptDir, entry.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.json"), JSON.stringify(entry))
}

/** A session dir that exists only as its transcript (no sidecar). */
function writeEvents(id: string, lines: object[]): void {
  const dir = join(transcriptDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "events.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n")
}

function makeAgent(): AgentSessionLike {
  return {
    sessionId: "acp-1",
    async *send() {
      yield { kind: "text-delta", text: "hi" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function build(): Promise<{
  client: Client
  reg: SessionsRegistry
  close: () => Promise<void>
}> {
  const reg = createSessionsRegistry({ persistPath: join(tmp, "sessions.json"), transcriptDir })
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

const idsOf = (body: Record<string, unknown>, key = "sessions"): string[] =>
  (body[key] as Array<{ id: string }>).map(s => s.id)

const coldEntry = (id: string, over: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
  id,
  kind: "agent-cli",
  status: "exited",
  alive: false,
  label: `chat ${id}`,
  cwd: "/work/app",
  workspaceSlug: "default",
  startedAt: "2026-05-01T10:00:00.000Z",
  lastActivityAt: "2026-05-01T11:00:00.000Z",
  ...over,
})

describe("session_list — cold history", () => {
  it("includeCold merges disk-only sessions, flagged cold, newest-first", async () => {
    const { client, reg, close } = await build()
    reg.spawnAgent({ id: "sess_live", workspaceSlug: "default", cwd: tmp, adapterSlug: "claude-code", agentSession: makeAgent(), label: "live one" })
    writeSidecar(coldEntry("sess_coldold", { lastActivityAt: "2026-05-01T09:00:00.000Z" }))
    writeSidecar(coldEntry("sess_coldnew", { lastActivityAt: "2026-05-02T09:00:00.000Z" }))

    const body = json(await client.callTool({ name: "session_list", arguments: { includeCold: true } }))
    expect(idsOf(body)).toEqual(["sess_live", "sess_coldnew", "sess_coldold"])

    const cold = (body.sessions as Array<Record<string, unknown>>).find(s => s.id === "sess_coldold")!
    expect(cold).toMatchObject({ cold: true, alive: false, status: "exited", kind: "agent-cli" })

    await close()
    reg.shutdown()
  })

  it("a q that matches nothing live falls back to cold history automatically", async () => {
    const { client, reg, close } = await build()
    reg.spawnAgent({ id: "sess_live", workspaceSlug: "default", cwd: tmp, adapterSlug: "claude-code", agentSession: makeAgent(), label: "live one" })
    writeSidecar(coldEntry("sess_tuesday", { label: "the tuesday session" }))

    const miss = json(await client.callTool({ name: "session_list", arguments: { q: "tuesday" } }))
    expect(idsOf(miss)).toEqual(["sess_tuesday"])

    // A q that DOES match live rows never pulls in cold ones.
    const hit = json(await client.callTool({ name: "session_list", arguments: { q: "live" } }))
    expect(idsOf(hit)).toEqual(["sess_live"])

    await close()
    reg.shutdown()
  })

  it("cold rows honour the same filters — archived history stays hidden", async () => {
    const { client, reg, close } = await build()
    writeSidecar(coldEntry("sess_arch", { archived: true, label: "review:pr-9" }))
    writeSidecar(coldEntry("sess_cmd", { kind: "command" }))

    const plain = json(await client.callTool({ name: "session_list", arguments: { includeCold: true } }))
    expect(idsOf(plain)).toEqual([])

    const withArchived = json(
      await client.callTool({ name: "session_list", arguments: { includeCold: true, includeArchived: true } }),
    )
    expect(idsOf(withArchived)).toEqual(["sess_arch"])

    const commands = json(
      await client.callTool({ name: "session_list", arguments: { includeCold: true, kind: "command" } }),
    )
    expect(idsOf(commands)).toEqual(["sess_cmd"])

    await close()
    reg.shutdown()
  })

  it("cold rows paginate with limit/cursor like live ones", async () => {
    const { client, reg, close } = await build()
    writeSidecar(coldEntry("sess_c1", { lastActivityAt: "2026-05-03T09:00:00.000Z" }))
    writeSidecar(coldEntry("sess_c2", { lastActivityAt: "2026-05-02T09:00:00.000Z" }))
    writeSidecar(coldEntry("sess_c3", { lastActivityAt: "2026-05-01T09:00:00.000Z" }))

    const union: string[] = []
    let cursor: string | undefined
    do {
      const body = json(
        await client.callTool({
          name: "session_list",
          arguments: { includeCold: true, limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      ) as { items?: Array<{ id: string }>; nextCursor?: string }
      union.push(...(body.items ?? []).map(s => s.id))
      cursor = body.nextCursor
    } while (cursor)
    expect(union).toEqual(["sess_c1", "sess_c2", "sess_c3"])

    await close()
    reg.shutdown()
  })

  it("recovers a sidecar-less cold session from its transcript", async () => {
    const { client, reg, close } = await build()
    writeEvents("sess_bare", [
      { seq: 1, ts: "2026-05-01T10:00:00.000Z", kind: "user-prompt", text: "lost and found" },
    ])
    const body = json(await client.callTool({ name: "session_list", arguments: { q: "sess_bare" } }))
    expect(idsOf(body)).toEqual(["sess_bare"])
    await close()
    reg.shutdown()
  })
})

describe("session_search — cold history + cursor pagination", () => {
  it("cursor pages past the first window (regression: the pre-slice bug)", async () => {
    const { client, reg, close } = await build()
    for (let i = 1; i <= 5; i++) {
      reg.spawnAgent({
        id: `sess_p${i}`,
        workspaceSlug: "default",
        cwd: tmp,
        adapterSlug: "claude-code",
        agentSession: makeAgent(),
        label: `page me ${i}`,
      })
    }
    const union: string[] = []
    let cursor: string | undefined
    do {
      const body = json(
        await client.callTool({
          name: "session_search",
          arguments: { query: "page me", limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      ) as { items?: Array<{ id: string }>; nextCursor?: string }
      union.push(...(body.items ?? []).map(s => s.id))
      cursor = body.nextCursor
    } while (cursor)
    expect(union.sort()).toEqual(["sess_p1", "sess_p2", "sess_p3", "sess_p4", "sess_p5"])

    await close()
    reg.shutdown()
  })

  it("still caps an unpaginated search at 20", async () => {
    const { client, reg, close } = await build()
    for (let i = 1; i <= 25; i++) {
      reg.spawnAgent({
        id: `sess_q${String(i).padStart(2, "0")}`,
        workspaceSlug: "default",
        cwd: tmp,
        adapterSlug: "claude-code",
        agentSession: makeAgent(),
        label: `cap me`,
      })
    }
    const body = json(await client.callTool({ name: "session_search", arguments: { query: "cap me" } }))
    expect(idsOf(body)).toHaveLength(20)
    await close()
    reg.shutdown()
  })

  it("finds a disk-only session when the live query matches nothing", async () => {
    const { client, reg, close } = await build()
    writeSidecar(coldEntry("sess_archivedaway", { label: "the tuesday session" }))
    const body = json(await client.callTool({ name: "session_search", arguments: { query: "tuesday" } }))
    expect(idsOf(body)).toEqual(["sess_archivedaway"])
    const row = (body.sessions as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({ cold: true, status: "exited" })
    await close()
    reg.shutdown()
  })

  it("includeCold searches cold history even when live rows match", async () => {
    const { client, reg, close } = await build()
    reg.spawnAgent({ id: "sess_live", workspaceSlug: "default", cwd: tmp, adapterSlug: "claude-code", agentSession: makeAgent(), label: "shared name" })
    writeSidecar(coldEntry("sess_cold", { label: "shared name" }))
    const body = json(
      await client.callTool({ name: "session_search", arguments: { query: "shared name", includeCold: true } }),
    )
    expect(idsOf(body).sort()).toEqual(["sess_cold", "sess_live"])
    await close()
    reg.shutdown()
  })
})

describe("session_recap — a cold id still recaps", () => {
  it("recaps from the sidecar + transcript for a session the registry dropped", async () => {
    const { client, reg, close } = await build()
    writeSidecar(coldEntry("sess_gone", { label: "remember me" }))
    writeEvents("sess_gone", [
      { seq: 1, ts: "2026-05-01T10:00:00.000Z", kind: "user-prompt", text: "the question" },
      { seq: 2, ts: "2026-05-01T10:00:01.000Z", kind: "text-delta", text: "the answer" },
    ])
    const recap = json(await client.callTool({ name: "session_recap", arguments: { id: "sess_gone" } }))
    expect(recap).toMatchObject({ id: "sess_gone", label: "remember me" })
    await close()
    reg.shutdown()
  })
})
