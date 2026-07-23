import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  isResumable,
  type AgentSessionLike,
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
function makeResumer(calls: string[]): ReturnType<typeof vi.fn> {
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
