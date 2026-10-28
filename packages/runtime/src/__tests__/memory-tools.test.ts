/**
 * The AIP-72 memory MCP tools (`memory-tools.ts`): each tool's happy path
 * and one error, the commit gate (operator and supervisor may commit, an
 * executor may only propose), and the mapping of the store's typed errors
 * to tool errors. A real `FilesMemoryStore` over a temp dir, a fixed clock,
 * the createMcpServer + InMemoryTransport pattern; no network.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"

import {
  memoryCommitAllowed,
  registerMemoryTools,
  resolveMemoryCaller,
  type MemoryCaller,
} from "../memory-tools.js"

const OPERATOR: MemoryCaller = { kind: "operator" }
const EXECUTOR: MemoryCaller = { kind: "session", id: "sess_exec", role: "executor" }
const SUPERVISOR: MemoryCaller = { kind: "session", id: "sess_sup", role: "supervisor" }

let root: string
let store: FilesMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-tools-"))
  store = new FilesMemoryStore({ root, now: () => new Date("2026-10-28T10:00:00.000Z") })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function doc(overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    schema: "memory/v1",
    slug: "cite-sources",
    kind: "feedback",
    type: "feedback",
    title: "Cite sources",
    updated_at: "2026-10-01T00:00:00.000Z",
    polarity: "do",
    tags: ["global"],
    status: "active",
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: "Always cite sources when quoting a figure.\n",
    ...overrides,
  }
}

async function harness(caller: MemoryCaller) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMemoryTools(server, { store: () => store, caller })
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

describe("commit gate", () => {
  it("resolves a call with no callerSessionId as the operator", () => {
    expect(resolveMemoryCaller(undefined, () => undefined)).toEqual({ kind: "operator" })
  })

  it("resolves a session caller with the role recorded at spawn", () => {
    expect(resolveMemoryCaller("s1", () => ({ role: "executor" }))).toEqual({
      kind: "session",
      id: "s1",
      role: "executor",
    })
    expect(resolveMemoryCaller("s2", () => undefined)).toEqual({ kind: "session", id: "s2" })
    expect(resolveMemoryCaller("s3", () => ({ role: "supervisor", memory: "disabled" }))).toEqual({
      kind: "session",
      id: "s3",
      role: "supervisor",
      memoryDisabled: true,
    })
  })

  it("lets the operator and a supervisor commit, never an executor or an unknown role", () => {
    expect(memoryCommitAllowed(OPERATOR)).toBe(true)
    expect(memoryCommitAllowed(SUPERVISOR)).toBe(true)
    expect(memoryCommitAllowed(EXECUTOR)).toBe(false)
    expect(memoryCommitAllowed({ kind: "session", id: "s" })).toBe(false)
    expect(memoryCommitAllowed({ kind: "session", id: "s", role: "made-up" })).toBe(false)
  })
})

describe("memory_write", () => {
  it("an executor proposes; the proposal is listed and never in force", async () => {
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_write", { item: doc() })
    expect(res.isError).toBe(false)
    expect(res.json.proposalId).toMatch(/^[a-f0-9]{64}$/)
    expect(res.json.mode).toBe("propose")
    const listed = await h.call("memory_list", { proposals: true })
    expect((listed.json.items as unknown[]).length).toBe(1)
    const inForce = await h.call("memory_list", {})
    expect(inForce.json.items).toEqual([])
    await h.close()
  })

  it("refuses a commit from an executor with commit_not_allowed", async () => {
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_write", { item: doc(), mode: "commit" })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("commit_not_allowed")
    expect(String(res.json.message)).toMatch(/propose/)
    expect(await store.list()).toEqual([])
    await h.close()
  })

  it("the operator commits; the item gets an id and a revision", async () => {
    const h = await harness(OPERATOR)
    const res = await h.call("memory_write", { item: doc(), mode: "commit" })
    expect(res.isError).toBe(false)
    expect(res.json.mode).toBe("commit")
    expect(typeof res.json.id).toBe("string")
    expect(typeof res.json.revision).toBe("string")
    const stored = await store.read(res.json.id as string)
    expect(stored?.item.title).toBe("Cite sources")
    await h.close()
  })

  it("a supervisor commits a proposal with fromProposal, which drops it", async () => {
    const proposal = await store.write(doc(), { mode: "propose" })
    const h = await harness(SUPERVISOR)
    const res = await h.call("memory_write", {
      item: doc(),
      mode: "commit",
      fromProposal: proposal.proposalId,
    })
    expect(res.isError).toBe(false)
    expect(await store.list({ proposals: true })).toEqual([])
    await h.close()
  })

  it("maps a stale ifRevision to a conflict carrying expected and actual revisions", async () => {
    const committed = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_write", {
      item: doc({ id: "m1", title: "Cite every source" }),
      mode: "commit",
      ifRevision: "stale",
    })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({
      error: "conflict",
      id: "m1",
      expectedRevision: "stale",
      actualRevision: committed.revision,
    })
    await h.close()
  })

  it("maps an invalid item to a validation error naming the field", async () => {
    const h = await harness(OPERATOR)
    const res = await h.call("memory_write", {
      item: doc({ type: "user", kind: "user", polarity: "do" }),
      mode: "commit",
    })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("validation")
    expect(res.json.field).toBe("polarity")
    await h.close()
  })

  it("maps a second active item on one slug to slug_taken naming the holder", async () => {
    await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_write", { item: doc({ id: "m2" }), mode: "commit" })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({ error: "slug_taken", slug: "cite-sources", holder: "m1" })
    await h.close()
  })
})

describe("AIP-42 memory.enabled: false", () => {
  const DISABLED: MemoryCaller = { kind: "session", id: "sess_off", role: "supervisor", memoryDisabled: true }

  it("refuses every write, a proposal included, with memory_disabled", async () => {
    const committed = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const proposal = await store.write(doc({ id: "m9", slug: "other" }), { mode: "propose" })
    const h = await harness(DISABLED)
    for (const [name, args] of [
      ["memory_write", { item: doc({ id: "m2", slug: "x" }) }],
      ["memory_write", { item: doc({ id: "m2", slug: "x" }), mode: "commit" }],
      ["memory_supersede", { id: "m1", next: doc({ id: "m3" }), ifRevision: committed.revision }],
      ["memory_archive", { id: "m1", ifRevision: committed.revision }],
      ["memory_dismiss", { proposalId: proposal.proposalId }],
    ] as const) {
      const res = await h.call(name, args as Record<string, unknown>)
      expect(res.isError, name).toBe(true)
      expect(res.json.error, name).toBe("memory_disabled")
    }
    expect((await store.list()).map(r => r.item.id)).toEqual(["m1"])
    expect(await store.list({ proposals: true })).toHaveLength(1)
    const read = await h.call("memory_read", { id: "m1" })
    expect(read.isError).toBe(false)
    await h.close()
  })
})

describe("memory_read", () => {
  it("returns the item, its body and its revision", async () => {
    const committed = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_read", { id: "m1" })
    expect(res.isError).toBe(false)
    expect(res.json.revision).toBe(committed.revision)
    expect((res.json.item as MemoryDocument).body).toContain("Always cite sources")
    await h.close()
  })

  it("maps an unknown id to not_found", async () => {
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_read", { id: "nope" })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({ error: "not_found", id: "nope", what: "item" })
    await h.close()
  })
})

describe("memory_list", () => {
  it("lists in-force items compactly, filtered by type and tags, and paginates", async () => {
    await store.write(doc({ id: "m1" }), { mode: "commit" })
    await store.write(
      doc({
        id: "m2",
        slug: "acme-stack",
        kind: "project",
        type: "project",
        polarity: undefined,
        title: "Acme runs on Postgres",
        tags: ["project:acme"],
      }),
      { mode: "commit" },
    )
    const h = await harness(EXECUTOR)
    const all = await h.call("memory_list", {})
    expect((all.json.items as unknown[]).length).toBe(2)
    const row = (all.json.items as Array<Record<string, unknown>>)[0]!
    expect(row).not.toHaveProperty("body")
    expect(row).not.toHaveProperty("item")
    expect(row).toHaveProperty("revision")

    const projects = await h.call("memory_list", { type: "project" })
    expect((projects.json.items as Array<{ id: string }>).map(r => r.id)).toEqual(["m2"])
    const tagged = await h.call("memory_list", { tags: ["project:acme"] })
    expect((tagged.json.items as Array<{ id: string }>).map(r => r.id)).toEqual(["m2"])

    const page = await h.call("memory_list", { limit: 1 })
    expect((page.json.items as unknown[]).length).toBe(1)
    expect(typeof page.json.nextCursor).toBe("string")
    const next = await h.call("memory_list", { limit: 1, cursor: page.json.nextCursor })
    expect((next.json.items as unknown[]).length).toBe(1)
    expect(next.json.nextCursor).toBeUndefined()

    const full = await h.call("memory_list", { full: true })
    expect((full.json.items as Array<{ item: MemoryDocument }>)[0]!.item.body).toBeTruthy()
    await h.close()
  })

  it("rejects an unknown type", async () => {
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_list", { type: "opinion" })
    expect(res.isError).toBe(true)
    await h.close()
  })
})

describe("memory_search", () => {
  it("returns memory hits with source, id, slug, title and snippet", async () => {
    await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_search", { query: "cite" })
    expect(res.isError).toBe(false)
    const hits = res.json.hits as Array<Record<string, unknown>>
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ source: "memory", id: "m1", slug: "cite-sources", title: "Cite sources" })
    expect(typeof hits[0]!.snippet).toBe("string")
    await h.close()
  })

  it("rejects an empty query", async () => {
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_search", { query: "" })
    expect(res.isError).toBe(true)
    await h.close()
  })
})

describe("memory_supersede", () => {
  it("the operator supersedes: the new item is active, the old one superseded", async () => {
    const old = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_supersede", {
      id: "m1",
      next: doc({ id: "m2", title: "Cite every source" }),
      ifRevision: old.revision,
    })
    expect(res.isError).toBe(false)
    expect((await store.read("m1"))?.item.status).toBe("superseded")
    expect((await store.read("m2"))?.item.status ?? "active").toBe("active")
    await h.close()
  })

  it("refuses an executor with commit_not_allowed", async () => {
    const old = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_supersede", {
      id: "m1",
      next: doc({ id: "m2" }),
      ifRevision: old.revision,
    })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("commit_not_allowed")
    expect((await store.read("m1"))?.item.status ?? "active").toBe("active")
    await h.close()
  })

  it("maps superseding an archived item to invalid_transition", async () => {
    const old = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const archived = await store.archive("m1", { ifRevision: old.revision })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_supersede", {
      id: "m1",
      next: doc({ id: "m2" }),
      ifRevision: archived.revision,
    })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({ error: "invalid_transition", id: "m1", from: "archived", to: "superseded" })
    await h.close()
  })
})

describe("memory_archive", () => {
  it("a supervisor archives an item", async () => {
    const old = await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(SUPERVISOR)
    const res = await h.call("memory_archive", { id: "m1", ifRevision: old.revision })
    expect(res.isError).toBe(false)
    expect((await store.read("m1"))?.item.status).toBe("archived")
    await h.close()
  })

  it("maps a missing ifRevision to a conflict", async () => {
    await store.write(doc({ id: "m1" }), { mode: "commit" })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_archive", { id: "m1" })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({ error: "conflict", id: "m1" })
    await h.close()
  })
})

describe("memory_dismiss", () => {
  it("the operator dismisses a proposal", async () => {
    const proposal = await store.write(doc(), { mode: "propose" })
    const h = await harness(OPERATOR)
    const res = await h.call("memory_dismiss", { proposalId: proposal.proposalId })
    expect(res.isError).toBe(false)
    expect(await store.list({ proposals: true })).toEqual([])
    await h.close()
  })

  it("maps an unknown proposal to not_found", async () => {
    const h = await harness(OPERATOR)
    const res = await h.call("memory_dismiss", { proposalId: "0".repeat(64) })
    expect(res.isError).toBe(true)
    expect(res.json).toMatchObject({ error: "not_found", what: "proposal" })
    await h.close()
  })

  it("refuses an executor with commit_not_allowed", async () => {
    const proposal = await store.write(doc(), { mode: "propose" })
    const h = await harness(EXECUTOR)
    const res = await h.call("memory_dismiss", { proposalId: proposal.proposalId })
    expect(res.isError).toBe(true)
    expect(res.json.error).toBe("commit_not_allowed")
    expect(await store.list({ proposals: true })).toHaveLength(1)
    await h.close()
  })
})
