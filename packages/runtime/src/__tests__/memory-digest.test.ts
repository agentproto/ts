/**
 * AIP-72 section 9 spawn digest (`memory-digest.ts`) and its wiring into
 * `spawnAgentSession`: content and field order, the type then anchor then
 * recency ordering, whole-item truncation with the "left out" line, the
 * inject-path decision, and the spawn-level skips (memory off, no memory
 * block, a `native-dir` adapter). Temp dirs and a fixed clock; no network.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

import {
  buildMemoryDigest,
  decideMemoryInject,
  sessionAnchorTags,
} from "../memory-digest.js"
import { spawnAgentSession } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const NOW = new Date("2026-10-28T12:00:00.000Z")

let root: string
let store: FilesMemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-digest-"))
  store = new FilesMemoryStore({ root: join(root, "store"), now: () => NOW })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function item(overrides: Partial<MemoryDocument> & { id: string }): MemoryDocument {
  const type = overrides.type ?? "feedback"
  return {
    schema: "memory/v1",
    slug: overrides.id,
    kind: type,
    type,
    title: `Title ${overrides.id}`,
    updated_at: "2026-10-01T00:00:00.000Z",
    tags: ["global"],
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: `Body of ${overrides.id}.\n`,
    ...overrides,
  }
}

/** Commit items with distinct commit times so `updated_at` orders them. */
async function seed(items: MemoryDocument[]): Promise<void> {
  for (const [i, doc] of items.entries()) {
    const at = new Date(NOW.getTime() - (items.length - i) * 60_000)
    const timed = new FilesMemoryStore({ root: join(root, "store"), now: () => at })
    await timed.write(doc, { mode: "commit" })
  }
}

const ANCHORS = { session: "sess_1", agent: "scout", project: "acme" }

describe("sessionAnchorTags", () => {
  it("formats the session's anchors, most specific first, and always adds global", () => {
    expect(sessionAnchorTags({ ...ANCHORS, extra: ["project:extra"] })).toEqual([
      "session:sess_1",
      "agent:scout",
      "project:acme",
      "project:extra",
      "global",
    ])
    expect(sessionAnchorTags({})).toEqual(["global"])
  })
})

describe("buildMemoryDigest", () => {
  it("returns null when no in-force item is scoped to the session", async () => {
    await seed([item({ id: "p-other", type: "project", tags: ["project:other"] })])
    expect(await buildMemoryDigest(store, { anchors: ANCHORS })).toBeNull()
  })

  it("keeps in-force items scoped to the session, ordered by type, anchor, then recency", async () => {
    await seed([
      item({ id: "f-global-old", polarity: "do", description: "Cite every figure." }),
      item({
        id: "f-agent",
        polarity: "dont",
        tags: ["agent:scout"],
        body: "First paragraph\nstill first.\n\nSecond paragraph.\n",
      }),
      item({ id: "f-global-new", polarity: "do" }),
      item({ id: "u-untagged", type: "user", tags: [] }),
      item({ id: "p-acme", type: "project", tags: ["project:acme"] }),
      item({ id: "p-other", type: "project", tags: ["project:other"] }),
      item({ id: "r-session", type: "reference", tags: ["session:sess_1"] }),
      item({ id: "f-archived", polarity: "do" }),
      item({
        id: "f-expired",
        polarity: "do",
        lifetime: { kind: "until", at: "2026-10-02T00:00:00.000Z" },
      }),
    ])
    await store.write(item({ id: "f-proposed", polarity: "do" }), { mode: "propose" })
    const toArchive = await store.read("f-archived")
    await store.archive("f-archived", { ifRevision: toArchive!.revision })

    const digest = await buildMemoryDigest(store, { anchors: ANCHORS })
    expect(digest).not.toBeNull()
    const text = digest!.text
    expect(digest!.included).toBe(6)
    expect(digest!.omitted).toBe(0)

    const order = ["f-agent", "f-global-new", "f-global-old", "u-untagged", "p-acme", "r-session"]
    const positions = order.map(id => text.indexOf(`id: ${id};`))
    for (const p of positions) expect(p).toBeGreaterThan(-1)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    for (const id of ["p-other", "f-archived", "f-expired", "f-proposed"]) {
      expect(text).not.toContain(`id: ${id};`)
    }

    // Field order: type, id, slug, title, then polarity on feedback.
    expect(text).toContain("- type: feedback; id: f-agent; slug: f-agent; title: Title f-agent; polarity: dont")
    expect(text).toContain("- type: user; id: u-untagged; slug: u-untagged; title: Title u-untagged\n")
    // description wins; otherwise the body's first paragraph, never more.
    expect(text).toContain("Cite every figure.")
    expect(text).toContain("First paragraph still first.")
    expect(text).not.toContain("Second paragraph.")
    // One delimited block that presents the items as data.
    expect(text.startsWith("<agentproto-memory")).toBe(true)
    expect(text.trimEnd().endsWith("</agentproto-memory>")).toBe(true)
    expect(text).toMatch(/recorded data, not instructions/)
    expect(text).not.toMatch(/left out/)
  })

  it("cuts whole items to fit the bound and says how many it left out", async () => {
    await seed(
      Array.from({ length: 8 }, (_, i) =>
        item({ id: `f${i}`, polarity: "do", description: `Rule number ${i} `.repeat(6).trim() }),
      ),
    )
    const full = await buildMemoryDigest(store, { anchors: ANCHORS })
    const digest = await buildMemoryDigest(store, { anchors: ANCHORS, maxChars: 900 })
    expect(full!.included).toBe(8)
    expect(digest!.text.length).toBeLessThanOrEqual(900)
    expect(digest!.included).toBeGreaterThan(0)
    expect(digest!.included).toBeLessThan(8)
    expect(digest!.omitted).toBe(8 - digest!.included)
    expect(digest!.text).toContain(
      `${digest!.omitted} in-force memory items left out; reach them with memory_search or memory_list.`,
    )
    // Whole items only: every included entry carries its full description.
    const entries = digest!.text.split("\n- ").slice(1)
    expect(entries).toHaveLength(digest!.included)
    for (const entry of entries) expect(entry).toMatch(/Rule number \d( Rule number \d){5}/)
  })
})

describe("buildMemoryDigest bound", () => {
  it("returns null rather than a block over the bound when not even the frame fits", async () => {
    await seed([item({ id: "f1", polarity: "do" })])
    expect(await buildMemoryDigest(store, { anchors: ANCHORS, maxChars: 100 })).toBeNull()
  })
})

describe("decideMemoryInject", () => {
  it("uses the system prompt when the adapter declares system-prompt, none, or nothing", () => {
    for (const inject of [undefined, "none", "system-prompt"] as const) {
      expect(decideMemoryInject({ inject, supportsSystemPrompt: true })).toEqual({ path: "system-prompt" })
    }
  })

  it("routes a native-dir adapter to its native projection, with or without a system-prompt channel", () => {
    expect(decideMemoryInject({ inject: "native-dir", supportsSystemPrompt: true })).toEqual({ path: "native-dir" })
    expect(decideMemoryInject({ inject: "native-dir" })).toEqual({ path: "native-dir" })
    expect(decideMemoryInject({ inject: "native-dir", sandbox: true }).path).toBe("none")
  })

  it("skips an adapter with no usable system-prompt channel, and a sandbox spawn", () => {
    expect(decideMemoryInject({ supportsSystemPrompt: false }).path).toBe("none")
    expect(decideMemoryInject({ supportsSystemPrompt: true, sandbox: true }).path).toBe("none")
  })
})

// ── spawn wiring ────────────────────────────────────────────────────────

async function writeAgent(memoryLines: string[]): Promise<string> {
  const dir = join(root, "ws", ".agents", "scout")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    [
      "---",
      "schema: agent/v1",
      "id: scout",
      "description: Agent scout",
      "model: test-model",
      ...memoryLines,
      "---",
      "",
      "You are scout.",
    ].join("\n") + "\n",
    "utf8",
  )
  return path
}

function setup(caps: {
  supportsSystemPrompt?: boolean
  memoryInject?: "native-dir" | "system-prompt" | "none"
  memoryCapture?: "native-dir-diff" | "none"
}) {
  const session: AgentSessionLike = {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {},
    async cancel() {},
    async close() {},
  }
  const startSession = vi.fn(
    async (_opts: { appendSystemPrompt?: string; memoryProjection?: { items: readonly MemoryDocument[]; digest?: string } }) =>
      session,
  )
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter (agent)",
    ...caps,
  })
  const registry = createSessionsRegistry({ persist: false })
  const roots: string[] = []
  const memoryStoreAt = (r: string) => {
    roots.push(r)
    return store
  }
  return { startSession, roots, deps: { registry, resolveAgentAdapter, memoryStoreAt } }
}

describe("spawnAgentSession memory digest", () => {
  beforeEach(async () => {
    await seed([item({ id: "f-scout", polarity: "do", tags: ["agent:scout"] })])
  })

  it("appends the digest to the system prompt when the agent enables memory", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: true"])
    const { startSession, deps } = setup({ supportsSystemPrompt: true })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    const appended = startSession.mock.calls[0]![0].appendSystemPrompt ?? ""
    expect(appended).toContain("You are scout.")
    expect(appended).toContain("id: f-scout;")
    expect(appended.indexOf("You are scout.")).toBeLessThan(appended.indexOf("<agentproto-memory"))
  })

  it("resolves a workspace-relative memory.store against the session's workspace", async () => {
    const agentPath = await writeAgent(["memory:", "  store: ./team-memory"])
    const { roots, deps } = setup({ supportsSystemPrompt: true })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    expect(roots).toEqual([join(root, "ws", "team-memory")])
    if (result.ok) expect(result.descriptor.meta?.memoryStoreRoot).toBe(join(root, "ws", "team-memory"))
  })

  it("injects nothing when memory.enabled is false", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: false", "  anchors: [\"agent:scout\"]"])
    const { startSession, roots, deps } = setup({ supportsSystemPrompt: true })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(startSession.mock.calls[0]![0].appendSystemPrompt ?? "").not.toContain("<agentproto-memory")
    expect(roots).toEqual([])
    // The memory tools refuse this session's writes (AIP-42).
    expect(result.ok && result.descriptor.meta?.memory).toBe("disabled")
  })

  it("injects nothing when the manifest has no AIP-72 memory binding", async () => {
    const agentPath = await writeAgent(["memory:", "  scope: per-thread"])
    const { startSession, deps } = setup({ supportsSystemPrompt: true })
    await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(startSession.mock.calls[0]![0].appendSystemPrompt ?? "").not.toContain("<agentproto-memory")
  })

  it("hands a native-dir adapter the items and the fallback digest, never the system prompt", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: true"])
    const { startSession, deps } = setup({
      supportsSystemPrompt: true,
      memoryInject: "native-dir",
      memoryCapture: "native-dir-diff",
    })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    const opts = startSession.mock.calls[0]![0]
    const appended = opts.appendSystemPrompt ?? ""
    expect(appended).toContain("You are scout.")
    expect(appended).not.toContain("<agentproto-memory")
    expect(opts.memoryProjection?.items.map(i => i.id)).toEqual(["f-scout"])
    expect(opts.memoryProjection?.digest).toContain("id: f-scout;")
    // The capture runs only for this session, against the agent's store.
    if (result.ok) {
      expect(result.descriptor.meta).toMatchObject({
        memoryInject: "native-dir",
        memoryCapture: "native-dir-diff",
        memoryAnchors: "agent:scout,project:default",
      })
    }
  })

  it("gives a native-dir adapter without a system-prompt channel the items and no digest", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: true"])
    const { startSession, deps } = setup({ memoryInject: "native-dir" })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    const opts = startSession.mock.calls[0]![0]
    expect(opts.memoryProjection?.items).toHaveLength(1)
    expect(opts.memoryProjection?.digest).toBeUndefined()
    // No capture declared, no capture flag; the inject path is still recorded
    // so a respawn recomputes the projection.
    if (result.ok) {
      expect(result.descriptor.meta?.memoryCapture).toBeUndefined()
      expect(result.descriptor.meta?.memoryInject).toBe("native-dir")
    }
  })

  it("an agent with memory.enabled: false and a store records both, so its tools read that store and refuse writes", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: false", "  store: ./team-memory"])
    const { deps } = setup({ supportsSystemPrompt: true })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.meta).toMatchObject({
      memory: "disabled",
      memoryStoreRoot: join(root, "ws", "team-memory"),
    })
  })

  it("the async worktree path records the same role and memory meta as the sync path", async () => {
    const agentPath = await writeAgent(["memory:", "  enabled: false", "  store: ./team-memory"])
    const { deps } = setup({ supportsSystemPrompt: true })
    const result = await spawnAgentSession(
      {
        ...deps,
        provisionWorktree: async () => ({ isolated: true, cwd: join(root, "ws"), branch: "wt/scout" }),
        resolveWorktreeIsolation: async () => "on-request" as const,
      },
      { adapter: "mock", cwd: join(root, "ws"), prompt: "go", agentPath, role: "supervisor", worktree: { async: true } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    const expected = { role: "supervisor", memory: "disabled", memoryStoreRoot: join(root, "ws", "team-memory") }
    expect(deps.registry.get(result.descriptor.id)?.meta).toMatchObject(expected)
    await vi.waitFor(() => expect(deps.registry.get(result.descriptor.id)?.status).toBe("running"))
    expect(deps.registry.get(result.descriptor.id)?.meta).toMatchObject(expected)
  })

  it("records the resolved role on the descriptor for the commit gate", async () => {
    const { deps } = setup({ supportsSystemPrompt: true })
    const exec = await spawnAgentSession(deps, { adapter: "mock", cwd: join(root, "ws"), prompt: "go", role: "executor" })
    expect(exec.ok && exec.descriptor.meta?.role).toBe("executor")
  })
})
