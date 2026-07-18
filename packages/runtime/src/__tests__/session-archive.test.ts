/**
 * Unit tests for the registry-level `archiveSession`/`unarchiveSession`
 * (sessions.ts) and `list()`'s default-hide / `includeArchived` opt-in.
 *
 * Archive is pure housekeeping (a visibility flag, no daemon consequence)
 * guarded so only a terminal-status session can be archived — see
 * `archiveSession`'s docblock on the `SessionsRegistry` interface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-archive-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("archiveSession / unarchiveSession", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-archive-test-"))
    persistPath = join(tmp, "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("refuses to archive a still-alive (running) session", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    expect(desc.status).toBe("running") // sanity

    expect(() => reg.archiveSession(desc.id)).toThrow(/still running/)
    expect(reg.get(desc.id)?.archived).not.toBe(true)

    reg.shutdown()
  })

  it("archives a terminal-status session, hides it from list()'s default view, and list({includeArchived:true}) still shows it", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    reg.kill(desc.id)
    expect(reg.get(desc.id)?.status).toBe("killed") // sanity: now terminal

    const archived = reg.archiveSession(desc.id)
    expect(archived.archived).toBe(true)

    expect(reg.list().some(s => s.id === desc.id)).toBe(false)
    expect(reg.list({ includeArchived: true }).some(s => s.id === desc.id)).toBe(true)

    // get() and findByIdOrName() are unaffected by the flag — a transcript
    // stays directly openable no matter how it's archived.
    expect(reg.get(desc.id)?.id).toBe(desc.id)
    expect(reg.findByIdOrName(desc.id)?.id).toBe(desc.id)

    reg.shutdown()
  })

  it("unarchive restores default-list visibility", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    reg.kill(desc.id)
    reg.archiveSession(desc.id)
    expect(reg.list().some(s => s.id === desc.id)).toBe(false)

    const restored = reg.unarchiveSession(desc.id)
    expect(restored.archived).toBe(false)
    expect(reg.list().some(s => s.id === desc.id)).toBe(true)

    reg.shutdown()
  })

  it("archiving an already-archived session is an idempotent no-op success", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    reg.kill(desc.id)
    reg.archiveSession(desc.id)
    expect(() => reg.archiveSession(desc.id)).not.toThrow()
    expect(reg.get(desc.id)?.archived).toBe(true)

    reg.shutdown()
  })

  it("throws on an unknown session id for both verbs", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(() => reg.archiveSession("sess_nope")).toThrow(/no session/)
    expect(() => reg.unarchiveSession("sess_nope")).toThrow(/no session/)
    reg.shutdown()
  })

  it("persists archived across a reload (round-trips through the history snapshot)", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = reg1.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    reg1.kill(desc.id)
    reg1.archiveSession(desc.id)
    // Force a synchronous flush — persist is debounced.
    reg1.shutdown()

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.archived).toBe(true)
    expect(reg2.list().some(s => s.id === desc.id)).toBe(false)
    expect(reg2.list({ includeArchived: true }).some(s => s.id === desc.id)).toBe(true)
    reg2.shutdown()
  })
})
