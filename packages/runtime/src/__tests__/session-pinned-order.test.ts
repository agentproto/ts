/**
 * Unit tests for the stored pinned order (sessions.ts) — the
 * `SessionDescriptor.pinnedOrder` field behind `registry.setPinned`'s
 * append-at-end semantics and `registry.reorderPinned`'s manual reorder,
 * plus the pure `computePinnedOrder` helper and the
 * `session:pinned-reordered` event. Mirrors session-pinned.test.ts's
 * shape — pin order is quiet list-visibility state, not the
 * idle-reaper exemption.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  computePinnedOrder,
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-pinned-order-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("pinnedOrder", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-pinned-order-test-"))
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

  const reg = (sessionEvents?: ReturnType<typeof createSessionEventBus>) =>
    createSessionsRegistry({ persistPath, persist: false, ...(sessionEvents ? { sessionEvents } : {}) })

  it("is absent by default", () => {
    const r = reg()
    const desc = spawn(r)
    expect(desc.pinnedOrder).toBeUndefined()
    r.shutdown()
  })

  it("appends a new pin AFTER legacy pins that have no order yet", () => {
    const r = reg()
    const legacy = spawn(r)
    const fresh = spawn(r)
    legacy.pinned = true
    r.setPinned(fresh.id, true)
    expect(r.get(legacy.id)?.pinnedOrder).toBe(0)
    expect(r.get(fresh.id)?.pinnedOrder).toBe(1)
    r.shutdown()
  })

  it("appends at the end as sessions are pinned", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    const c = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    r.setPinned(c.id, true)
    expect(r.get(a.id)?.pinnedOrder).toBe(0)
    expect(r.get(b.id)?.pinnedOrder).toBe(1)
    expect(r.get(c.id)?.pinnedOrder).toBe(2)
    r.shutdown()
  })

  it("a re-pin of an already pinned session keeps its order", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    const again = r.setPinned(a.id, true)
    expect(again.pinnedOrder).toBe(0)
    expect(r.get(b.id)?.pinnedOrder).toBe(1)
    r.shutdown()
  })

  it("unpinning deletes pinnedOrder; re-pinning appends after the current tail", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    const c = spawn(r)
    const d = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    r.setPinned(c.id, true)
    r.setPinned(b.id, false)
    expect(r.get(b.id)?.pinned).toBe(false)
    expect(r.get(b.id)?.pinnedOrder).toBeUndefined()
    const repinned = r.setPinned(d.id, true)
    expect(repinned.pinnedOrder).toBe(3)
    r.shutdown()
  })

  it("a session update does NOT change the stored order", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    // A rename is a descriptor write-path mutation — it must not disturb
    // the pinned order the way a recent-activity bump used to.
    r.renameSession(b.id, { title: "renamed" })
    expect(r.get(a.id)?.pinnedOrder).toBe(0)
    expect(r.get(b.id)?.pinnedOrder).toBe(1)
    r.shutdown()
  })

  it("reorderPinned assigns 0..n-1 in the given order and returns the descriptors in the new order", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    const c = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    r.setPinned(c.id, true)
    const reordered = r.reorderPinned([c.id, a.id])
    expect(reordered.map(d => d.id)).toEqual([c.id, a.id, b.id])
    expect(r.get(c.id)?.pinnedOrder).toBe(0)
    expect(r.get(a.id)?.pinnedOrder).toBe(1)
    expect(r.get(b.id)?.pinnedOrder).toBe(2)
    r.shutdown()
  })

  it("reorderPinned keeps unlisted pinned sessions after the listed ones, in their relative order", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    const c = spawn(r)
    const d = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    r.setPinned(c.id, true)
    r.setPinned(d.id, true)
    const reordered = r.reorderPinned([d.id, b.id])
    expect(reordered.map(d => d.id)).toEqual([d.id, b.id, a.id, c.id])
    expect(r.get(d.id)?.pinnedOrder).toBe(0)
    expect(r.get(b.id)?.pinnedOrder).toBe(1)
    expect(r.get(a.id)?.pinnedOrder).toBe(2)
    expect(r.get(c.id)?.pinnedOrder).toBe(3)
    r.shutdown()
  })

  it("reorderPinned throws on an unknown id", () => {
    const r = reg()
    const a = spawn(r)
    r.setPinned(a.id, true)
    expect(() => r.reorderPinned([a.id, "sess_nope"])).toThrow(/^reorderPinned: /)
    r.shutdown()
  })

  it("reorderPinned throws on an unpinned id", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    r.setPinned(a.id, true)
    expect(() => r.reorderPinned([a.id, b.id])).toThrow(/^reorderPinned: /)
    r.shutdown()
  })

  it("reorderPinned rejects duplicates", () => {
    const r = reg()
    const a = spawn(r)
    const b = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)
    expect(() => r.reorderPinned([a.id, b.id, a.id])).toThrow(/^reorderPinned: /)
    r.shutdown()
  })

  it("emits session:pinned-reordered carrying the requested ids", () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const r = reg(bus)
    const a = spawn(r)
    const b = spawn(r)
    r.setPinned(a.id, true)
    r.setPinned(b.id, true)

    r.reorderPinned([b.id, a.id])
    const ev = events.find(e => e.type === "session:pinned-reordered")
    expect(ev).toMatchObject({ type: "session:pinned-reordered", ids: [b.id, a.id] })
    r.shutdown()
  })

  it("persists across a reload", () => {
    const r1 = createSessionsRegistry({ persistPath })
    const a = spawn(r1)
    const b = spawn(r1)
    const c = spawn(r1)
    r1.setPinned(a.id, true)
    r1.setPinned(b.id, true)
    r1.setPinned(c.id, true)
    r1.reorderPinned([c.id, a.id, b.id])
    r1.shutdown() // forces a synchronous flush (persist is debounced)

    const r2 = createSessionsRegistry({ persistPath })
    expect(r2.get(c.id)?.pinnedOrder).toBe(0)
    expect(r2.get(a.id)?.pinnedOrder).toBe(1)
    expect(r2.get(b.id)?.pinnedOrder).toBe(2)
    r2.shutdown()
  })
})

describe("computePinnedOrder", () => {
  const pinned = (id: string, over: Partial<SessionDescriptor> = {}): SessionDescriptor => ({
    id,
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude-code --print",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  })

  it("assigns listed ids 0..n-1 in the given order and keeps unlisted rows after", () => {
    const order = computePinnedOrder(
      [pinned("a", { pinned: true, pinnedOrder: 0 }), pinned("b", { pinned: true, pinnedOrder: 1 }), pinned("c", { pinned: true, pinnedOrder: 2 })],
      ["c", "a"],
    )
    expect(order.get("c")).toBe(0)
    expect(order.get("a")).toBe(1)
    expect(order.get("b")).toBe(2)
  })

  it("sorts legacy pinned rows (no pinnedOrder) by startedAt asc then id, after ordered rows", () => {
    const order = computePinnedOrder(
      [
        pinned("a", { pinned: true, pinnedOrder: 5 }),
        pinned("z", { pinned: true, startedAt: "2026-01-02T00:00:00Z" }),
        pinned("b", { pinned: true, startedAt: "2026-01-01T00:00:00Z" }),
        pinned("c", { pinned: true, startedAt: "2026-01-01T00:00:00Z" }),
      ],
      ["a"],
    )
    expect(order.get("a")).toBe(0)
    // b and c share startedAt — id breaks the tie; z is newest so last.
    expect(order.get("b")).toBe(1)
    expect(order.get("c")).toBe(2)
    expect(order.get("z")).toBe(3)
  })
})
