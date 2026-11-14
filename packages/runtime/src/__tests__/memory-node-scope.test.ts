/**
 * AIP-72 section 10 on the spawn digest: the node projection is one more
 * condition on the digest's selection (conditions 2 and 4), computed by the
 * host, handed in already cut (nearest node first), and applied before the
 * size bound. Synthetic stores in temp dirs, a fixed clock; nothing under
 * ~/.agentproto.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"
import { buildMemoryDigest, selectMemoryItems } from "../memory-digest.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")

const ROOT = "@acme/agentik"
const SIMONE = "@acme/simone"
const KATCHY = "@acme/katchy"
const PERSO = "@jeremy/perso"
const USER_ROOT = "@jeremy/root"

let root: string
let store: FilesMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-node-scope-"))
  store = new FilesMemoryStore({ root: join(root, "store"), now: () => NOW })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function item(id: string, tags: string[], overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    schema: "memory/v1",
    slug: id,
    kind: "feedback",
    type: "feedback",
    title: `Title ${id}`,
    updated_at: "2026-10-01T00:00:00.000Z",
    id,
    tags,
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: `Body of ${id}.\n`,
    ...overrides,
  }
}

async function seed(items: MemoryDocument[]): Promise<void> {
  for (const doc of items) await store.write(doc, { mode: "commit" })
}

async function visibleIds(opts: Parameters<typeof selectMemoryItems>[1]): Promise<string[]> {
  return (await selectMemoryItems(store, opts)).map((d) => d.id as string).sort()
}

const ANCHORS = { session: "sess_1" }

describe("digest node projection (AIP-72 section 10)", () => {
  it("drops an item on a sibling node and keeps the session's node and its ancestors", async () => {
    await seed([
      item("on-simone", ["global", `node:${SIMONE}`]),
      item("on-katchy", ["global", `node:${KATCHY}`]),
      item("on-root", ["global", `node:${ROOT}`]),
    ])
    const ids = await visibleIds({ anchors: ANCHORS, scope: { nodes: [SIMONE, ROOT], tree: ROOT } })
    expect(ids).toEqual(["on-root", "on-simone"])
  })

  it("drops an item above a sealed wall: the projection is already cut at the sealed node", async () => {
    await seed([
      item("in-perso", ["global", `node:${PERSO}`]),
      item("above-the-wall", ["global", `node:${USER_ROOT}`]),
    ])
    const sealed = await visibleIds({ anchors: ANCHORS, scope: { nodes: [PERSO], tree: USER_ROOT } })
    expect(sealed).toEqual(["in-perso"])
    const open = await visibleIds({ anchors: ANCHORS, scope: { nodes: [PERSO, USER_ROOT], tree: USER_ROOT } })
    expect(open).toEqual(["above-the-wall", "in-perso"])
  })

  it("drops an item with no node anchor from a session that has a node scope", async () => {
    await seed([item("untagged", ["global"]), item("tagged", ["global", `node:${SIMONE}`])])
    expect(await visibleIds({ anchors: ANCHORS, scope: { nodes: [SIMONE], tree: ROOT } })).toEqual(["tagged"])
  })

  it("drops an item with a node anchor from a session that has no node scope, and keeps the untagged ones", async () => {
    await seed([item("untagged", ["global"]), item("tagged", ["global", `node:${SIMONE}`])])
    expect(await visibleIds({ anchors: ANCHORS })).toEqual(["untagged"])
    expect(await visibleIds({ anchors: ANCHORS, scope: { nodes: [] } })).toEqual(["untagged"])
  })

  it("drops an operator's own item on a node outside the session's chain (C4)", async () => {
    await seed([
      item("mine-here", ["global", `node:${SIMONE}`, "operator:pm-simone"]),
      item("mine-elsewhere", ["global", `node:${KATCHY}`, "operator:pm-simone"]),
    ])
    const ids = await visibleIds({
      anchors: ANCHORS,
      scope: { nodes: [SIMONE, ROOT], tree: ROOT, operator: "pm-simone" },
    })
    expect(ids).toEqual(["mine-here"])
  })

  it("drops another operator's item unless a read grant reaches the session, and a grant never crosses a node", async () => {
    await seed([
      item("theirs", ["global", `node:${SIMONE}`, "operator:coo"]),
      item("theirs-off-chain", ["global", `node:${KATCHY}`, "operator:coo"]),
      item("node-shared", ["global", `node:${SIMONE}`]),
    ])
    const scope = { nodes: [SIMONE, ROOT], tree: ROOT, operator: "pm-simone" }
    expect(await visibleIds({ anchors: ANCHORS, scope })).toEqual(["node-shared"])
    expect(await visibleIds({ anchors: ANCHORS, scope, operatorGrants: ["coo"] })).toEqual(["node-shared", "theirs"])
  })

  it("hides an operator-owned item from a session that runs no operator", async () => {
    await seed([item("owned", ["global", `node:${SIMONE}`, "operator:pm-simone"])])
    expect(await visibleIds({ anchors: ANCHORS, scope: { nodes: [SIMONE], tree: ROOT } })).toEqual([])
  })

  it("keeps node and operator tags out of the anchor condition: an unmatched flat anchor still excludes", async () => {
    await seed([item("other-project", ["project:other", `node:${SIMONE}`])])
    expect(await visibleIds({ anchors: ANCHORS, scope: { nodes: [SIMONE], tree: ROOT } })).toEqual([])
  })

  it("orders by section 9: the operator's own item before a node item, the session's own node before its ancestors", async () => {
    await seed([
      item("at-root", ["global", `node:${ROOT}`]),
      item("at-simone", ["global", `node:${SIMONE}`]),
      item("owned", ["global", `node:${ROOT}`, "operator:pm-simone"]),
    ])
    const ids = (
      await selectMemoryItems(store, {
        anchors: ANCHORS,
        scope: { nodes: [SIMONE, ROOT], tree: ROOT, operator: "pm-simone" },
      })
    ).map((d) => d.id)
    expect(ids).toEqual(["owned", "at-simone", "at-root"])
  })

  it("applies the size bound after the filter: a hidden item never takes a slot or counts as left out", async () => {
    const visible = ["v1", "v2", "v3", "v4"]
    await seed([
      ...visible.map((id, i) =>
        item(id, ["global", `node:${SIMONE}`], { updated_at: `2026-10-0${i + 1}T00:00:00.000Z` }),
      ),
      // Newest, so it would sort first and take the first slot if it were not filtered out.
      ...["h1", "h2", "h3"].map((id) =>
        item(id, ["global", `node:${KATCHY}`], { updated_at: "2026-10-20T00:00:00.000Z" }),
      ),
    ])
    const scope = { nodes: [SIMONE, ROOT], tree: ROOT }
    const all = await buildMemoryDigest(store, { anchors: ANCHORS, scope, maxChars: 100_000 })
    expect(all?.included).toBe(4)

    const bound = (all as { text: string }).text.length - 60
    const cut = await buildMemoryDigest(store, { anchors: ANCHORS, scope, maxChars: bound })
    expect(cut).not.toBeNull()
    expect(cut!.text).not.toMatch(/h[123]/)
    expect(cut!.included + cut!.omitted).toBe(4)
    expect(cut!.omitted).toBeGreaterThan(0)
    expect(cut!.text).toContain(`${cut!.omitted} in-force memory items left out`)
  })
})
