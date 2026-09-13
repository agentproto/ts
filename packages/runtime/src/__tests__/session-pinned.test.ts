/**
 * Unit tests for the registry-level `setPinned` (sessions.ts) — the
 * write-path behind the `session_set_pinned` MCP verb and `POST
 * /sessions/:id/pin`. Covers set/clear, the `session:pinned-changed`
 * announcement, and persistence across a reload. Mirrors
 * session-keepalive.test.ts's shape — pin is a distinct, quiet
 * list-visibility flag, not the idle-reaper exemption.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-pinned-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("setPinned", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-pinned-test-"))
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

  it("is absent by default", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    expect(desc.pinned).toBeUndefined()
    reg.shutdown()
  })

  it("sets pinned true", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    const updated = reg.setPinned(desc.id, true)
    expect(updated.pinned).toBe(true)
    expect(reg.get(desc.id)?.pinned).toBe(true)
    reg.shutdown()
  })

  it("clears pinned back to false", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.setPinned(desc.id, true)
    const cleared = reg.setPinned(desc.id, false)
    expect(cleared.pinned).toBe(false)
    reg.shutdown()
  })

  it("never touches keepAlive", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.setPinned(desc.id, true)
    expect(reg.get(desc.id)?.keepAlive).toBeUndefined()
    reg.shutdown()
  })

  it("throws on an unknown session id", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(() => reg.setPinned("sess_nope", true)).toThrow(/no session/)
    reg.shutdown()
  })

  it("emits session:pinned-changed carrying the value now on the descriptor", () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })
    const desc = spawn(reg)

    reg.setPinned(desc.id, true)
    const pinned = events.find(e => e.type === "session:pinned-changed")
    expect(pinned).toMatchObject({ type: "session:pinned-changed", sessionId: desc.id, pinned: true })

    events.length = 0
    reg.setPinned(desc.id, false)
    const unpinned = events.find(e => e.type === "session:pinned-changed")
    expect(unpinned).toMatchObject({ type: "session:pinned-changed", sessionId: desc.id, pinned: false })
    reg.shutdown()
  })

  it("persists across a reload", () => {
    const reg1 = createSessionsRegistry({ persistPath })
    const desc = spawn(reg1)
    reg1.setPinned(desc.id, true)
    reg1.shutdown() // forces a synchronous flush (persist is debounced)

    const reg2 = createSessionsRegistry({ persistPath })
    expect(reg2.get(desc.id)?.pinned).toBe(true)
    reg2.shutdown()
  })
})
