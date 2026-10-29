/**
 * T15 on the memory digest: the scope handed to the digest is derived from the
 * spawned session's own ground (`desc.cwd`) and operator, at spawn and at every
 * respawn (session restart, lazy resume). A sealed sibling's item and an item
 * above the sealed wall never enter the system prompt or the native-dir
 * projection; a ground the tree cannot place injects nothing (fail closed).
 * Shared fixture; the real `spawnAgentSession`; temp dirs only.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

import { respawnMemoryProjection } from "../memory-digest.js"
import { restartAgentSession } from "../session-restart-core.js"
import { spawnAgentSession } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { AGENTIK_ID, NOTES_ID, PERSO_ID, USER_ROOT_ID, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")

let root: string
let store: FilesMemoryStore
let fx: CallerFixture

function doc(id: string, tags: string[]): MemoryDocument {
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
    body: `Body of ${id}.\n`,
  }
}

beforeEach(async () => {
  fx = buildCallerFixture()
  root = await mkdtemp(join(tmpdir(), "caller-scope-digest-"))
  store = new FilesMemoryStore({ root: join(root, "store"), now: () => NOW })
  for (const d of [
    doc("perso-item", ["agent:scout", `node:${PERSO_ID}`]),
    doc("notes-item", ["agent:scout", `node:${NOTES_ID}`]),
    doc("root-item", ["agent:scout", `node:${USER_ROOT_ID}`]),
    doc("company-item", ["agent:scout", `node:${AGENTIK_ID}`]),
    doc("notes-mallory-item", ["agent:scout", `node:${NOTES_ID}`, "operator:mallory"]),
    doc("notes-jeremy-item", ["agent:scout", `node:${NOTES_ID}`, "operator:jeremy"]),
    doc("plain-item", ["agent:scout"]),
  ]) {
    await store.write(d, { mode: "commit" })
  }
})

afterEach(async () => {
  fx.cleanup()
  await rm(root, { recursive: true, force: true })
})

async function writeAgent(): Promise<string> {
  const dir = join(root, "agents", "scout")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    ["---", "schema: agent/v1", "id: scout", "description: Agent scout", "model: test-model", "memory:", "  enabled: true", "---", "", "You are scout."].join("\n") + "\n",
    "utf8",
  )
  return path
}

function setup(inject: "system-prompt" | "native-dir") {
  const session: AgentSessionLike = {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {},
    async cancel() {},
    async close() {},
  }
  const startSession = vi.fn(
    async (_o: { appendSystemPrompt?: string; memoryProjection?: { items: readonly MemoryDocument[]; digest?: string } }) =>
      session,
  )
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter (agent)",
    supportsSystemPrompt: true,
    memoryInject: inject,
  })
  const registry = createSessionsRegistry({ persist: false })
  return { startSession, deps: { registry, resolveAgentAdapter, memoryStoreAt: () => store } }
}

/** The ids the system-prompt digest carries. */
const digestIds = (text: string): string[] =>
  [...text.matchAll(/id: ([a-z-]+);/g)].map((m) => m[1] as string).sort()

async function spawnDigest(cwd: string, operator?: string): Promise<string[] | undefined> {
  const agentPath = await writeAgent()
  const { startSession, deps } = setup("system-prompt")
  const result = await spawnAgentSession(deps, {
    adapter: "mock",
    cwd,
    prompt: "go",
    agentPath,
    ...(operator !== undefined ? { operator } : {}),
  } as never)
  expect(result.ok).toBe(true)
  const appended = startSession.mock.calls[0]![0].appendSystemPrompt ?? ""
  return appended.includes("<agentproto-memory") ? digestIds(appended) : undefined
}

describe("the system-prompt digest is scoped to the spawned session's ground", () => {
  it("a sealed node's digest holds its own items and not its sibling's, nor those above the wall", async () => {
    expect(await spawnDigest(fx.user.persoJournal)).toEqual(["perso-item"])
  })

  it("an isolated sibling's digest holds its own items and its ancestors', never the sealed node's", async () => {
    const ids = await spawnDigest(fx.user.notes)
    expect(ids).toEqual(["notes-item", "root-item"])
    expect(ids).not.toContain("perso-item")
  })

  it("the operator anchor of the session decides which operator-owned items appear", async () => {
    const ids = await spawnDigest(fx.user.notes, "operator:jeremy")
    expect(ids).toContain("notes-jeremy-item")
    expect(ids).not.toContain("notes-mallory-item")
    expect(ids).not.toContain("perso-item")
  })

  it("a session in another tree gets that tree's items only", async () => {
    expect(await spawnDigest(fx.company.agentik)).toEqual(["company-item"])
  })

  it("a ground in no declared tree keeps today's digest: the node-free items", async () => {
    expect(await spawnDigest(fx.free)).toEqual(["plain-item"])
  })

  it("injects nothing, never an unscoped digest, when the tree cannot be read", async () => {
    writeFileSync(join(fx.user.notes, "WORKSPACE.md"), "---\nschema: workspace/v2\nid: not-a-valid-id\n---\n")
    expect(await spawnDigest(fx.user.notes)).toBeUndefined()
  })
})

describe("the native-dir projection is scoped the same way", () => {
  it("hands the driver only the items in the spawned session's projection", async () => {
    const agentPath = await writeAgent()
    const { startSession, deps } = setup("native-dir")
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: fx.user.notes, prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    const items = startSession.mock.calls[0]![0].memoryProjection?.items.map((i) => i.id).sort()
    expect(items).toEqual(["notes-item", "root-item"])
  })

  it("hands the driver no projection when the tree cannot be read", async () => {
    writeFileSync(join(fx.user.notes, "WORKSPACE.md"), "---\nschema: workspace/v2\nid: not-a-valid-id\n---\n")
    const agentPath = await writeAgent()
    const { startSession, deps } = setup("native-dir")
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: fx.user.notes, prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    expect(startSession.mock.calls[0]![0].memoryProjection).toBeUndefined()
  })
})

describe("a respawn recomputes the projection with the session's own scope", () => {
  const meta = () => ({
    role: "executor",
    memoryStoreRoot: join(root, "store"),
    memoryInject: "native-dir",
    memoryAnchors: "agent:scout,project:default",
  })

  it("respawnMemoryProjection scopes the projection to the ground it is given", async () => {
    const opts = { sessionId: "sess_x", memoryStoreAt: () => store, supportsSystemPrompt: true }
    const perso = await respawnMemoryProjection(meta(), { ...opts, ground: fx.user.persoJournal } as never)
    expect(perso?.items.map((i) => i.id)).toEqual(["perso-item"])
    expect(perso?.digest).not.toContain("notes-item")
    const notes = await respawnMemoryProjection(meta(), { ...opts, ground: fx.user.notes } as never)
    expect(notes?.items.map((i) => i.id).sort()).toEqual(["notes-item", "root-item"])
    expect(notes?.digest).not.toContain("perso-item")
  })

  it("respawnMemoryProjection rejects, rather than serving unscoped, when the ground cannot be placed", async () => {
    await expect(
      respawnMemoryProjection(meta(), {
        sessionId: "sess_x",
        memoryStoreAt: () => store,
        ground: "relative/ground",
      } as never),
    ).rejects.toThrow(/refused/i)
  })

  it("restartAgentSession hands the restarted session the projection of its own ground", async () => {
    const captured: Array<{ items: readonly MemoryDocument[] } | undefined> = []
    let n = 0
    const resolver: AgentAdapterResolver = async () => ({
      startSession: async (o: { memoryProjection?: { items: readonly MemoryDocument[] } }) => {
        captured.push(o.memoryProjection)
        return {
          sessionId: `acp_restart_${n++}`,
          // eslint-disable-next-line require-yield
          async *send(): AsyncIterable<AgentStreamEvent> {},
          async cancel() {},
          async close() {},
        } as AgentSessionLike
      },
      commandPreview: "mock-adapter",
      supportsSystemPrompt: true,
      memoryInject: "native-dir",
    })
    const registry = createSessionsRegistry({ persist: false })
    try {
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: fx.user.perso,
        agentSession: { sessionId: "acp_prev", async *send() {}, async cancel() {}, async close() {} } as AgentSessionLike,
        adapterSlug: "mock",
        meta: meta(),
      })
      await restartAgentSession(registry, resolver, prev, { forceAgentResume: true, memoryStoreAt: () => store })
      expect(captured[0]?.items.map((i) => i.id)).toEqual(["perso-item"])
    } finally {
      await registry.shutdown?.()
    }
  })
})
