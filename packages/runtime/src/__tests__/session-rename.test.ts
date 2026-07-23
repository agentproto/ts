/**
 * Unit tests for the registry-level `renameSession` (sessions.ts) — the
 * write-path behind `PATCH /sessions/:id` and the `session_rename` MCP verb
 * (SPEC-3 FIX B). Covers the title/label target, clear-on-empty, the length
 * cap, the `session:renamed` announcement, and persistence across a reload.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-rename-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("renameSession", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-rename-test-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawn = (reg: ReturnType<typeof createSessionsRegistry>) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })

  it("writes label (a user rename's target) and leaves title untouched", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.renameSession(desc.id, { title: "derived title" }) // seed a title
    const renamed = reg.renameSession(desc.id, { label: "My Session" })
    expect(renamed.label).toBe("My Session")
    expect(renamed.title).toBe("derived title") // label write never touched title
    reg.shutdown()
  })

  it("flags renamedByUser=true — a user rename must outrank the derived title", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
      label: "spawn-slug",
    })
    // A spawn label is not a user rename — it's flagged false so the title wins.
    expect(reg.get(desc.id)?.renamedByUser).toBe(false)
    const renamed = reg.renameSession(desc.id, { label: "My Session" })
    expect(renamed.renamedByUser).toBe(true)
    reg.shutdown()
  })

  it("carries renamedByUser onto the session:renamed event", () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })
    const desc = spawn(reg)
    reg.renameSession(desc.id, { label: "Named" })
    const renamed = events.find(e => e.type === "session:renamed")
    expect(renamed).toMatchObject({ type: "session:renamed", renamedByUser: true })
    reg.shutdown()
  })

  it("persists renamedByUser across a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = spawn(reg1)
    reg1.renameSession(desc.id, { label: "Persisted Rename" })
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.renamedByUser).toBe(true)
    reg2.shutdown()
  })

  it("writes title independently", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    const renamed = reg.renameSession(desc.id, { title: "Fix the login bug" })
    expect(renamed.title).toBe("Fix the login bug")
    expect(renamed.label).toBeUndefined()
    reg.shutdown()
  })

  it("trims whitespace around a new name", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    expect(reg.renameSession(desc.id, { label: "  spaced  " }).label).toBe("spaced")
    reg.shutdown()
  })

  it("clears the field on an empty / whitespace-only string or null", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.renameSession(desc.id, { label: "temporary" })
    expect(reg.get(desc.id)?.label).toBe("temporary")

    expect(reg.renameSession(desc.id, { label: "" }).label).toBeUndefined()

    reg.renameSession(desc.id, { label: "again" })
    expect(reg.renameSession(desc.id, { label: "   " }).label).toBeUndefined()

    reg.renameSession(desc.id, { label: "third" })
    expect(reg.renameSession(desc.id, { label: null }).label).toBeUndefined()
    reg.shutdown()
  })

  it("leaves a field untouched when its key is omitted (undefined)", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.renameSession(desc.id, { label: "keep-me", title: "keep-title" })
    // Only clear the label; title must survive.
    const renamed = reg.renameSession(desc.id, { label: null })
    expect(renamed.label).toBeUndefined()
    expect(renamed.title).toBe("keep-title")
    reg.shutdown()
  })

  it("caps a too-long name at MAX_LENGTH (72) code points", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    const long = "x".repeat(200)
    const renamed = reg.renameSession(desc.id, { label: long })
    expect(Array.from(renamed.label ?? "")).toHaveLength(72)
    reg.shutdown()
  })

  it("caps by CODE POINT, never splitting an astral char at the boundary", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    // 73 emoji — one past the cap. A UTF-16-unit slice would orphan a surrogate.
    const renamed = reg.renameSession(desc.id, { label: "😀".repeat(73) })
    const points = Array.from(renamed.label ?? "")
    expect(points).toHaveLength(72)
    expect(points.every(p => p === "😀")).toBe(true)
    reg.shutdown()
  })

  it("emits session:renamed carrying the values now on the descriptor", () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })
    const desc = spawn(reg)

    reg.renameSession(desc.id, { label: "Named" })
    const renamed = events.find(e => e.type === "session:renamed")
    expect(renamed).toMatchObject({ type: "session:renamed", sessionId: desc.id, label: "Named" })

    // A clear announces the field as ABSENT, mirroring the descriptor.
    events.length = 0
    reg.renameSession(desc.id, { label: "" })
    const cleared = events.find(e => e.type === "session:renamed")
    expect(cleared).toBeDefined()
    expect((cleared as { label?: string }).label).toBeUndefined()
    reg.shutdown()
  })

  it("throws on an unknown session id", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(() => reg.renameSession("sess_nope", { label: "x" })).toThrow(/no session/)
    reg.shutdown()
  })

  it("persists a rename across a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = spawn(reg1)
    reg1.renameSession(desc.id, { label: "Persisted Name" })
    reg1.shutdown() // forces a synchronous flush (persist is debounced)

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.label).toBe("Persisted Name")
    reg2.shutdown()
  })
})
