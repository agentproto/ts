import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FilesMemoryStore,
  MemoryConflictError,
  MemoryNotFoundError,
  MemorySlugTakenError,
  MemoryTransitionError,
  MemoryValidationError,
  parseMemory,
  renderMemory,
  type MemoryDocument,
  type MemoryKnowledgeHit,
  type MemoryKnowledgeProvider,
} from "../index.js"

const T0 = "2026-10-28T10:00:00.000Z"
const T1 = "2026-10-28T11:00:00.000Z"

let root: string
let clock: Date
let store: FilesMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-store-"))
  clock = new Date(T0)
  store = new FilesMemoryStore({ root, now: () => clock })
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
    body: "Always cite sources.\n",
    ...overrides,
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function itemFile(type: string, id: string): Promise<string> {
  return readFile(join(root, "items", type, `${id}.md`), "utf8")
}

/** Lines of `after` that differ from `before` (same line count assumed). */
function changedLines(before: string, after: string): string[] {
  const a = before.split("\n")
  const b = after.split("\n")
  expect(b.length).toBe(a.length)
  return b.filter((line, i) => line !== a[i])
}

describe("write: commit", () => {
  it("creates an item at items/<type>/<id>.md with an assigned id and updated_at", async () => {
    const rec = await store.write(doc(), { mode: "commit" })
    expect(rec.proposalId).toBeUndefined()
    expect(rec.item.id).toMatch(/^mem_[a-z0-9]+$/)
    expect(rec.item.updated_at).toBe(T0)
    const text = await itemFile("feedback", rec.item.id!)
    expect(rec.revision).toBe(sha256(text))
    expect(parseMemory(text)).toEqual(rec.item)
  })

  it("keeps a caller-given id", async () => {
    const rec = await store.write(doc({ id: "mem_given01" }), { mode: "commit" })
    expect(rec.item.id).toBe("mem_given01")
    expect(existsSync(join(root, "items/feedback/mem_given01.md"))).toBe(true)
  })

  it("rejects an invalid document, naming the field, and writes nothing", async () => {
    const bad = doc({ title: undefined })
    await expect(store.write(bad, { mode: "commit" })).rejects.toMatchObject({
      name: "MemoryValidationError",
      field: "title",
    })
    await expect(
      store.write(doc({ type: "user", kind: "user" }), { mode: "commit" }),
    ).rejects.toMatchObject({ field: "polarity" })
    expect(existsSync(join(root, "items"))).toBe(false)
  })

  it("rejects an id that is not a safe path stem", async () => {
    await expect(
      store.write(doc({ id: "../escape" }), { mode: "commit" }),
    ).rejects.toBeInstanceOf(MemoryValidationError)
  })

  it("rejects creating an item that is not active", async () => {
    await expect(
      store.write(doc({ status: "archived" }), { mode: "commit" }),
    ).rejects.toBeInstanceOf(MemoryTransitionError)
  })

  it("is idempotent by id: an equal re-write touches nothing (rule 18)", async () => {
    const first = await store.write(doc({ id: "mem_idem" }), { mode: "commit" })
    const before = await itemFile("feedback", "mem_idem")
    clock = new Date(T1)
    const again = await store.write(
      { ...first.item, updated_at: T1 },
      { mode: "commit" },
    )
    expect(again.revision).toBe(first.revision)
    expect(again.item.updated_at).toBe(T0)
    expect(await itemFile("feedback", "mem_idem")).toBe(before)
    // also with a stale ifRevision: the equal write still succeeds
    const third = await store.write(first.item, { mode: "commit", ifRevision: "stale" })
    expect(third.revision).toBe(first.revision)
  })

  it("compare-and-set: a change needs the current ifRevision (rule 17)", async () => {
    const first = await store.write(doc({ id: "mem_cas" }), { mode: "commit" })
    const changed = { ...first.item, title: "Cite every source" }

    await expect(store.write(changed, { mode: "commit" })).rejects.toBeInstanceOf(
      MemoryConflictError,
    )
    const stale = await store
      .write(changed, { mode: "commit", ifRevision: "0".repeat(64) })
      .catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(MemoryConflictError)
    expect(stale).toMatchObject({ expected: "0".repeat(64), actual: first.revision })

    clock = new Date(T1)
    const ok = await store.write(changed, { mode: "commit", ifRevision: first.revision })
    expect(ok.revision).not.toBe(first.revision)
    expect(ok.item.title).toBe("Cite every source")
    expect(ok.item.updated_at).toBe(T1)

    // the old revision is now stale
    await expect(
      store.write({ ...ok.item, title: "Again" }, { mode: "commit", ifRevision: first.revision }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it("bumps written along with updated_at when the item carries it (rule 19)", async () => {
    const first = await store.write(doc({ id: "mem_wr", written: T0 }), { mode: "commit" })
    clock = new Date(T1)
    const next = await store.write(
      { ...first.item, description: "new" },
      { mode: "commit", ifRevision: first.revision },
    )
    expect(next.item.written).toBe(T1)
    expect(next.item.updated_at).toBe(T1)
  })

  it("an ifRevision on an id that does not exist is a conflict", async () => {
    await expect(
      store.write(doc({ id: "mem_none" }), { mode: "commit", ifRevision: "abc" }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it("a commit that changes the type moves the file, never two files per id (rule 14)", async () => {
    const first = await store.write(doc({ id: "mem_move" }), { mode: "commit" })
    const moved = await store.write(
      { ...first.item, type: "project", kind: "project", polarity: undefined },
      { mode: "commit", ifRevision: first.revision },
    )
    expect(moved.item.type).toBe("project")
    expect(existsSync(join(root, "items/feedback/mem_move.md"))).toBe(false)
    expect(existsSync(join(root, "items/project/mem_move.md"))).toBe(true)
    expect((await store.read("mem_move"))?.revision).toBe(moved.revision)
  })

  it("rejects a commit that moves status (rules 7 and 15)", async () => {
    const first = await store.write(doc({ id: "mem_st" }), { mode: "commit" })
    await expect(
      store.write({ ...first.item, status: "archived" }, { mode: "commit", ifRevision: first.revision }),
    ).rejects.toBeInstanceOf(MemoryTransitionError)
  })

  it("rejects superseded -> active through a commit", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    const { old: retired } = await store.supersede(
      "mem_old",
      doc({ id: "mem_new" }),
      { ifRevision: old.revision },
    )
    const err = await store
      .write({ ...retired.item, status: "active" }, { mode: "commit", ifRevision: retired.revision })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MemoryTransitionError)
    expect(err).toMatchObject({ from: "superseded", to: "active" })
    expect((await store.read("mem_old"))?.item.status).toBe("superseded")
  })

  it("rejects a second active item with the same slug (rule 14)", async () => {
    await store.write(doc({ id: "mem_a" }), { mode: "commit" })
    const err = await store.write(doc({ id: "mem_b" }), { mode: "commit" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MemorySlugTakenError)
    expect(err).toMatchObject({ slug: "cite-sources", holder: "mem_a" })
    expect(existsSync(join(root, "items/feedback/mem_b.md"))).toBe(false)
  })

  it("lets a slug be reused once its holder is archived", async () => {
    const a = await store.write(doc({ id: "mem_a" }), { mode: "commit" })
    await store.archive("mem_a", { ifRevision: a.revision })
    const b = await store.write(doc({ id: "mem_b" }), { mode: "commit" })
    expect(b.item.slug).toBe("cite-sources")
  })
})

describe("write: propose and dismiss", () => {
  it("writes a proposal keyed by the SHA-256 of its rendering, outside items/", async () => {
    const proposal = doc({ id: "mem_prop" })
    const rec = await store.write(proposal, { mode: "propose" })
    expect(rec.proposalId).toBe(sha256(renderMemory(proposal)))
    expect(existsSync(join(root, "proposals", `${rec.proposalId}.md`))).toBe(true)
    expect(existsSync(join(root, "items"))).toBe(false)
    expect(await store.read("mem_prop")).toBeNull()
    expect(await store.list()).toEqual([])
    expect(await store.list({ proposals: true })).toEqual([rec])
  })

  it("a propose of a pending document returns the existing proposal", async () => {
    const a = await store.write(doc(), { mode: "propose" })
    clock = new Date(T1)
    const b = await store.write(doc(), { mode: "propose" })
    expect(b).toEqual(a)
    expect(await readdir(join(root, "proposals"))).toHaveLength(1)
  })

  it("rejects an invalid proposal", async () => {
    await expect(
      store.write(doc({ kind: "opinion" }), { mode: "propose" }),
    ).rejects.toBeInstanceOf(MemoryValidationError)
  })

  it("a commit fromProposal writes the item, then drops the proposal (rule 21)", async () => {
    const p = await store.write(doc(), { mode: "propose" })
    const item = await store.write(p.item, { mode: "commit", fromProposal: p.proposalId })
    expect(item.proposalId).toBeUndefined()
    expect(await store.list({ proposals: true })).toEqual([])
    expect(await store.read(item.item.id!)).toEqual(item)
  })

  it("a commit fromProposal of an unknown proposal fails before writing", async () => {
    await expect(
      store.write(doc(), { mode: "commit", fromProposal: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError)
    expect(await store.list()).toEqual([])
  })

  it("dismiss drops a proposal; an unknown one is not found", async () => {
    const p = await store.write(doc(), { mode: "propose" })
    await store.dismiss(p.proposalId!)
    expect(await store.list({ proposals: true })).toEqual([])
    await expect(store.dismiss(p.proposalId!)).rejects.toBeInstanceOf(MemoryNotFoundError)
  })
})

describe("read", () => {
  it("returns null for an unknown or unsafe id", async () => {
    expect(await store.read("mem_missing")).toBeNull()
    expect(await store.read("../../etc/passwd")).toBeNull()
  })

  it("finds an item whatever its type directory", async () => {
    const rec = await store.write(
      doc({ id: "mem_ref", type: "reference", kind: "reference", polarity: undefined, slug: "dashboard" }),
      { mode: "commit" },
    )
    expect(await store.read("mem_ref")).toEqual(rec)
  })
})

describe("supersede", () => {
  it("commits the new item, retires the old one, keeps the old file", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    const oldText = await itemFile("feedback", "mem_old")
    clock = new Date(T1)
    const { old: retired, next } = await store.supersede(
      "mem_old",
      doc({ title: "Cite sources, with links" }),
      { ifRevision: old.revision },
    )
    expect(next.item.id).toBeDefined()
    expect(next.item.id).not.toBe("mem_old")
    expect(next.item.slug).toBe("cite-sources") // slug carries over
    expect(next.item.updated_at).toBe(T1)
    expect(retired.item.status).toBe("superseded")
    expect(retired.item.updated_at).toBe(T0) // status-only rewrite (rule 19)
    const newText = await itemFile("feedback", "mem_old")
    expect(changedLines(oldText, newText)).toEqual(['status: "superseded"'])
    expect(retired.revision).toBe(sha256(newText))
    expect((await store.list()).map((r) => r.item.id)).toEqual([next.item.id])
  })

  it("needs the current ifRevision", async () => {
    await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    await expect(store.supersede("mem_old", doc())).rejects.toBeInstanceOf(MemoryConflictError)
    await expect(
      store.supersede("mem_old", doc(), { ifRevision: "nope" }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect((await store.list()).map((r) => r.item.id)).toEqual(["mem_old"])
  })

  it("rejects a next item with the old id, and an unknown old id", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    await expect(
      store.supersede("mem_old", doc({ id: "mem_old" }), { ifRevision: old.revision }),
    ).rejects.toMatchObject({ name: "MemoryValidationError", field: "id" })
    await expect(
      store.supersede("mem_nope", doc(), { ifRevision: "x" }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError)
  })

  it("rejects superseding an archived item", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    const archived = await store.archive("mem_old", { ifRevision: old.revision })
    await expect(
      store.supersede("mem_old", doc({ slug: "other-slug" }), { ifRevision: archived.revision }),
    ).rejects.toBeInstanceOf(MemoryTransitionError)
  })

  it("still enforces the slug against items other than the superseded one", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    await store.write(doc({ id: "mem_other", slug: "taken-slug" }), { mode: "commit" })
    await expect(
      store.supersede("mem_old", doc({ slug: "taken-slug" }), { ifRevision: old.revision }),
    ).rejects.toBeInstanceOf(MemorySlugTakenError)
  })
})

describe("archive", () => {
  it("rewrites only the status line and never deletes the file", async () => {
    const rec = await store.write(doc({ id: "mem_arc" }), { mode: "commit" })
    const before = await itemFile("feedback", "mem_arc")
    clock = new Date(T1)
    const archived = await store.archive("mem_arc", { ifRevision: rec.revision })
    const after = await itemFile("feedback", "mem_arc")
    expect(archived.item.status).toBe("archived")
    expect(archived.item.updated_at).toBe(T0)
    expect(changedLines(before, after)).toEqual(['status: "archived"'])
    expect(await store.read("mem_arc")).toEqual(archived)
  })

  it("adds a status line when the item has none", async () => {
    const rec = await store.write(doc({ id: "mem_nostatus", status: undefined }), {
      mode: "commit",
    })
    expect(rec.item.status).toBeUndefined()
    const archived = await store.archive("mem_nostatus", { ifRevision: rec.revision })
    expect(archived.item.status).toBe("archived")
    expect({ ...archived.item, status: undefined }).toEqual({ ...rec.item, status: undefined })
  })

  it("needs the current ifRevision, and an existing id", async () => {
    await store.write(doc({ id: "mem_arc" }), { mode: "commit" })
    await expect(store.archive("mem_arc")).rejects.toBeInstanceOf(MemoryConflictError)
    await expect(store.archive("mem_arc", { ifRevision: "x" })).rejects.toBeInstanceOf(
      MemoryConflictError,
    )
    await expect(store.archive("mem_nope", { ifRevision: "x" })).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    )
  })

  it("rejects archiving a superseded item, and re-archiving is a no-op", async () => {
    const old = await store.write(doc({ id: "mem_old" }), { mode: "commit" })
    const { old: retired } = await store.supersede("mem_old", doc(), { ifRevision: old.revision })
    await expect(
      store.archive("mem_old", { ifRevision: retired.revision }),
    ).rejects.toBeInstanceOf(MemoryTransitionError)

    const other = await store.write(doc({ id: "mem_x", slug: "x-slug" }), { mode: "commit" })
    const a1 = await store.archive("mem_x", { ifRevision: other.revision })
    const a2 = await store.archive("mem_x", { ifRevision: a1.revision })
    expect(a2).toEqual(a1)
  })

  it("lets exactly one of two concurrent archives with the same revision through", async () => {
    const rec = await store.write(doc({ id: "mem_race" }), { mode: "commit" })
    const results = await Promise.allSettled([
      store.write({ ...rec.item, title: "Changed" }, { mode: "commit", ifRevision: rec.revision }),
      store.archive("mem_race", { ifRevision: rec.revision }),
    ])
    const rejected = results.filter((r) => r.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(MemoryConflictError)
  })
})

describe("list", () => {
  beforeEach(async () => {
    await store.write(doc({ id: "mem_fb", tags: ["project:acme"] }), { mode: "commit" })
    await store.write(
      doc({
        id: "mem_user",
        type: "user",
        kind: "user",
        polarity: undefined,
        slug: "prefers-short",
        title: "Prefers short answers",
        tags: ["global"],
        body: "Keep answers short.\n",
      }),
      { mode: "commit" },
    )
    await store.write(
      doc({
        id: "mem_expired",
        type: "project",
        kind: "project",
        polarity: undefined,
        slug: "freeze-week",
        title: "Release freeze",
        tags: ["project:acme"],
        lifetime: { kind: "until", at: "2026-10-20T00:00:00.000Z" },
        body: "No merges during the freeze.\n",
      }),
      { mode: "commit" },
    )
    const arc = await store.write(
      doc({ id: "mem_arc", slug: "old-rule", title: "Old rule", tags: ["global"] }),
      { mode: "commit" },
    )
    await store.archive("mem_arc", { ifRevision: arc.revision })
  })

  const ids = (records: readonly { item: MemoryDocument }[]) =>
    records.map((r) => r.item.id).sort()

  it("defaults to in-force items: no archived, no expired until (rules 10, 11)", async () => {
    expect(ids(await store.list())).toEqual(["mem_fb", "mem_user"])
  })

  it("inForce: false lists the items that are not in force", async () => {
    expect(ids(await store.list({ inForce: false }))).toEqual(["mem_arc", "mem_expired"])
  })

  it("a status filter replaces the in-force default", async () => {
    expect(ids(await store.list({ status: "active" }))).toEqual([
      "mem_expired",
      "mem_fb",
      "mem_user",
    ])
    expect(ids(await store.list({ status: ["archived"] }))).toEqual(["mem_arc"])
  })

  it("filters by type and by tag (match any)", async () => {
    expect(ids(await store.list({ type: "user" }))).toEqual(["mem_user"])
    expect(ids(await store.list({ type: ["user", "feedback"] }))).toEqual(["mem_fb", "mem_user"])
    expect(ids(await store.list({ tags: ["project:acme"], status: "active" }))).toEqual([
      "mem_expired",
      "mem_fb",
    ])
  })

  it("filters by slug", async () => {
    expect(ids(await store.list({ slug: "prefers-short" }))).toEqual(["mem_user"])
    expect(await store.list({ slug: "nothing-here" })).toEqual([])
  })

  it("a slug lookup during an interrupted supersede returns the later item (rule 20)", async () => {
    // Two active items with one slug: what an interrupted supersede leaves.
    const twin = parseMemory(await itemFile("user", "mem_user"))
    const later = renderMemory({ ...twin, id: "mem_user2", updated_at: T1 })
    await writeFile(join(root, "items/user/mem_user2.md"), later)
    expect(ids(await store.list({ slug: "prefers-short" }))).toEqual(["mem_user2"])
  })
})

describe("search", () => {
  beforeEach(async () => {
    await store.write(doc({ id: "mem_fb", body: "Always cite sources with a link.\n" }), {
      mode: "commit",
    })
    await store.write(
      doc({
        id: "mem_pnpm",
        type: "project",
        kind: "project",
        polarity: undefined,
        slug: "uses-pnpm",
        title: "The repo uses pnpm",
        description: "Package manager",
        body: "Run pnpm install, never npm.\n",
      }),
      { mode: "commit" },
    )
    const arc = await store.write(
      doc({ id: "mem_arc", slug: "old-pnpm", title: "Old pnpm note", body: "pnpm 8.\n" }),
      { mode: "commit" },
    )
    await store.archive("mem_arc", { ifRevision: arc.revision })
  })

  it("matches title, description and body, in-force items only", async () => {
    const hits = await store.search("pnpm")
    expect(hits.map((h) => h.id)).toEqual(["mem_pnpm"])
    expect(hits[0]).toMatchObject({
      source: "memory",
      slug: "uses-pnpm",
      title: "The repo uses pnpm",
    })
    expect(hits[0]!.snippet).toContain("pnpm")
    expect(hits[0]!.score).toBeGreaterThan(0)

    expect((await store.search("LINK")).map((h) => h.id)).toEqual(["mem_fb"])
    expect((await store.search("package manager")).map((h) => h.id)).toEqual(["mem_pnpm"])
    expect(await store.search("kubernetes")).toEqual([])
  })

  it("honours the filter and the limit", async () => {
    expect(
      (await store.search("pnpm", { filter: { status: "archived" } })).map((h) => h.id),
    ).toEqual(["mem_arc"])
    expect(await store.search("cite pnpm", { limit: 1 })).toHaveLength(1)
  })

  it("merges a knowledge provider's hits, checked against the files (rule 22)", async () => {
    const queries: unknown[] = []
    const hits: MemoryKnowledgeHit[] = [
      // the provider indexes memory items: one in force, one archived (stale)
      { sourceId: "mem_pnpm", chunkId: "c1", text: "pnpm", score: 0.9, metadata: {} },
      { sourceId: "x", chunkId: "c2", text: "pnpm", score: 0.8, metadata: { memoryId: "mem_arc" } },
      // something else the provider holds
      {
        sourceId: "wiki/build",
        chunkId: "c3",
        text: "Builds run with pnpm turbo.",
        score: 0.95,
        metadata: { title: "Build guide" },
      },
    ]
    const knowledge: MemoryKnowledgeProvider = {
      async query(q) {
        queries.push(q)
        return { hits }
      },
    }
    const withKb = new FilesMemoryStore({ root, knowledge, now: () => clock })
    const result = await withKb.search("pnpm", { limit: 10 })

    expect(queries).toEqual([{ query: "pnpm", topK: 10 }])
    expect(result.filter((h) => h.source === "memory").map((h) => h.id)).toEqual(["mem_pnpm"])
    const kb = result.filter((h) => h.source === "knowledge")
    expect(kb).toEqual([
      {
        source: "knowledge",
        title: "Build guide",
        snippet: "Builds run with pnpm turbo.",
        score: 0.95,
        ref: "wiki/build#c3",
      },
    ])
    expect(result[0]!.source).toBe("knowledge") // highest score first
  })
})

describe("legacy items", () => {
  // As the pre-doctype reference writer left them: no schema, slug or
  // updated_at, plain YAML scalars.
  const LEGACY = `---
id: mem_qc8f407g
name: repo-uses-pnpm
type: project
description: The repo uses pnpm
tags: [project:acme]
created: 2026-10-13T11:30:00.000Z
written: 2026-10-13T11:30:00.000Z
---

The repo uses pnpm, not npm.
`

  beforeEach(async () => {
    await mkdir(join(root, "items/project"), { recursive: true })
    await writeFile(join(root, "items/project/mem_qc8f407g.md"), LEGACY)
  })

  it("reads, lists and searches a legacy item unchanged", async () => {
    const rec = await store.read("mem_qc8f407g")
    expect(rec?.revision).toBe(sha256(LEGACY))
    expect(rec?.item).toMatchObject({
      id: "mem_qc8f407g",
      name: "repo-uses-pnpm",
      type: "project",
      tags: ["project:acme"],
      body: "The repo uses pnpm, not npm.\n",
    })
    expect((await store.list()).map((r) => r.item.id)).toEqual(["mem_qc8f407g"])
    expect(await store.search("pnpm")).toEqual([
      expect.objectContaining({ source: "memory", id: "mem_qc8f407g", title: "repo-uses-pnpm" }),
    ])
  })

  it("archives a legacy item by adding one status line", async () => {
    const archived = await store.archive("mem_qc8f407g", { ifRevision: sha256(LEGACY) })
    const after = await itemFile("project", "mem_qc8f407g")
    expect(after).toBe(LEGACY.replace("\n---\n\n", '\nstatus: "archived"\n---\n\n'))
    expect(archived.item.status).toBe("archived")
  })
})
