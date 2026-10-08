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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { registerAgentTools } from "../agent-tools.js"
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
import { isAutomatedPromptSource, resolveSuccessor, retireSession } from "../session-retirement.js"
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
    for (const s of [
      "session-follow", "sentinel", "restart", "boot", "cron", "child:sess_x", "agent:sess_x",
      "daemon:continue-interrupted", "daemon:handoff", "workflow:agent-step", "policy",
    ]) {
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

  it("a refused triggerResume on a retired row clears its landed nextRestartAt so the sweep stops re-picking it", async () => {
    writeSessions(persistPath, [
      {
        id: "sess_old",
        endedReason: "crashed",
        continuedTo: "sess_new",
        nextRestartAt: "2026-10-05T00:00:00Z",
        restartAttempts: 1,
      },
      { id: "sess_new", status: "running" },
    ])
    const resumer = healthyResumer()
    const reg = createSessionsRegistry({ persistPath, resumeAgent: resumer })
    expect(reg.get("sess_old")?.nextRestartAt).toBeDefined()
    await expect(reg.triggerResume("sess_old")).resolves.toBe(false)
    expect(resumer).not.toHaveBeenCalled()
    expect(reg.get("sess_old")?.nextRestartAt).toBeUndefined()
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

describe("continuedTo is stamped only once the successor is provisioned (pending spawn)", () => {
  const agentSession = (): AgentSessionLike => ({
    sessionId: "acp_new",
    async *send() {},
    async cancel() {},
    async close() {},
  })

  const prior = (reg: SessionsRegistry): SessionDescriptor => {
    const d = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      adapterSlug: "fake",
      label: "prior",
      agentSession: { sessionId: "acp_prior", async *send() {}, async cancel() {}, async close() {} },
    })
    reg.kill(d.id)
    return d
  }

  it("a placeholder that is still provisioning does not yet supersede the prior row", () => {
    const reg = createSessionsRegistry({ persist: false })
    const old = prior(reg)
    reg.spawnAgentPending({ workspaceSlug: "default", cwd: "/tmp", adapterSlug: "fake", resumedFrom: old.id })
    expect(reg.get(old.id)?.continuedTo).toBeUndefined()
    reg.shutdown()
  })

  it("a failed provision never leaves the prior row pointing at a successor that did not come up", () => {
    const reg = createSessionsRegistry({ persist: false })
    const old = prior(reg)
    const pending = reg.spawnAgentPending({ workspaceSlug: "default", cwd: "/tmp", adapterSlug: "fake", resumedFrom: old.id })
    reg.settlePendingAgent(pending.id, { ok: false, message: "worktree add failed" })
    expect(reg.get(pending.id)?.status).toBe("error")
    expect(reg.get(old.id)?.continuedTo).toBeUndefined()
    reg.shutdown()
  })

  it("a successful provision stamps continuedTo on the prior row", () => {
    const reg = createSessionsRegistry({ persist: false })
    const old = prior(reg)
    const pending = reg.spawnAgentPending({ workspaceSlug: "default", cwd: "/tmp", adapterSlug: "fake", resumedFrom: old.id })
    reg.settlePendingAgent(pending.id, { ok: true, agentSession: agentSession(), cwd: "/tmp" } as never)
    expect(reg.get(old.id)?.continuedTo).toBe(pending.id)
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
    const startSession = vi.fn()
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: startSession as never,
      commandPreview: "mock",
    })
    const scheduler = createCronScheduler({ sessionEvents, registry: reg, resolveAgentAdapter, workspace: tmp })
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

  it("a pid-less retired row (processAlive undefined) is not revived, with or without a successor", async () => {
    const { reg, scheduler, startSession, cleanup } = setup([
      { id: "sess_archived", archived: true },
      { id: "sess_superseded" },
    ])
    try {
      const head = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        agentSession: { sessionId: "acp_head", async *send() {}, async cancel() {}, async close() {} },
      })
      reg.markRetired("sess_superseded", { continuedTo: head.id, cause: "continued" })
      expect(reg.get("sess_archived")?.processAlive).toBeUndefined()
      const spy = vi.spyOn(reg, "sendPrompt").mockResolvedValue(undefined)
      const archivedJob = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_archived", prompt: "wake" },
      })
      expect((await scheduler.run(archivedJob.id))?.ok).toBe(false)
      expect(spy).not.toHaveBeenCalled()
      const supersededJob = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_superseded", prompt: "wake" },
      })
      expect((await scheduler.run(supersededJob.id))?.ok).toBe(true)
      expect(spy).toHaveBeenCalledWith(head.id, "wake", { source: "cron" })
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it("a retired row whose pid probes as alive (pid reuse) is still not prompted", async () => {
    const { reg, scheduler, cleanup } = setup([
      { id: "sess_reused", endedReason: "operator-stopped", pid: process.pid },
    ])
    try {
      const spy = vi.spyOn(reg, "sendPrompt").mockResolvedValue(undefined)
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_reused", prompt: "wake" },
      })
      expect(reg.get("sess_reused")?.processAlive).toBe(true)
      expect((await scheduler.run(job.id))?.ok).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it("prompts to a live session are tagged source: cron", async () => {
    const { reg, scheduler, cleanup } = setup([])
    try {
      const live = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        agentSession: { sessionId: "acp_live", async *send() {}, async cancel() {}, async close() {} },
      })
      const spy = vi.spyOn(reg, "sendPrompt").mockResolvedValue(undefined)
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: live.id, prompt: "wake" },
      })
      await scheduler.run(job.id)
      expect(spy).toHaveBeenCalledWith(live.id, "wake", { source: "cron" })
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

  it("archiving a session with no successor leaves its follows and sentinels alone (archive stays reversible)", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }])
    const [oldId] = ids as [string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    reg.kill(oldId)
    reg.archiveSession(oldId)
    expect(followStore.list()).toHaveLength(1)
    expect(sentinelStore.get(s.id)).toBeDefined()
    expect(cancelSentinel).not.toHaveBeenCalled()
  })

  it("forgetting a session with no successor deletes its follows and cancels its sentinels", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }])
    const [oldId] = ids as [string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    reg.kill(oldId)
    expect(reg.forget(oldId)).toBe(true)
    expect(followStore.list()).toHaveLength(0)
    expect(cancelSentinel).toHaveBeenCalledWith(s.id)
  })

  it("forgetting a superseded session re-points its follows and sentinels at the successor instead of destroying them", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }, { id: "new" }])
    const [oldId, newId] = ids as [string, string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    reg.kill(oldId)
    reg.markRetired(oldId, { continuedTo: newId, cause: "continued" })
    // Simulate wiring made after the supersede (a stale client re-attaching).
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 5 })
    reg.forget(oldId)
    expect(followStore.list().every(f => f.follower === newId)).toBe(true)
    const target = sentinelStore.get(s.id)!.spec.target
    expect(target.kind === "session" && target.sessionId).toBe(newId)
    expect(cancelSentinel).not.toHaveBeenCalled()
  })

  it("retireSession with a successor re-points IN PLACE: same sentinel id and cursor, works on an alive row, idempotent", () => {
    const { reg, followStore, sentinelStore, cancelSentinel, ids } = setup([{ id: "old" }, { id: "new" }])
    const [oldId, newId] = ids as [string, string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const s = watch(sentinelStore, oldId)
    sentinelStore.update(s.id, { handle: { ...s.handle, cursor: "42" } } as never)

    expect(reg.get(oldId)?.status).toBe("running")
    const first = retireSession(reg, oldId, { successor: newId })
    expect(first).toMatchObject({ ok: true, id: oldId, killed: true, continuedTo: newId, endedReason: "operator-stopped" })
    expect(reg.get(oldId)?.status).toBe("killed")
    expect(isRetired(reg.get(oldId)!)).toBe(true)

    const after = sentinelStore.get(s.id)!
    expect(after.id).toBe(s.id)
    expect(after.handle.cursor).toBe("42")
    expect(after.spec.target.kind === "session" && after.spec.target.sessionId).toBe(newId)
    expect(followStore.list().map(f => f.follower)).toEqual([newId])
    expect(cancelSentinel).not.toHaveBeenCalled()

    const second = retireSession(reg, oldId, { successor: newId })
    expect(second).toMatchObject({ ok: true, killed: false, continuedTo: newId })
    expect(followStore.list().map(f => f.follower)).toEqual([newId])
    expect(sentinelStore.list()).toHaveLength(1)
  })

  it("retireSession works on a terminal row and honours reason: completed", () => {
    const { reg, ids } = setup([{ id: "old" }, { id: "new" }])
    const [oldId, newId] = ids as [string, string]
    reg.kill(oldId, undefined, "idle-reaped")
    const res = retireSession(reg, oldId, { successor: newId, reason: "completed" })
    expect(res).toMatchObject({ ok: true, killed: false, continuedTo: newId })
    expect(isRetired(reg.get(oldId)!)).toBe(true)
    expect(reg.get(oldId)?.retiredAt).toEqual(expect.any(String))
  })

  it("retireSession without a successor stamps retirement but leaves wiring untouched", () => {
    const { reg, followStore, ids } = setup([{ id: "old" }])
    const [oldId] = ids as [string]
    followStore.upsert({ follower: oldId, selector: { all: true }, batchMs: 0 })
    const res = retireSession(reg, oldId)
    expect(res).toMatchObject({ ok: true, killed: true })
    expect(res.ok && res.continuedTo).toBeFalsy()
    expect(followStore.list()).toHaveLength(1)
  })

  it("retireSession rejects unknown rows, unknown successors, self-succession and cycles", () => {
    const { reg, ids } = setup([{ id: "a" }, { id: "b" }])
    const [a, b] = ids as [string, string]
    expect(retireSession(reg, "nope")).toMatchObject({ ok: false, status: 404, error: "session_not_found" })
    expect(retireSession(reg, a, { successor: "ghost" })).toMatchObject({ ok: false, status: 404, error: "successor_not_found" })
    expect(retireSession(reg, a, { successor: a })).toMatchObject({ ok: false, status: 400, error: "invalid_successor" })
    expect(retireSession(reg, a, { successor: b })).toMatchObject({ ok: true })
    expect(retireSession(reg, b, { successor: a })).toMatchObject({ ok: false, status: 400, error: "successor_cycle" })
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

describe("MCP error shape for a superseded target", () => {
  it("message_send and agent_prompt to a superseded row return error session_not_alive + reason superseded + continuedTo", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const agent = (id: string): AgentSessionLike => ({ sessionId: id, async *send() {}, async cancel() {}, async close() {} })
    const parent = reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", adapterSlug: "fake", agentSession: agent("acp_p") })
    const spawnKid = (label: string) =>
      reg.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        label,
        parentSessionId: parent.id,
        depth: 1,
        agentSession: agent(`acp_${label}`),
      })
    const oldKid = spawnKid("old")
    const newKid = spawnKid("new")
    reg.kill(oldKid.id)
    reg.markRetired(oldKid.id, { continuedTo: newKid.id, cause: "continued" })

    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry: reg, callerSessionId: parent.id })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(ct)
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, unknown> }
    }
    try {
      for (const [name, args] of [
        ["message_send", { to: oldKid.id, text: "hi", urgency: "next-turn" }],
        ["agent_prompt", { sessionId: oldKid.id, prompt: "hi" }],
      ] as const) {
        const r = await call(name, args)
        expect(r.isError).toBe(true)
        expect(r.body).toMatchObject({
          ok: false,
          error: "session_not_alive",
          reason: "superseded",
          continuedTo: newKid.id,
        })
      }
    } finally {
      await client.close()
      reg.shutdown()
    }
  })
})
