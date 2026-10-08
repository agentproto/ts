/**
 * Retired sessions never revive. A session is RETIRED (`isRetired`) when it is
 * archived, ended with a deliberate `endedReason`, has a successor
 * (`continuedTo`), or carries a `retiredAt` stamp. No automated path may
 * revive one — in place or under a new id — and a human prompt to a row that
 * has a successor is refused with `session_superseded`.
 *
 * Incident: Pygmalion's replaced brain `sess_97f8303c` was revived in place by
 * a human prompt and became a duplicate brain, while follows/sentinels aimed
 * at dead brains were revived under NEW ids by follow digests / sentinel
 * notices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  isRetired,
  SessionRetiredError,
  type AgentSessionLike,
  type AgentSessionResumer,
  type SessionDescriptor,
  type SessionRetiredEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { isAutomatedPromptSource, resolveSuccessor } from "../session-retirement.js"
import { restartPreferInPlace } from "../session-restart-core.js"
import { makeRestartForRouting } from "../index.js"
import { createCronScheduler } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionFollowStore } from "../session-follow-store.js"
import { createSentinelStore } from "../sentinel-store.js"
import { wireRetirementCleanup } from "../retirement-cleanup.js"
import type { AgentAdapterResolver } from "../http-server.js"

type Row = Partial<SessionDescriptor> & { id: string }

function writeSessions(persistPath: string, rows: Row[]): void {
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-10-05T00:00:00Z",
      sessions: rows.map(r => ({
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "claude (agent)",
        pid: null,
        status: "killed",
        startedAt: "2026-10-05T00:00:00Z",
        busy: false,
        adapterSlug: "claude-code",
        adapterSessionId: `acp-${r.id}`,
        cwd: "/tmp",
        ...r,
      })),
    }),
  )
}

function healthyResumer(): AgentSessionResumer {
  return vi.fn(async () => {
    const fresh: AgentSessionLike = {
      sessionId: "acp-resumed",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return undefined
  } catch (err) {
    return err
  }
}

describe("isRetired / helpers", () => {
  it("is true for archived, deliberate endedReason, continuedTo, retiredAt — false otherwise", () => {
    expect(isRetired({})).toBe(false)
    expect(isRetired({ endedReason: "crashed" })).toBe(false)
    expect(isRetired({ endedReason: "idle-reaped" })).toBe(false)
    expect(isRetired({ archived: true })).toBe(true)
    expect(isRetired({ continuedTo: "sess_b" })).toBe(true)
    expect(isRetired({ retiredAt: "2026-10-05T00:00:00Z" })).toBe(true)
    for (const reason of ["operator-completed", "operator-stopped", "steward-completed", "steward-abandoned", "restarted"]) {
      expect(isRetired({ endedReason: reason })).toBe(true)
    }
  })

  it("only daemon/agent-driven prompt sources count as automated", () => {
    for (const s of ["session-follow", "sentinel", "restart", "boot", "cron", "child:sess_x", "agent:sess_x"]) {
      expect(isAutomatedPromptSource(s)).toBe(true)
    }
    for (const s of [undefined, "user", "http:chat", "telegram"]) {
      expect(isAutomatedPromptSource(s)).toBe(false)
    }
  })

  it("resolveSuccessor follows continuedTo transitively, is cycle-safe and stops at the last existing row", () => {
    const rows: Record<string, { continuedTo?: string }> = {
      a: { continuedTo: "b" },
      b: { continuedTo: "c" },
      c: {},
      x: { continuedTo: "y" },
      y: { continuedTo: "x" },
      m: { continuedTo: "gone" },
    }
    const get = (id: string) => rows[id]
    expect(resolveSuccessor(get, "a")).toBe("c")
    expect(resolveSuccessor(get, "c")).toBeUndefined()
    expect(resolveSuccessor(get, "m")).toBeUndefined()
    expect(resolveSuccessor(get, "x")).toBe("y")
  })
})

describe("registry: retired rows are not revived", () => {
  let tmp: string
  let persistPath: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "retired-sessions-"))
    persistPath = join(tmp, "sessions.json")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a human prompt to a continuedTo row gets session_superseded naming the successor — no revival", async () => {
    writeSessions(persistPath, [
      { id: "sess_old", endedReason: "restarted", continuedTo: "sess_new" },
      { id: "sess_new", status: "running" },
    ])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    const err = await rejection(reg.sendPrompt("sess_old", "hello"))
    expect(err).toBeInstanceOf(SessionRetiredError)
    expect((err as SessionRetiredError).code).toBe("session_superseded")
    expect((err as SessionRetiredError).continuedTo).toBe("sess_new")
    expect((err as Error).message).toContain("sess_new")
    expect(resumer).not.toHaveBeenCalled()
    expect(reg.get("sess_old")?.status).toBe("killed")
    reg.shutdown()
  })

  it("enqueuePrompt behaves the same (session_superseded)", async () => {
    writeSessions(persistPath, [{ id: "sess_old", continuedTo: "sess_new" }, { id: "sess_new" }])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    const err = await rejection(reg.enqueuePrompt("sess_old", "hello", {}))
    expect((err as SessionRetiredError).code).toBe("session_superseded")
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("an explicit forceResume lifts the refusal and clears the retirement", async () => {
    writeSessions(persistPath, [
      { id: "sess_old", endedReason: "restarted", continuedTo: "sess_new", retiredAt: "2026-10-05T00:00:00Z" },
      { id: "sess_new" },
    ])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    await reg.sendPrompt("sess_old", "hello", { forceResume: true })
    expect(resumer).toHaveBeenCalledTimes(1)
    const after = reg.get("sess_old")
    expect(after?.status).toBe("running")
    expect(after?.retiredAt).toBeUndefined()
    expect(after?.endedReason).toBeUndefined()
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("automated prompt sources never revive a retired row without a successor (session_retired)", async () => {
    writeSessions(persistPath, [
      { id: "sess_stopped", endedReason: "operator-stopped" },
      { id: "sess_arch", endedReason: "crashed", archived: true },
      { id: "sess_late", endedReason: "idle-reaped", retiredAt: "2026-10-05T00:00:00Z" },
    ])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    for (const id of ["sess_stopped", "sess_arch", "sess_late"]) {
      for (const source of ["session-follow", "sentinel", "child:sess_p", "agent:sess_p", "cron"]) {
        const err = await rejection(reg.enqueuePrompt(id, "hello", { source }))
        expect(err).toBeInstanceOf(SessionRetiredError)
        expect((err as SessionRetiredError).code).toBe("session_retired")
      }
    }
    expect(resumer).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("a HUMAN prompt to a deliberately-stopped row with no successor still revives it (explicit operator intent)", async () => {
    writeSessions(persistPath, [{ id: "sess_stopped", endedReason: "operator-stopped" }])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    await reg.sendPrompt("sess_stopped", "hello")
    expect(resumer).toHaveBeenCalledTimes(1)
    expect(reg.get("sess_stopped")?.status).toBe("running")
    expect(reg.get("sess_stopped")?.endedReason).toBeUndefined()
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("an automated source still revives a NON-retired dead row (crashed / daemon-restart unaffected)", async () => {
    writeSessions(persistPath, [{ id: "sess_crashed", status: "error", endedReason: "crashed" }])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    await reg.enqueuePrompt("sess_crashed", "hello", { source: "session-follow" })
    expect(resumer).toHaveBeenCalledTimes(1)
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("triggerResume refuses a retired row unless forced", async () => {
    writeSessions(persistPath, [{ id: "sess_stopped", endedReason: "operator-stopped" }])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    await expect(reg.triggerResume("sess_stopped")).resolves.toBe(false)
    expect(resumer).not.toHaveBeenCalled()
    await expect(reg.triggerResume("sess_stopped", { force: true })).resolves.toBe(true)
    expect(resumer).toHaveBeenCalledTimes(1)
    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("boot-time eager resume skips retired rows", async () => {
    writeSessions(persistPath, [
      { id: "sess_old", status: "running", continuedTo: "sess_new" },
      { id: "sess_new", status: "running" },
    ])
    const reg = createSessionsRegistry({ persistPath, resumeAgent: healthyResumer() })
    const outcome = await reg.resumeOnBoot("sess_old")
    expect(outcome).toEqual({ status: "skipped", reason: "retired" })
    reg.shutdown()
  })
})

describe("registry: retirement stamping + events", () => {
  function spawn(reg: SessionsRegistry, label = "x"): SessionDescriptor {
    return reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      adapterSlug: "fake",
      label,
      agentSession: {
        sessionId: `acp_${label}`,
        async *send() {},
        async cancel() {},
        async close() {},
      },
    })
  }

  it("a kill with a deliberate reason retires the row and notifies listeners; plain kill does not", () => {
    const reg = createSessionsRegistry({ persist: false })
    const events: SessionRetiredEvent[] = []
    const off = reg.onSessionRetired(ev => events.push(ev))
    const a = spawn(reg, "a")
    const b = spawn(reg, "b")
    reg.kill(a.id)
    expect(events).toEqual([])
    reg.kill(b.id, undefined, "operator-stopped")
    expect(events).toEqual([{ sessionId: b.id, cause: "killed" }])
    expect(isRetired(reg.get(b.id)!)).toBe(true)
    expect(reg.get(b.id)?.retiredAt).toEqual(expect.any(String))
    off()
    reg.shutdown()
  })

  it("killing an already-ended row with a deliberate reason stamps retiredAt (a stopped brain that had already died)", () => {
    const reg = createSessionsRegistry({ persist: false })
    const a = spawn(reg, "a")
    reg.kill(a.id, undefined, "idle-reaped")
    expect(isRetired(reg.get(a.id)!)).toBe(false)
    expect(reg.kill(a.id, undefined, "operator-stopped")).toBe(true)
    expect(isRetired(reg.get(a.id)!)).toBe(true)
    reg.shutdown()
  })

  it("archive retires; markRetired sets continuedTo; a listener that throws never breaks retirement", () => {
    const reg = createSessionsRegistry({ persist: false })
    const events: SessionRetiredEvent[] = []
    reg.onSessionRetired(() => {
      throw new Error("boom")
    })
    reg.onSessionRetired(ev => events.push(ev))
    const a = spawn(reg, "a")
    const b = spawn(reg, "b")
    reg.kill(a.id)
    reg.archiveSession(a.id)
    expect(events[0]).toEqual({ sessionId: a.id, cause: "archived" })
    const marked = reg.markRetired(b.id, { continuedTo: a.id, cause: "continued" })
    expect(marked?.continuedTo).toBe(a.id)
    expect(events[1]).toEqual({ sessionId: b.id, cause: "continued", continuedTo: a.id })
    reg.shutdown()
  })
})

describe("restartPreferInPlace / makeRestartForRouting", () => {
  const resolver: AgentAdapterResolver = async () => ({
    startSession: vi.fn(async () => ({
      sessionId: "acp-new",
      async *send() {},
      async cancel() {},
      async close() {},
    })) as never,
    commandPreview: "mock",
  })

  function setup(rows: Row[]) {
    const tmp = mkdtempSync(join(tmpdir(), "retired-restart-"))
    const persistPath = join(tmp, "sessions.json")
    writeSessions(persistPath, rows)
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    return { reg, resumer, cleanup: () => (reg.shutdown(), rmSync(tmp, { recursive: true, force: true })) }
  }

  it("refuses a retired row on the AUTOMATIC path: no in-place resume AND no fresh-id restart", async () => {
    const { reg, resumer, cleanup } = setup([{ id: "sess_stopped", endedReason: "operator-stopped" }])
    try {
      const before = reg.list().length
      const err = await rejection(restartPreferInPlace(reg, resolver, reg.get("sess_stopped")!, { forceAgentResume: true }))
      expect(err).toBeInstanceOf(SessionRetiredError)
      expect(resumer).not.toHaveBeenCalled()
      expect(reg.list().length).toBe(before)
    } finally {
      cleanup()
    }
  })

  it("the human-intent path (allowDeliberateEnd) still revives a deliberate end in place", async () => {
    const { reg, resumer, cleanup } = setup([{ id: "sess_stopped", endedReason: "operator-stopped" }])
    try {
      const r = await restartPreferInPlace(reg, resolver, reg.get("sess_stopped")!, {
        forceAgentResume: true,
        allowDeliberateEnd: true,
      })
      expect(r.sameId).toBe(true)
      expect(resumer).toHaveBeenCalledTimes(1)
      await new Promise(res => setTimeout(res, 20))
    } finally {
      cleanup()
    }
  })

  it("makeRestartForRouting routes a superseded row to its live successor (transitively) instead of restarting it", async () => {
    const { reg, resumer, cleanup } = setup([
      { id: "sess_a", endedReason: "restarted", continuedTo: "sess_b" },
      { id: "sess_b", endedReason: "restarted" },
    ])
    try {
      const live = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        agentSession: { sessionId: "acp_live", async *send() {}, async cancel() {}, async close() {} },
      })
      reg.markRetired("sess_b", { continuedTo: live.id, cause: "continued" })
      for (const allowDeliberateEnd of [false, true]) {
        const restart = makeRestartForRouting(
          { sessions: reg, resolveAgentAdapter: resolver },
          { name: "t", allowDeliberateEnd },
        )
        await expect(restart("sess_a")).resolves.toBe(live.id)
      }
      expect(resumer).not.toHaveBeenCalled()
      expect(reg.get("sess_a")?.status).toBe("killed")
    } finally {
      cleanup()
    }
  })

  it("makeRestartForRouting revives a DEAD non-retired successor, never the retired row", async () => {
    const { reg, resumer, cleanup } = setup([
      { id: "sess_a", endedReason: "restarted", continuedTo: "sess_b" },
      { id: "sess_b", endedReason: "idle-reaped" },
    ])
    try {
      const restart = makeRestartForRouting(
        { sessions: reg, resolveAgentAdapter: resolver },
        { name: "t", allowDeliberateEnd: false },
      )
      await expect(restart("sess_a")).resolves.toBe("sess_b")
      expect(resumer).toHaveBeenCalledTimes(1)
      expect(reg.get("sess_a")?.status).toBe("killed")
      await new Promise(res => setTimeout(res, 20))
    } finally {
      cleanup()
    }
  })

  it("makeRestartForRouting refuses when the whole chain is retired (no zombie)", async () => {
    const { reg, resumer, cleanup } = setup([
      { id: "sess_a", endedReason: "restarted", continuedTo: "sess_b" },
      { id: "sess_b", endedReason: "operator-stopped" },
    ])
    try {
      const restart = makeRestartForRouting(
        { sessions: reg, resolveAgentAdapter: resolver },
        { name: "t", allowDeliberateEnd: true },
      )
      const err = await rejection(restart("sess_a"))
      expect(err).toBeInstanceOf(SessionRetiredError)
      expect((err as SessionRetiredError).continuedTo).toBe("sess_b")
      expect(resumer).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })
})

describe("cron prompt-session on a retired session", () => {
  function setup(rows: Row[]) {
    const tmp = mkdtempSync(join(tmpdir(), "retired-cron-"))
    const persistPath = join(tmp, "sessions.json")
    writeSessions(persistPath, rows)
    const sessionEvents = createSessionEventBus()
    const reg = createSessionsRegistry({ persistPath, sessionEvents, resumeAgent: healthyResumer() })
    // A persisted pid-less ACP row never reads `processAlive: false`; project it.
    const view = {
      ...reg,
      get: (id: string) => {
        const d = reg.get(id)
        return d && d.status !== "running" ? { ...d, processAlive: false } : d
      },
    } as SessionsRegistry
    const startSession = vi.fn()
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: startSession as never,
      commandPreview: "mock",
    })
    const scheduler = createCronScheduler({ sessionEvents, registry: view, resolveAgentAdapter, workspace: tmp })
    return {
      reg,
      scheduler,
      startSession,
      cleanup: () => (scheduler.shutdown(), reg.shutdown(), rmSync(tmp, { recursive: true, force: true })),
    }
  }

  it("a retired dead session is neither revived nor re-minted; the tick fails", async () => {
    const { reg, scheduler, startSession, cleanup } = setup([{ id: "sess_stopped", endedReason: "operator-stopped" }])
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_stopped", prompt: "wake" },
      })
      const result = await scheduler.run(job.id)
      expect(result?.ok).toBe(false)
      expect(startSession).not.toHaveBeenCalled()
      expect(reg.list()).toHaveLength(1)
      expect(reg.get("sess_stopped")?.status).toBe("killed")
    } finally {
      cleanup()
    }
  })
})

describe("wireRetirementCleanup", () => {
  function setup(rows: Row[]) {
    const reg = createSessionsRegistry({ persist: false })
    const followStore = createSessionFollowStore({ persist: false })
    const sentinelStore = createSentinelStore({ persist: false })
    const cancelSentinel = vi.fn(async (id: string) => {
      sentinelStore.remove(id)
    })
    wireRetirementCleanup({ registry: reg, followStore, sentinelStore, cancelSentinel, log: () => {} })
    const ids = rows.map(r =>
      reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        label: r.id,
        agentSession: { sessionId: `acp_${r.id}`, async *send() {}, async cancel() {}, async close() {} },
      }).id,
    )
    return { reg, followStore, sentinelStore, cancelSentinel, ids }
  }

  const watch = (store: ReturnType<typeof createSentinelStore>, sessionId: string) =>
    store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:w", cursor: "0" },
      spec: {
        match: [{ subject: "fake:w", types: ["*"] }],
        until: { kind: "never" },
        target: { kind: "session", sessionId, urgency: "fyi" },
      },
    } as never)

  it("continuing a session re-points its follows and sentinels at the successor", () => {
    const { reg, followStore, sentinelStore, ids } = setup([{ id: "old" }, { id: "new" }])
    const [oldId, newId] = ids as [string, string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    reg.markRetired(oldId, { continuedTo: newId, cause: "continued" })
    expect(followStore.list()[0]!.follower).toBe(newId)
    const target = sentinelStore.get(s.id)!.spec.target
    expect(target.kind === "session" && target.sessionId).toBe(newId)
  })

  it("archiving a session with no successor deletes its follows and cancels its sentinels", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }])
    const [oldId] = ids as [string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    reg.kill(oldId)
    reg.archiveSession(oldId)
    expect(followStore.list()).toHaveLength(0)
    expect(cancelSentinel).toHaveBeenCalledWith(s.id)
  })

  it("killing (without a successor yet) leaves follows/sentinels in place so a replacement can migrate them", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }])
    const [oldId] = ids as [string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    watch(sentinelStore, oldId)
    reg.kill(oldId, undefined, "operator-stopped")
    expect(followStore.list()).toHaveLength(1)
    expect(cancelSentinel).not.toHaveBeenCalled()
  })
})
