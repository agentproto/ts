/**
 * Unit: `session:archive` decides from the descriptor and the durable
 * `archived` flag before it calls the archive primitive.
 */

import { describe, expect, it, vi } from "vitest"

import type { SessionDescriptor } from "../sessions.js"
import {
  createActionRegistry,
  createSessionArchiveAction,
  SESSION_ARCHIVE_ACTION_ID,
  type ActionHandler,
  type ActionRunInput,
} from "../action-hooks/index.js"

function descriptor(id: string, over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude",
    pid: null,
    status: "exited",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as SessionDescriptor
}

function fakeSessions(initial: SessionDescriptor[]) {
  const rows = new Map(initial.map(row => [row.id, row]))
  const archiveSession = vi.fn((id: string): SessionDescriptor => {
    const row = rows.get(id)
    if (!row) throw new Error(`archiveSession: no session "${id}"`)
    if (row.status === "running" || row.status === "starting") {
      throw new Error(`archiveSession: session "${id}" is still ${row.status}`)
    }
    row.archived = true
    row.archivedAt = "2026-01-02T00:00:00.000Z"
    return row
  })
  return {
    rows,
    archiveSession,
    sessions: {
      get: (id: string) => rows.get(id),
      archiveSession,
    },
  }
}

function input(sessionId: string, over: Partial<ActionRunInput> = {}): ActionRunInput {
  return {
    receiptKey: "k",
    sessionId,
    event: "agentproto:session-completed",
    occurrenceId: "exit:1",
    bindingId: "routine:archive-finished-children",
    reactionDepth: 0,
    ...over,
  }
}

describe("session:archive action", () => {
  it("skips a missing session", async () => {
    const fake = fakeSessions([])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("missing"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:session_missing",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("skips an already archived session without calling the primitive", async () => {
    const fake = fakeSessions([descriptor("s1", { archived: true })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:already_archived",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("skips a running session", async () => {
    const fake = fakeSessions([descriptor("s1", { status: "running" })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:alive",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("skips a starting session", async () => {
    const fake = fakeSessions([descriptor("s1", { status: "starting" })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:alive",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("skips a pinned session", async () => {
    const fake = fakeSessions([descriptor("s1", { pinned: true })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:pinned",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("skips a keepAlive session", async () => {
    const fake = fakeSessions([descriptor("s1", { keepAlive: true })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:keep_alive",
    })
    expect(fake.archiveSession).not.toHaveBeenCalled()
  })

  it("archives a terminal unpinned session once", async () => {
    const fake = fakeSessions([descriptor("s1")])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "archived",
    })
    expect(fake.archiveSession).toHaveBeenCalledTimes(1)
    expect(fake.rows.get("s1")?.archived).toBe(true)
  })

  it("returns a retryable failure with the clipped message when archiveSession throws", async () => {
    const fake = fakeSessions([descriptor("s1")])
    const failure = "boom ".repeat(200)
    fake.archiveSession.mockImplementation(() => {
      throw new Error(failure)
    })
    const log = vi.fn()
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log })
    const outcome = await handler.run(input("s1"))
    expect(outcome.ok).toBe(false)
    expect(outcome.retryable).toBe(true)
    expect(outcome.error).toHaveLength(500)
    expect(outcome.error).toBe(failure.slice(0, 500))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain("s1")
  })

  it("treats a revival between the check and the primitive as skipped:alive, not a retryable failure", async () => {
    const fake = fakeSessions([descriptor("s1")])
    fake.archiveSession.mockImplementation((id: string) => {
      const row = fake.rows.get(id)
      if (row) row.status = "running"
      throw new Error(`archiveSession: session "${id}" is still running`)
    })
    const log = vi.fn()
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log })
    await expect(handler.run(input("s1"))).resolves.toEqual({ ok: true, outcomeRef: "skipped:alive" })
    expect(log).not.toHaveBeenCalled()
  })

  it("treats a concurrent archive between the check and the primitive as skipped:already_archived", async () => {
    const fake = fakeSessions([descriptor("s1")])
    fake.archiveSession.mockImplementation((id: string) => {
      const row = fake.rows.get(id)
      if (row) row.archived = true
      throw new Error("archiveSession: lost a race")
    })
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({
      ok: true,
      outcomeRef: "skipped:already_archived",
    })
  })

  it("archives a session that has a successor, because hiding the predecessor is the intent", async () => {
    const fake = fakeSessions([descriptor("s1", { continuedTo: "s2" })])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(handler.run(input("s1"))).resolves.toEqual({ ok: true, outcomeRef: "archived" })
  })

  it("ignores authored inputs", async () => {
    const fake = fakeSessions([descriptor("s1")])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    await expect(
      handler.run(input("s1", { inputs: { archive: false, reason: "manual" } })),
    ).resolves.toEqual({ ok: true, outcomeRef: "archived" })
    expect(fake.archiveSession).toHaveBeenCalledTimes(1)
  })

  it("is idempotent", () => {
    const fake = fakeSessions([])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    expect(handler.idempotent).toBe(true)
    expect(handler.actionId).toBe(SESSION_ARCHIVE_ACTION_ID)
  })

  it("registers under its id and refuses a duplicate", () => {
    const fake = fakeSessions([])
    const handler = createSessionArchiveAction({ sessions: fake.sessions, log: () => {} })
    const other: ActionHandler = {
      actionId: "demo:other",
      idempotent: false,
      run: async () => ({ ok: true }),
    }
    const registry = createActionRegistry([other])
    registry.register(handler)
    expect(registry.get(SESSION_ARCHIVE_ACTION_ID)).toBe(handler)
    expect(registry.list()).toHaveLength(2)
    expect(() => registry.register(handler)).toThrowError(/already registered/)
    try {
      registry.register(handler)
    } catch (err) {
      expect((err as { code?: string }).code).toBe("duplicate")
    }
  })
})
