/**
 * AIP-72 native-dir projection across `session_restart`: the restarted
 * descriptor keeps the memory meta (store root, inject path, anchors,
 * capture flag), so the turn-end capture keeps running, and the respawned
 * adapter gets a recomputed projection. A lineage without the native path
 * gets none. Temp store, stub adapter.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"
import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { respawnMemoryProjection } from "../memory-digest.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")
let root: string
let store: FilesMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-restart-"))
  store = new FilesMemoryStore({ root: join(root, "store"), now: () => NOW })
  await store.write(
    {
      schema: "memory/v1",
      slug: "cite-sources",
      kind: "feedback",
      type: "feedback",
      title: "Cite sources",
      description: "Always cite sources",
      updated_at: "2026-10-01T00:00:00.000Z",
      tags: ["agent:scout"],
      provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
      body: "Always cite sources.\n",
    },
    { mode: "commit" },
  )
  await store.write(
    {
      schema: "memory/v1",
      slug: "other-agent",
      kind: "feedback",
      type: "feedback",
      title: "Other",
      updated_at: "2026-10-01T00:00:00.000Z",
      tags: ["agent:other"],
      body: "Not ours.\n",
    },
    { mode: "commit" },
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_mem_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {},
    async cancel() {},
    async close() {},
  }
}

type Projection = { items: readonly MemoryDocument[]; digest?: string }

function makeResolver() {
  const captured: Array<Projection | undefined> = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: async (o: { memoryProjection?: Projection }) => {
      captured.push(o.memoryProjection)
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
    supportsSystemPrompt: true,
    memoryInject: "native-dir",
    memoryCapture: "native-dir-diff",
  })
  return { resolver, captured }
}

const nativeMeta = () => ({
  role: "executor",
  memoryStoreRoot: join(root, "store"),
  memoryInject: "native-dir",
  memoryAnchors: "agent:scout,project:default",
  memoryCapture: "native-dir-diff",
})

describe("respawnMemoryProjection", () => {
  it("recomputes the in-scope items for a native-dir lineage", async () => {
    const projection = await respawnMemoryProjection(nativeMeta(), {
      sessionId: "sess_x",
      memoryStoreAt: () => store,
      supportsSystemPrompt: true,
    })
    expect(projection?.items.map(i => i.slug)).toEqual(["cite-sources"])
    expect(projection?.digest).toContain("slug: cite-sources")
  })

  it("is undefined without the native path, without a store, or with memory disabled", async () => {
    const opts = { sessionId: "sess_x", memoryStoreAt: () => store }
    expect(await respawnMemoryProjection(undefined, opts)).toBeUndefined()
    expect(await respawnMemoryProjection({ memoryStoreRoot: join(root, "store") }, opts)).toBeUndefined()
    expect(await respawnMemoryProjection({ ...nativeMeta(), memory: "disabled" }, opts)).toBeUndefined()
    const { memoryStoreRoot: _r, ...noRoot } = nativeMeta()
    expect(await respawnMemoryProjection(noRoot, opts)).toBeUndefined()
  })
})

describe("restartAgentSession keeps the native memory projection", () => {
  it("carries the memory meta and hands the respawn a recomputed projection", async () => {
    const { resolver, captured } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    try {
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession(),
        adapterSlug: "mock",
        meta: nativeMeta(),
      })
      const restarted = await restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        memoryStoreAt: () => store,
      })
      expect(captured[0]?.items.map(i => i.slug)).toEqual(["cite-sources"])
      const { role: _role, ...memory } = nativeMeta()
      expect(restarted.desc.meta).toMatchObject(memory)
      // And again: the restart of the restart still projects.
      await restartAgentSession(registry, resolver, restarted.desc, {
        forceAgentResume: true,
        memoryStoreAt: () => store,
      })
      expect(captured[1]?.items).toHaveLength(1)
    } finally {
      registry.shutdown()
    }
  })

  it("hands no projection to a lineage that was not projected", async () => {
    const { resolver, captured } = makeResolver()
    const registry = createSessionsRegistry({ persist: false })
    try {
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession(),
        adapterSlug: "mock",
        meta: { memoryStoreRoot: join(root, "store"), memory: "disabled" },
      })
      const restarted = await restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        memoryStoreAt: () => store,
      })
      expect(captured[0]).toBeUndefined()
      expect(restarted.desc.meta).toMatchObject({ memoryStoreRoot: join(root, "store"), memory: "disabled" })
      expect(restarted.desc.meta?.memoryCapture).toBeUndefined()
    } finally {
      registry.shutdown()
    }
  })
})
