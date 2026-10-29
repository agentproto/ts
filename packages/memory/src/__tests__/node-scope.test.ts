/**
 * AIP-72 section 10 on the files store: the scope is built by the host and
 * applied by every operation (rules 27 to 29), writes get their anchors by
 * default (rules 31 to 33) and promotion is an explicit re-tag (rule 34).
 * Synthetic stores in temp dirs only.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FilesMemoryStore,
  MemoryNotFoundError,
  MemoryValidationError,
  type MemoryDocument,
  type MemoryScope,
} from "../index.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")

const ROOT = "@acme/agentik"
const SIMONE = "@acme/simone"
const KATCHY = "@acme/katchy"

const SIMONE_SESSION: MemoryScope = { nodes: [SIMONE, ROOT], tree: ROOT, operator: "pm-simone" }
const KATCHY_SESSION: MemoryScope = { nodes: [KATCHY, ROOT], tree: ROOT, operator: "pm-katchy" }

let dir: string
let store: FilesMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-node-store-"))
  store = new FilesMemoryStore({ root: dir, now: () => NOW, declaresTrees: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function doc(overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    schema: "memory/v1",
    slug: "cite-sources",
    kind: "feedback",
    type: "feedback",
    title: "Cite sources",
    updated_at: "2026-10-01T00:00:00.000Z",
    tags: ["project:acme"],
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: "Always cite sources.\n",
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  return undefined
}

describe("writes", () => {
  it("refuses a host call that creates an item or a proposal with no node anchor (rule 33)", async () => {
    for (const mode of ["commit", "propose"] as const) {
      const err = await rejection(store.write(doc({ id: `m-${mode}`, slug: `s-${mode}`, tags: ["global"] }), { mode }))
      expect(err, mode).toBeInstanceOf(MemoryValidationError)
      expect((err as MemoryValidationError).field).toBe("tags")
    }
    expect(await store.list({ inForce: true })).toEqual([])
    expect(await store.list({ proposals: true })).toEqual([])
  })

  it("accepts a host call that names a node anchor, and a store whose host declares no tree as before", async () => {
    const named = await store.write(doc({ tags: ["project:acme", `node:${SIMONE}`] }), { mode: "commit" })
    expect(named.item.tags).toContain(`node:${SIMONE}`)
    const plain = new FilesMemoryStore({ root: join(dir, "plain"), now: () => NOW })
    const free = await plain.write(doc({ tags: ["project:acme"] }), { mode: "commit" })
    expect(free.item.tags).toEqual(["project:acme"])
  })

  it("adds the session's node and its operator when the document names neither (rule 31)", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    expect(written.item.tags).toEqual(["project:acme", `node:${SIMONE}`, "operator:pm-simone"])
    const proposed = await store.write(doc({ slug: "other" }), { mode: "propose", scope: SIMONE_SESSION })
    expect(proposed.item.tags).toEqual(["project:acme", `node:${SIMONE}`, "operator:pm-simone"])
  })

  it("adds no operator anchor when the writer shares the item with the node (rule 32)", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION, owner: "node" })
    expect(written.item.tags).toEqual(["project:acme", `node:${SIMONE}`])
  })

  it("refuses a node anchor outside the session's nodes and an operator anchor that is not its own (rules 31, 32)", async () => {
    const sibling = await rejection(
      store.write(doc({ tags: ["project:acme", `node:${KATCHY}`] }), { mode: "commit", scope: SIMONE_SESSION }),
    )
    expect(sibling).toBeInstanceOf(MemoryValidationError)
    expect((sibling as MemoryValidationError).field).toBe("tags")
    const other = await rejection(
      store.write(doc({ tags: ["project:acme", "operator:pm-katchy"] }), { mode: "commit", scope: SIMONE_SESSION }),
    )
    expect(other).toBeInstanceOf(MemoryValidationError)
    expect((other as MemoryValidationError).field).toBe("tags")
  })

  it("gives a global item the tree root's node anchor, and refuses any other node with global (rule 33)", async () => {
    const written = await store.write(doc({ tags: ["global"] }), { mode: "commit", scope: SIMONE_SESSION })
    expect(written.item.tags).toEqual(["global", `node:${ROOT}`, "operator:pm-simone"])
    const wrong = await rejection(
      store.write(doc({ slug: "other", tags: ["global", `node:${SIMONE}`] }), {
        mode: "commit",
        scope: SIMONE_SESSION,
      }),
    )
    expect(wrong).toBeInstanceOf(MemoryValidationError)
    expect((wrong as MemoryValidationError).field).toBe("tags")
  })

  it("refuses a global write from a session whose projection was cut below the tree root (rule 33)", async () => {
    const sealed: MemoryScope = { nodes: ["@jeremy/perso"], tree: "@jeremy/root" }
    const err = await rejection(store.write(doc({ tags: ["global"] }), { mode: "commit", scope: sealed }))
    expect(err).toBeInstanceOf(MemoryValidationError)
    expect((err as MemoryValidationError).field).toBe("tags")
  })

  it("lets a session with no node scope write without a node anchor, but never into a node (rule 33)", async () => {
    const free = await store.write(doc(), { mode: "commit", scope: { nodes: [] } })
    expect(free.item.tags).toEqual(["project:acme"])
    const into = await rejection(
      store.write(doc({ slug: "x", tags: [`node:${SIMONE}`] }), { mode: "commit", scope: { nodes: [] } }),
    )
    expect(into).toBeInstanceOf(MemoryValidationError)
  })
})

describe("projection on every operation (rules 27 to 29)", () => {
  async function seedTwoGuilds(): Promise<{ simone: string; katchy: string }> {
    const simone = await store.write(doc({ slug: "simone-rule", title: "Simone rule" }), {
      mode: "commit",
      scope: SIMONE_SESSION,
    })
    const katchy = await store.write(doc({ slug: "katchy-rule", title: "Katchy rule" }), {
      mode: "commit",
      scope: KATCHY_SESSION,
    })
    return { simone: simone.item.id as string, katchy: katchy.item.id as string }
  }

  it("does not list, read, find by search or change an item on a sibling node, and reports it as not found (rule 28)", async () => {
    const { simone, katchy } = await seedTwoGuilds()
    expect((await store.list({ scope: SIMONE_SESSION })).map((r) => r.item.id)).toEqual([simone])
    expect(await store.read(katchy, { scope: SIMONE_SESSION })).toBeNull()
    expect((await store.read(simone, { scope: SIMONE_SESSION }))?.item.id).toBe(simone)

    const hits = await store.search("rule", { filter: { scope: SIMONE_SESSION } })
    expect(hits.map((h) => h.id)).toEqual([simone])

    const hidden = await store.read(katchy)
    const revision = hidden?.revision
    expect(await rejection(store.archive(katchy, { scope: SIMONE_SESSION, ...(revision ? { ifRevision: revision } : {}) }))).toBeInstanceOf(
      MemoryNotFoundError,
    )
    expect(
      await rejection(store.supersede(katchy, doc({ id: "n1", slug: "n1" }), { scope: SIMONE_SESSION })),
    ).toBeInstanceOf(MemoryNotFoundError)
    expect(
      await rejection(store.write(doc({ id: katchy }), { mode: "commit", scope: SIMONE_SESSION, ifRevision: revision as string })),
    ).toBeInstanceOf(MemoryNotFoundError)
    expect((await store.read(katchy))?.item.status ?? "active").toBe("active")
  })

  it("applies the projection to proposals: not listed, not dismissable (rules 27, 28)", async () => {
    const proposed = await store.write(doc({ slug: "pending-note" }), { mode: "propose", scope: KATCHY_SESSION })
    expect(await store.list({ proposals: true, scope: SIMONE_SESSION })).toEqual([])
    expect((await store.list({ proposals: true, scope: KATCHY_SESSION })).length).toBe(1)
    expect(await rejection(store.dismiss(proposed.proposalId as string, { scope: SIMONE_SESSION }))).toBeInstanceOf(
      MemoryNotFoundError,
    )
    await store.dismiss(proposed.proposalId as string, { scope: KATCHY_SESSION })
    expect(await store.list({ proposals: true })).toEqual([])
  })

  it("filters before the search limit: a hidden better match never takes a slot (rule 29)", async () => {
    for (let i = 0; i < 3; i++) {
      await store.write(doc({ slug: `katchy-${i}`, title: `deploy deploy deploy ${i}` }), {
        mode: "commit",
        scope: KATCHY_SESSION,
      })
    }
    const mine = await store.write(doc({ slug: "simone-deploy", title: "deploy", body: "one mention\n" }), {
      mode: "commit",
      scope: SIMONE_SESSION,
    })
    const hits = await store.search("deploy", { limit: 1, filter: { scope: SIMONE_SESSION } })
    expect(hits.map((h) => h.id)).toEqual([mine.item.id])
  })

  it("never runs a delegated knowledge provider for a scoped search, and never builds a snippet from a hidden item (rule 29)", async () => {
    let queried = 0
    const guarded = new FilesMemoryStore({
      root: dir,
      now: () => NOW,
      knowledge: {
        async query() {
          queried += 1
          return { hits: [] }
        },
      },
    })
    await store.write(doc({ slug: "secret", body: "needle in a hidden item\n" }), { mode: "commit", scope: KATCHY_SESSION })
    const hits = await guarded.search("needle", { filter: { scope: SIMONE_SESSION } })
    expect(hits).toEqual([])
    expect(queried).toBe(0)
  })

  it("treats a call with no scope as a host call that sees everything (rule 30)", async () => {
    await seedTwoGuilds()
    expect((await store.list({})).length).toBe(2)
  })
})

describe("promotion (rule 34)", () => {
  const parentSession: MemoryScope = { nodes: [ROOT], tree: ROOT }

  function retag(item: MemoryDocument, to: string): MemoryDocument {
    return { ...item, tags: (item.tags ?? []).map((t) => (t.startsWith("node:") ? `node:${to}` : t)) }
  }

  it("re-tags a node-shared item onto an ancestor node, and only then does the parent's projection include it", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION, owner: "node" })
    const id = written.item.id as string
    expect(await store.read(id, { scope: parentSession })).toBeNull()
    expect(await store.read(id, { scope: KATCHY_SESSION })).toBeNull()

    const promoted = await store.write(retag(written.item, ROOT), {
      mode: "commit",
      scope: SIMONE_SESSION,
      ifRevision: written.revision,
    })
    expect(promoted.item.tags).toEqual(["project:acme", `node:${ROOT}`])

    expect((await store.read(id, { scope: parentSession }))?.item.id).toBe(id)
    expect((await store.list({ scope: KATCHY_SESSION })).map((r) => r.item.id)).toEqual([id])
  })

  it("keeps the operator anchor on a promoted item: the parent's projection includes it for its owner only", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    const id = written.item.id as string
    const promoted = await store.write(retag(written.item, ROOT), {
      mode: "commit",
      scope: SIMONE_SESSION,
      ifRevision: written.revision,
    })
    expect(promoted.item.tags).toEqual(["project:acme", `node:${ROOT}`, "operator:pm-simone"])
    expect(await store.read(id, { scope: parentSession })).toBeNull()
    expect((await store.read(id, { scope: { ...parentSession, operator: "pm-simone" } }))?.item.id).toBe(id)
  })

  it("refuses a re-tag onto a node outside the session's projection, such as a sibling", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    const err = await rejection(
      store.write(retag(written.item, KATCHY), {
        mode: "commit",
        scope: SIMONE_SESSION,
        ifRevision: written.revision,
      }),
    )
    expect(err).toBeInstanceOf(MemoryValidationError)
    expect((err as MemoryValidationError).field).toBe("tags")
  })

  it("refuses a re-tag that also changes the item's other anchors", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    const err = await rejection(
      store.write(
        { ...written.item, tags: ["global", `node:${ROOT}`, "operator:pm-simone"] },
        { mode: "commit", scope: SIMONE_SESSION, ifRevision: written.revision },
      ),
    )
    expect(err).toBeInstanceOf(MemoryValidationError)
    expect((err as MemoryValidationError).field).toBe("tags")
  })

  it("never promotes by itself: an edit that names no node anchor keeps the item where it is", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    const edited = await store.write(
      { ...written.item, tags: ["project:acme"], body: "Edited.\n" },
      { mode: "commit", scope: SIMONE_SESSION, ifRevision: written.revision },
    )
    expect(edited.item.tags).toEqual(["project:acme", `node:${SIMONE}`, "operator:pm-simone"])
  })

  it("keeps the node and ownership of the item a supersede replaces", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION, owner: "node" })
    const next = await store.supersede(
      written.item.id as string,
      doc({ id: "replacement", slug: "cite-sources-2" }),
      { scope: SIMONE_SESSION, ifRevision: written.revision },
    )
    expect(next.next.item.tags).toEqual(["project:acme", `node:${SIMONE}`])
  })

  it("holds a supersede that moves the node anchor to the same re-tag-only rule", async () => {
    const written = await store.write(doc(), { mode: "commit", scope: SIMONE_SESSION })
    const rejected = await rejection(
      store.supersede(
        written.item.id as string,
        doc({ id: "replacement", slug: "cite-sources-2", tags: ["project:other", `node:${ROOT}`] }),
        { scope: SIMONE_SESSION, ifRevision: written.revision },
      ),
    )
    expect(rejected).toBeInstanceOf(MemoryValidationError)
    const moved = await store.supersede(
      written.item.id as string,
      doc({ id: "replacement", slug: "cite-sources-2", tags: ["project:acme", `node:${ROOT}`] }),
      { scope: SIMONE_SESSION, ifRevision: written.revision },
    )
    expect(moved.next.item.tags).toContain(`node:${ROOT}`)
  })
})
