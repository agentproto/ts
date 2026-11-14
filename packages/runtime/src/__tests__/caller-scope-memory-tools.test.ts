/**
 * T15 on the memory MCP tools: the MemoryScope is built from the CALLER
 * session's ground and handed to the store, so a sealed sibling's item and an
 * item above a sealed wall are absent from search, list (items and proposals),
 * read, and unreachable by the write tools; a missing or unknown caller is
 * refused. The one shared fixture; a real FilesMemoryStore over a temp dir.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"

import { HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { registerMemoryTools, type MemoryCaller } from "../memory-tools.js"
import { AGENTIK_ID, NOTES_ID, PERSO_ID, SESSION, USER_ROOT_ID, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

const NOW = new Date("2026-10-28T10:00:00.000Z")
const SUPERVISOR: MemoryCaller = { kind: "session", id: "sess_sup", role: "supervisor" }
const EXECUTOR: MemoryCaller = { kind: "session", id: "sess_exec", role: "executor" }

let fx: CallerFixture
let dir: string
let store: FilesMemoryStore

function doc(id: string, tags: string[], overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    schema: "memory/v1",
    slug: id,
    kind: "feedback",
    type: "feedback",
    title: `Title ${id}`,
    updated_at: "2026-10-01T00:00:00.000Z",
    id,
    polarity: "do",
    tags,
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: `Body of ${id} mentions zebra.\n`,
    ...overrides,
  }
}

beforeEach(async () => {
  fx = buildCallerFixture()
  dir = await mkdtemp(join(tmpdir(), "caller-scope-memory-"))
  store = new FilesMemoryStore({ root: dir, now: () => NOW })
  for (const d of [
    doc("perso-item", ["global", `node:${PERSO_ID}`]),
    doc("notes-item", ["global", `node:${NOTES_ID}`]),
    doc("root-item", ["global", `node:${USER_ROOT_ID}`]),
    doc("company-item", ["global", `node:${AGENTIK_ID}`]),
    doc("untagged-item", ["global"]),
    doc("other-operator-item", ["global", `node:${NOTES_ID}`, "operator:mallory"]),
    doc("own-operator-item", ["global", `node:${NOTES_ID}`, "operator:jeremy"]),
  ]) {
    await store.write(d, { mode: "commit" })
  }
  await store.write(doc("perso-proposal", ["global", `node:${PERSO_ID}`]), { mode: "propose" })
  await store.write(doc("notes-proposal", ["global", `node:${NOTES_ID}`]), { mode: "propose" })
})

afterEach(async () => {
  fx.cleanup()
  await rm(dir, { recursive: true, force: true })
})

async function harness(callerScope: CallerScope | undefined, caller: MemoryCaller = SUPERVISOR) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMemoryTools(server, { store: () => store, caller, callerScope } as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  async function call(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    const text = result.content[0]!.text
    let json: Record<string, unknown>
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = { raw: text }
    }
    return { isError: result.isError === true, json, text }
  }
  return { call, close: () => client.close() }
}

const idsOf = (json: Record<string, unknown>, key: string): string[] =>
  (json[key] as Array<{ id?: string }>).map((i) => i.id as string).sort()

describe("memory_list", () => {
  it("a sealed node sees its own item, not its sibling's nor the item above the wall", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("memory_list", {})
    expect(idsOf(res.json, "items")).toEqual(["perso-item"])
    expect(res.text).not.toContain("notes-item")
    expect(res.text).not.toContain("root-item")
    expect(res.text).not.toContain("company-item")
    await h.close()
  })

  it("an isolated sibling of the sealed node sees itself and its ancestors, never the sealed node's item", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("memory_list", {})
    expect(idsOf(res.json, "items")).toEqual(["notes-item", "own-operator-item", "root-item"])
    expect(res.text).not.toContain("perso-item")
    expect(res.text).not.toContain("other-operator-item")
    await h.close()
  })

  it("filters before pagination: every page is free of the walled items and the pages add up", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await h.call("memory_list", { limit: 1, ...(cursor ? { cursor } : {}) })
      expect(page.text).not.toContain("perso-item")
      seen.push(...idsOf(page.json, "items"))
      cursor = page.json.nextCursor as string | undefined
      if (!cursor) break
    }
    expect(seen.sort()).toEqual(["notes-item", "own-operator-item", "root-item"])
    await h.close()
  })

  it("lists only the proposals in the caller's projection", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("memory_list", { proposals: true })
    const items = res.json.items as Array<{ id: string }>
    expect(items.map((i) => i.id)).toEqual(["notes-proposal"])
    await h.close()
  })

  it("a host call still sees everything", async () => {
    const h = await harness(HOST_CALLER)
    const res = await h.call("memory_list", {})
    expect(idsOf(res.json, "items")).toEqual([
      "company-item",
      "notes-item",
      "other-operator-item",
      "own-operator-item",
      "perso-item",
      "root-item",
      "untagged-item",
    ])
    await h.close()
  })

  it("a session whose ground lies in no declared node does not see node-anchored items, only the untagged ones", async () => {
    const h = await harness(fx.caller(SESSION.free))
    const res = await h.call("memory_list", {})
    expect(idsOf(res.json, "items")).toEqual(["untagged-item"])
    await h.close()
  })
})

describe("memory_search", () => {
  it("returns no hit on a walled item and builds no snippet from it", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("memory_search", { query: "zebra" })
    const hits = res.json.hits as Array<{ id: string }>
    expect(hits.map((x) => x.id).sort()).toEqual(["perso-item"])
    expect(res.text).not.toContain("notes-item")
    expect(res.text).not.toContain("root-item")
    await h.close()
  })

  it("applies the limit after the projection", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("memory_search", { query: "zebra", limit: 3 })
    const hits = res.json.hits as Array<{ id: string }>
    expect(hits.map((x) => x.id).sort()).toEqual(["notes-item", "own-operator-item", "root-item"])
    await h.close()
  })
})

describe("memory_read", () => {
  it("a sealed sibling's item reads as absent", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("memory_read", { id: "perso-item" })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("not_found")
    expect(res.text).not.toContain("PERSO")
    await h.close()
  })

  it("an item above the sealed wall reads as absent to the sealed node", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("memory_read", { id: "root-item" })
    expect(res.json.error).toBe("not_found")
    await h.close()
  })

  it("an untagged item is out of a node-scoped caller's projection", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    expect((await h.call("memory_read", { id: "untagged-item" })).json.error).toBe("not_found")
    await h.close()
  })

  it("an item owned by another operator reads as absent", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    expect((await h.call("memory_read", { id: "other-operator-item" })).json.error).toBe("not_found")
    await h.close()
  })

  it("an item in the caller's own projection is readable", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("memory_read", { id: "root-item" })
    expect(res.isError).toBe(false)
    await h.close()
  })
})

describe("write tools", () => {
  it("a proposal is tagged with the caller's node and operator", async () => {
    const h = await harness(fx.caller(SESSION.notes), EXECUTOR)
    const res = await h.call("memory_write", { item: doc("fresh", ["project:x"]) })
    expect(res.isError).toBe(false)
    const proposals = await store.list({ proposals: true })
    const fresh = proposals.find((r) => r.item.id === "fresh")
    expect(fresh?.item.tags).toEqual(expect.arrayContaining([`node:${NOTES_ID}`, "operator:jeremy"]))
    await h.close()
  })

  it("cannot commit over, supersede or archive an item outside the projection", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const overwrite = await h.call("memory_write", { item: doc("perso-item", ["global"]), mode: "commit" })
    expect(overwrite.isError).toBe(true)
    const supersede = await h.call("memory_supersede", { id: "perso-item", next: doc("next-one", ["global"]) })
    expect(supersede.json.error).toBe("not_found")
    const archive = await h.call("memory_archive", { id: "perso-item" })
    expect(archive.json.error).toBe("not_found")
    const after = await store.read("perso-item")
    expect(after?.item.status ?? "active").toBe("active")
    await h.close()
  })

  it("cannot dismiss a proposal outside the projection", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const proposals = await store.list({ proposals: true })
    const persoProposal = proposals.find((r) => r.item.id === "perso-proposal")
    const res = await h.call("memory_dismiss", { proposalId: persoProposal!.proposalId })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("not_found")
    expect((await store.list({ proposals: true })).length).toBe(2)
    await h.close()
  })
})

describe("a missing or unknown caller is refused", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["memory_search", { query: "zebra" }],
    ["memory_list", {}],
    ["memory_list", { proposals: true }],
    ["memory_read", { id: "untagged-item" }],
    ["memory_write", { item: doc("x", ["global"]) }],
    ["memory_supersede", { id: "untagged-item", next: doc("y", ["global"]) }],
    ["memory_archive", { id: "untagged-item" }],
    ["memory_dismiss", { proposalId: "a".repeat(64) }],
  ]

  for (const [label, scope] of [
    ["an unknown caller id", () => fx.caller(SESSION.ghost)],
    ["no caller scope at all", () => undefined],
  ] as const) {
    for (const [tool, args] of calls) {
      it(`${tool} refuses ${label}`, async () => {
        const h = await harness(scope())
        const res = await h.call(tool, args)
        expect(res.isError).toBe(true)
        expect(res.json.error).toBe("caller_refused")
        expect(res.text).not.toContain("Body of")
        await h.close()
      })
    }
  }
})
