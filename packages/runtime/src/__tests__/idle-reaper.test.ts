import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  isResumable,
  type AgentSessionLike,
  type AgentSessionResumer,
  type SessionDescriptor,
} from "../sessions.js"
import {
  runIdleReapPass,
  type IdleReaperRegistry,
} from "../idle-reaper.js"
import { runEagerResumePass } from "../eager-resume.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Idle agent-session reaper (PR-6).
 *
 * Two layers, tested separately:
 *   1. `runIdleReapPass` — the POLICY (which idle rows are safe to reap). Driven
 *      against a stub registry + a fake clock so candidate selection is
 *      deterministic and never touches a real adapter process.
 *   2. `registry.reapIdle` — the ACTION (SIGTERM/close, flip to
 *      killed/idle-reaped, drop the binding so the row stays lazy-resumable).
 *      Driven against a real registry with a live spawned agent session, then
 *      pinned against #638's eager pass (a reaped row is excluded) and the lazy
 *      resume-on-prompt path (a reaped row still revives).
 */

// ── Layer 1: candidate-selection policy (stub registry + fake clock) ──────────

/** A base agent-cli row, idle since `00:00:00`, resumable. Override per case. */
function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: null,
    status: "running",
    startedAt: "2026-07-23T00:00:00Z",
    lastActivityAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: `acp-${over.id}`,
    cwd: "/tmp",
    ...over,
  }
}

/** A stub registry that records every `reapIdle` call (id + idleMs) and always
 *  succeeds — so a test asserts EXACTLY which rows the policy selected. */
function stubRegistry(rows: SessionDescriptor[]): {
  registry: IdleReaperRegistry
  reaped: Array<{ id: string; idleMs: number }>
} {
  const reaped: Array<{ id: string; idleMs: number }> = []
  const registry: IdleReaperRegistry = {
    list: () => rows,
    reapIdle: (id, idleMs = 0) => {
      reaped.push({ id, idleMs })
      return true
    },
  }
  return { registry, reaped }
}

// One hour after the default `lastActivityAt`, so a default row is 1h idle.
const NOW = Date.parse("2026-07-23T01:00:00Z")
const now = (): number => NOW
const THIRTY_MIN = 30 * 60_000

describe("runIdleReapPass — candidate selection", () => {
  it("reaps a running agent-cli session idle past the threshold, passing its idle span", () => {
    const { registry, reaped } = stubRegistry([row({ id: "idle" })])
    const summary = runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now })
    expect(summary).toEqual({ enabled: true, candidates: 1, reaped: 1, ids: ["idle"] })
    expect(reaped).toEqual([{ id: "idle", idleMs: 60 * 60_000 }])
  })

  it("does NOT reap a busy session (a turn is in flight)", () => {
    const { registry, reaped } = stubRegistry([row({ id: "busy", busy: true })])
    const summary = runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now })
    expect(summary.reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a session awaiting input (blocked on a human)", () => {
    const { registry, reaped } = stubRegistry([row({ id: "ask", awaitingInput: true })])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a session awaiting a parked permission decision", () => {
    const { registry, reaped } = stubRegistry([row({ id: "perm", awaitingPermission: true })])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a session younger than the threshold", () => {
    const { registry, reaped } = stubRegistry([
      row({ id: "young", lastActivityAt: "2026-07-23T00:50:00Z" }), // 10min idle < 30min
    ])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap PTY / command / browser (non-agent-cli) sessions", () => {
    const { registry, reaped } = stubRegistry([
      row({ id: "pty", kind: "terminal", pty: true }),
      row({ id: "cmd", kind: "command" }),
      row({ id: "browser", kind: "browser" }),
    ])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap an already-archived row", () => {
    const { registry, reaped } = stubRegistry([row({ id: "arch", archived: true })])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a keepAlive:true row, independent of the crash-reaper's own guards", () => {
    const { registry, reaped } = stubRegistry([row({ id: "pinned", keepAlive: true })])
    const summary = runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now })
    expect(summary.reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a non-running (already terminal) row", () => {
    const { registry, reaped } = stubRegistry([
      row({ id: "killed", status: "killed" }),
      row({ id: "exited", status: "exited" }),
      row({ id: "starting", status: "starting" }),
    ])
    expect(runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("does NOT reap a depth>0 sub-agent whose parent is still alive (don't orphan an active orchestration)", () => {
    const { registry, reaped } = stubRegistry([
      // Parent is alive (running) but busy, so it isn't itself reaped — leaving
      // the child's shield the ONLY reason a reap could be skipped.
      row({ id: "parent", status: "running", busy: true }),
      row({ id: "child", parentSessionId: "parent", depth: 1 }),
    ])
    const summary = runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now })
    expect(summary.reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("DOES reap an idle sub-agent once its parent is gone/terminal", () => {
    const { registry, reaped } = stubRegistry([
      row({ id: "parent", status: "killed" }), // parent no longer alive
      row({ id: "child", parentSessionId: "parent", depth: 1 }),
    ])
    const summary = runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, now })
    expect(summary.reaped).toBe(1)
    expect(reaped.map(r => r.id)).toEqual(["child"])
  })

  it("excludes rows the daemon does not serve (cross-process gate)", () => {
    const { registry, reaped } = stubRegistry([
      row({ id: "mine", workspaceSlug: "alpha" }),
      row({ id: "theirs", workspaceSlug: "beta" }),
    ])
    const summary = runIdleReapPass({
      registry,
      idleReapAfterMs: THIRTY_MIN,
      now,
      isServed: d => d.workspaceSlug === "alpha",
    })
    expect(summary.candidates).toBe(1)
    expect(reaped.map(r => r.id)).toEqual(["mine"])
  })

  it("is OFF by default — a 0 / undefined threshold never runs the sweep", () => {
    const { registry: r0, reaped: reaped0 } = stubRegistry([row({ id: "a" })])
    expect(runIdleReapPass({ registry: r0, idleReapAfterMs: 0, now })).toEqual({
      enabled: false,
      candidates: 0,
      reaped: 0,
      ids: [],
    })
    expect(reaped0).toEqual([])

    const { registry: rU, reaped: reapedU } = stubRegistry([row({ id: "a" })])
    expect(runIdleReapPass({ registry: rU, idleReapAfterMs: undefined, now }).enabled).toBe(false)
    expect(reapedU).toEqual([])
  })
})

describe("runIdleReapPass — sandboxed sessions (sandboxIdleReapAfterMs)", () => {
  const FIFTEEN_MIN = 15 * 60_000
  const box = (over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor =>
    row({ remote: true, sandboxId: "bx_1", sandboxProvider: "e2b", ...over })

  it("reaps a sandboxed session at the sandbox threshold while a local one idle for the same time stays", () => {
    const { registry, reaped } = stubRegistry([
      box({ id: "boxed", lastActivityAt: "2026-07-23T00:40:00Z" }), // 20min idle
      row({ id: "local", lastActivityAt: "2026-07-23T00:40:00Z" }),
    ])
    const summary = runIdleReapPass({
      registry,
      idleReapAfterMs: 2 * 60 * 60_000,
      sandboxIdleReapAfterMs: FIFTEEN_MIN,
      now,
    })
    expect(summary.ids).toEqual(["boxed"])
    expect(reaped).toEqual([{ id: "boxed", idleMs: 20 * 60_000 }])
  })

  it("is enabled by the sandbox threshold alone and never touches a local session then", () => {
    const { registry, reaped } = stubRegistry([box({ id: "boxed" }), row({ id: "local" })])
    const summary = runIdleReapPass({
      registry,
      idleReapAfterMs: undefined,
      sandboxIdleReapAfterMs: FIFTEEN_MIN,
      now,
    })
    expect(summary).toEqual({ enabled: true, candidates: 1, reaped: 1, ids: ["boxed"] })
    expect(reaped.map(r => r.id)).toEqual(["boxed"])
  })

  it("sandbox threshold off (0) ⇒ a sandboxed session falls back to the general threshold", () => {
    const { registry } = stubRegistry([box({ id: "boxed" })]) // 1h idle
    expect(
      runIdleReapPass({ registry, idleReapAfterMs: THIRTY_MIN, sandboxIdleReapAfterMs: 0, now }).ids,
    ).toEqual(["boxed"])
    expect(
      runIdleReapPass({ registry, idleReapAfterMs: 2 * 60 * 60_000, sandboxIdleReapAfterMs: 0, now }).reaped,
    ).toBe(0)
    expect(runIdleReapPass({ registry, idleReapAfterMs: 0, sandboxIdleReapAfterMs: 0, now }).enabled).toBe(false)
  })

  it("a sandboxed session younger than the sandbox threshold stays", () => {
    const { registry, reaped } = stubRegistry([box({ id: "young", lastActivityAt: "2026-07-23T00:50:00Z" })])
    expect(runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it.each([
    ["busy", { busy: true }],
    ["awaiting input", { awaitingInput: true }],
    ["awaiting permission", { awaitingPermission: true }],
    ["keepAlive", { keepAlive: true }],
    ["archived", { archived: true }],
    ["blocked on a command", { blockedOn: "command" as const }],
    ["blocked on a sub-agent", { blockedOn: "subagent" as const }],
    [
      "running a background task",
      { backgroundTasks: [{ taskId: "t", status: "running" as const, startedAt: "2026-07-23T00:00:00Z" }] },
    ],
  ])("never reaps a sandboxed session that is %s", (_name, over) => {
    const { registry, reaped } = stubRegistry([box({ id: "b", ...over })])
    expect(runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("a finished background task does not pin the box", () => {
    const { registry } = stubRegistry([
      box({
        id: "b",
        backgroundTasks: [{ taskId: "t", status: "completed", startedAt: "2026-07-23T00:00:00Z" }],
      }),
    ])
    expect(runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now }).ids).toEqual(["b"])
  })

  it("a sandboxed parent with a live child session is not reaped (the child's work lives in the same orchestration)", () => {
    const { registry, reaped } = stubRegistry([
      box({ id: "parent" }),
      row({ id: "child", parentSessionId: "parent", lastActivityAt: "2026-07-23T00:59:00Z" }),
    ])
    expect(runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now }).reaped).toBe(0)
    expect(reaped).toEqual([])
  })

  it("a restarted sandbox session still awaiting its first prompt gets a grace period past the sandbox threshold", () => {
    // startedAt 00:00, never active, 60min before NOW: past 15min, inside the 60min+ grace.
    const restarted = (id: string, over: Partial<SessionDescriptor> = {}) =>
      box({ id, lastActivityAt: undefined, continuedFrom: "sess_prev", ...over })
    const { registry, reaped } = stubRegistry([
      restarted("fresh", { startedAt: "2026-07-23T00:30:00Z" }), // 30min old
      restarted("resumed", { startedAt: "2026-07-23T00:30:00Z", continuedFrom: undefined, resumedFrom: "sess_prev" }),
      restarted("stale", { startedAt: "2026-07-22T22:00:00Z" }), // 3h old: grace over
      box({ id: "never-restarted", lastActivityAt: undefined, startedAt: "2026-07-23T00:30:00Z" }),
      restarted("active", { startedAt: "2026-07-23T00:30:00Z", lastActivityAt: "2026-07-23T00:40:00Z" }),
    ])
    const summary = runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now })
    expect(summary.ids.sort()).toEqual(["active", "never-restarted", "stale"])
    expect(reaped).toHaveLength(3)
  })

  it("a device: sandbox (a paired host, not a box of ours) keeps the general rules", () => {
    const { registry } = stubRegistry([box({ id: "dev", sandboxProvider: "device:my-mac" })])
    expect(runIdleReapPass({ registry, sandboxIdleReapAfterMs: FIFTEEN_MIN, idleReapAfterMs: 0, now }).reaped).toBe(0)
  })
})

// ── Layer 2: the reap action + eager-exclusion + lazy resume (real registry) ──

/** A live agent session whose `close()` sets `closed.value` — so a test can
 *  observe the reaper freeing the adapter. */
function liveAgentSession(sessionId: string, closed: { value: boolean }): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {
      closed.value = true
    },
  }
}

/** A resumer that hands back a fresh live session (the lazy resume-on-prompt
 *  path), recording each descriptor id it was asked to resume. */
function makeResumer(calls: string[]): AgentSessionResumer {
  return vi.fn(async (input: { descriptor: SessionDescriptor }) => {
    calls.push(input.descriptor.id)
    const fresh: AgentSessionLike = {
      sessionId: input.descriptor.adapterSessionId ?? "acp-fresh",
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

describe("registry.reapIdle — the reap action", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "idle-reap-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("reaps a live idle agent session: SIGTERM/close, killed + idle-reaped, row present + lazy-resumable, session:reaped emitted", async () => {
    const bus = createSessionEventBus()
    const reaped = vi.fn()
    const exited = vi.fn()
    bus.on("session:reaped", reaped)
    bus.on("session:exited", exited)
    const closed = { value: false }
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      resumeAgent: makeResumer([]),
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", closed),
      adapterSlug: "claude-code",
    })
    // Backdate so the row is idle past any threshold.
    reg.get(desc.id)!.lastActivityAt = "2020-01-01T00:00:00Z"

    const summary = runIdleReapPass({
      registry: reg,
      idleReapAfterMs: 1_000,
      now: () => Date.now(),
    })

    expect(summary.reaped).toBe(1)
    expect(summary.ids).toEqual([desc.id])
    // Adapter process freed.
    expect(closed.value).toBe(true)
    // Terminal-ish but resumable: killed + the reaper's own reason, row still
    // present with adapter essentials intact.
    const after = reg.get(desc.id)!
    expect(after.status).toBe("killed")
    expect(after.endedReason).toBe("idle-reaped")
    expect(reg.list().find(s => s.id === desc.id)).toBeDefined()
    expect(isResumable(after)).toBe(true)
    // Both signals fired — the reaper-specific one (naming the actor + idle span)
    // and the usual lifecycle exit carrying reason:"idle-reaped".
    expect(reaped).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:reaped", sessionId: desc.id }),
    )
    expect(reaped.mock.calls[0]![0].idleMs).toBeGreaterThan(0)
    expect(exited).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: desc.id, status: "killed", reason: "idle-reaped" }),
    )
    reg.shutdown()
  })

  it("a reaped row is SKIPPED by #638's eager resume pass, but STILL lazy-resumable on the next prompt", async () => {
    const calls: string[] = []
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent: makeResumer(calls),
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.lastActivityAt = "2020-01-01T00:00:00Z"

    expect(runIdleReapPass({ registry: reg, idleReapAfterMs: 1_000, now: () => Date.now() }).reaped).toBe(1)

    // #638's eager pass gates on endedReason === "daemon-restart"; a reaped row
    // (idle-reaped) is naturally excluded — no candidate, no resume, still dead.
    const eager = await runEagerResumePass({ registry: reg, concurrency: 4 })
    expect(eager.candidates).toBe(0)
    expect(calls).toEqual([])
    expect(reg.get(desc.id)?.status).toBe("killed")

    // But a deliberate prompt revives it in place (operator intent — the lazy
    // path honours any resumable killed row).
    await reg.sendPrompt(desc.id, "continue")
    expect(calls).toEqual([desc.id])
    expect(reg.get(desc.id)?.status).toBe("running")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("refuses (no-op) a non-running or unknown row", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.kill(desc.id)
    // Already terminal ⇒ reapIdle is a no-op.
    expect(reg.reapIdle(desc.id)).toBe(false)
    // Unknown id ⇒ false.
    expect(reg.reapIdle("nope")).toBe(false)
    reg.shutdown()
  })
})

describe("registry.reapIdle — sandboxed session (box teardown + fresh-box revival)", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "idle-reap-box-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawnBox = (
    reg: ReturnType<typeof createSessionsRegistry>,
    close: ReturnType<typeof vi.fn>,
  ): SessionDescriptor => {
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user/work",
      agentSession: { ...liveAgentSession("acp-box", { value: false }), close },
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "bx_1",
      sandboxProvider: "e2b",
    })
    reg.get(desc.id)!.lastActivityAt = "2020-01-01T00:00:00Z"
    return desc
  }

  it("closes a sandboxed session with the idle-reap marker (so the proxy checkpoints + kills the box)", () => {
    const close = vi.fn(async () => {})
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = spawnBox(reg, close)

    expect(
      runIdleReapPass({ registry: reg, idleReapAfterMs: 0, sandboxIdleReapAfterMs: 1_000, now: () => Date.now() }).ids,
    ).toEqual([desc.id])

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith({ idleReap: { idleMs: expect.any(Number), sessionId: desc.id } })
    expect(reg.get(desc.id)?.endedReason).toBe("idle-reaped")
    reg.shutdown()
  })

  it("a non-sandbox reap still closes with no options (defaults untouched)", () => {
    const close = vi.fn(async () => {})
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: { ...liveAgentSession("acp-1", { value: false }), close },
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.lastActivityAt = "2020-01-01T00:00:00Z"
    expect(reg.reapIdle(desc.id, 5)).toBe(true)
    expect(close).toHaveBeenCalledWith(undefined)
    reg.shutdown()
  })

  it("a failing box teardown is surfaced on the row, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = spawnBox(reg, vi.fn(async () => { throw new Error("provider 500") }))
    reg.reapIdle(desc.id, 5)
    await new Promise(res => setTimeout(res, 10))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider 500"))
    warn.mockRestore()
    reg.shutdown()
  })

  it("a prompt to the reaped row cold-boots a fresh box and delivers the prompt to the successor", async () => {
    const moved: string[] = []
    const prompted: string[] = []
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent: makeResumer([]),
      moveReapedBox: async ({ sessionId, prev }) => {
        moved.push(sessionId)
        expect(prev.sandboxId).toBe("bx_1")
        const succ = reg.spawnAgent({
          workspaceSlug: "default",
          cwd: "/home/user/work",
          agentSession: {
            sessionId: "acp-new",
            async *send(msg: unknown) {
              prompted.push(JSON.stringify(msg))
              yield { kind: "turn-end", reason: "completed" }
            },
            async cancel() {},
            async close() {},
          } as AgentSessionLike,
          adapterSlug: "claude-code",
          remote: true,
          sandboxId: "bx_2",
          sandboxProvider: "e2b",
        })
        return { ok: true, newSessionId: succ.id }
      },
    })
    const desc = spawnBox(reg, vi.fn(async () => {}))
    reg.reapIdle(desc.id, 5)

    await reg.sendPrompt(desc.id, "pick up where you left off")

    expect(moved).toEqual([desc.id])
    expect(prompted).toHaveLength(1)
    expect(prompted[0]).toContain("pick up where you left off")
    reg.shutdown()
  })

  it("the fresh-box move waits for the reap's own teardown (final checkpoint) to finish", async () => {
    const order: string[] = []
    let releaseClose!: () => void
    const closeDone = new Promise<void>(res => { releaseClose = res })
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      moveReapedBox: async () => {
        order.push("move")
        return { ok: true, newSessionId: reg.spawnAgent({
          workspaceSlug: "default",
          cwd: "/home/user/work",
          agentSession: liveAgentSession("acp-new", { value: false }),
          adapterSlug: "claude-code",
          remote: true,
          sandboxId: "bx_2",
          sandboxProvider: "e2b",
        }).id }
      },
    })
    const desc = spawnBox(reg, vi.fn(async () => {
      await closeDone
      order.push("teardown-done")
    }))
    reg.reapIdle(desc.id, 5)

    const prompt = reg.sendPrompt(desc.id, "go")
    await new Promise(res => setTimeout(res, 20))
    expect(order).toEqual([]) // move held back while the teardown runs
    releaseClose()
    await prompt
    expect(order).toEqual(["teardown-done", "move"])
    reg.shutdown()
  })

  it("concurrent prompts share ONE fresh-box move", async () => {
    let calls = 0
    let succId = ""
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      moveReapedBox: async () => {
        calls++
        await new Promise(res => setTimeout(res, 20))
        succId = reg.spawnAgent({
          workspaceSlug: "default",
          cwd: "/home/user/work",
          agentSession: liveAgentSession("acp-new", { value: false }),
          adapterSlug: "claude-code",
          remote: true,
          sandboxId: "bx_2",
          sandboxProvider: "e2b",
        }).id
        return { ok: true, newSessionId: succId }
      },
    })
    const desc = spawnBox(reg, vi.fn(async () => {}))
    reg.reapIdle(desc.id, 5)

    await Promise.all([reg.sendPrompt(desc.id, "a"), reg.sendPrompt(desc.id, "b").catch(() => undefined)])
    expect(calls).toBe(1)
    reg.shutdown()
  })

  it("a failed move fails the prompt loudly instead of resuming a local adapter on a box-only path", async () => {
    const resume = makeResumer([])
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent: resume,
      moveReapedBox: async () => ({ ok: false, blocker: "no workspace remote" }),
    })
    const desc = spawnBox(reg, vi.fn(async () => {}))
    reg.reapIdle(desc.id, 5)

    await expect(reg.sendPrompt(desc.id, "hi")).rejects.toThrow(/no workspace remote/)
    expect(resume).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("a reaped non-sandbox row still revives in place (no move hook involved)", async () => {
    const moveReapedBox = vi.fn()
    const calls: string[] = []
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      resumeAgent: makeResumer(calls),
      moveReapedBox,
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.reapIdle(desc.id, 5)
    await reg.sendPrompt(desc.id, "continue")
    expect(calls).toEqual([desc.id])
    expect(moveReapedBox).not.toHaveBeenCalled()
    reg.shutdown()
  })
})
