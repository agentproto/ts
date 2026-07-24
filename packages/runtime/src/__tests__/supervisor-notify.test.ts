import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { wireSupervisorNotify } from "../supervisor-notify.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Supervisor crash-notification (crash-detect PR-4).
 *
 * Driven against a REAL registry (not a stub) — `markCrashed` needs the
 * genuine descriptor/runtime shape, and the busy/idle distinction this
 * module hinges on is a live `SessionRuntime.busy` flag, not something a
 * stub can fake convincingly. `markCrashed` itself doesn't gate on
 * `processAlive` (that's the crash-reaper sweep's own policy layer — see
 * crash-reaper.test.ts), so these tests call it directly without faking a
 * dead pid.
 */

function liveAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    pid: 4242,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** An agent session whose `send()` blocks until `finishTurn()` is called —
 *  lets a test hold a parent `busy` across the crash event, then release it
 *  to observe the next-turn flush. Records every message it was asked to
 *  send, post-flush, for assertion. */
function controllableAgentSession(sessionId: string): {
  session: AgentSessionLike
  messages: unknown[]
  finishTurn: () => void
  cancel: ReturnType<typeof vi.fn>
} {
  const messages: unknown[] = []
  let resolveTurn: (() => void) | null = null
  const cancel = vi.fn(async () => {})
  const session: AgentSessionLike = {
    sessionId,
    pid: 1234,
    async *send(message) {
      messages.push(message)
      await new Promise<void>(resolve => {
        resolveTurn = resolve
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    cancel,
    async close() {},
  }
  return {
    session,
    messages,
    finishTurn: () => {
      const resolve = resolveTurn
      resolveTurn = null
      resolve?.()
    },
    cancel,
  }
}

describe("wireSupervisorNotify", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "supervisor-notify-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("enqueues a [child-crashed] prompt into a live, IDLE parent — no interrupt", () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    wireSupervisorNotify({ registry: reg, sessionEvents: bus })

    const parent = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-parent"),
      adapterSlug: "claude-code",
    })
    const child = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-child"),
      adapterSlug: "claude-code",
      label: "child-1",
      parentSessionId: parent.id,
      notifyParentOnCrash: true,
    })

    const enqueueSpy = vi.spyOn(reg, "enqueuePrompt").mockResolvedValue(undefined)

    expect(reg.markCrashed(child.id)).toBe(true)

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [calledId, calledMessage, calledOpts] = enqueueSpy.mock.calls[0]!
    expect(calledId).toBe(parent.id)
    expect(calledMessage).toContain("[child-crashed]")
    expect(calledMessage).toContain("child-1")
    expect(calledMessage).toContain("crashed")
    expect(calledMessage).toContain("adapter process gone")
    // NEVER interrupt — the direct signal only ever reaches an idle parent.
    expect(calledOpts).toEqual({})

    reg.shutdown()
  })

  it("busy parent: NOT interrupted; a pending marker is stamped and flushed at the next turn", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    wireSupervisorNotify({ registry: reg, sessionEvents: bus })

    const parentSession = controllableAgentSession("acp-parent")
    const parent = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: parentSession.session,
      adapterSlug: "claude-code",
    })
    const child = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-child"),
      adapterSlug: "claude-code",
      label: "child-1",
      parentSessionId: parent.id,
      notifyParentOnCrash: true,
    })

    // Admit the parent's first turn — it blocks inside `send()`, so `busy`
    // stays true past this await (admission resolves before the turn
    // itself settles; see enqueuePrompt's own doc).
    await reg.enqueuePrompt(parent.id, "start", {})
    expect(reg.get(parent.id)?.busy).toBe(true)

    expect(reg.markCrashed(child.id)).toBe(true)

    // Never interrupted: the in-flight turn's cancel() is never called, and
    // the session is still busy on the SAME first turn.
    expect(parentSession.cancel).not.toHaveBeenCalled()
    expect(reg.get(parent.id)?.busy).toBe(true)
    expect(reg.get(parent.id)?.pendingChildCrashNotices).toEqual([
      expect.stringContaining("[child-crashed]"),
    ])

    // Let the first turn settle, then send a second, real turn — the
    // queued notice must flush onto it (and only it) automatically.
    const turnEnded = () =>
      new Promise<void>(resolve => {
        const off = bus.on("session:turn-end", () => {
          off()
          resolve()
        })
      })
    const firstTurnEnd = turnEnded()
    parentSession.finishTurn()
    await firstTurnEnd
    expect(reg.get(parent.id)?.busy).toBe(false)

    await reg.enqueuePrompt(parent.id, "second turn", {})
    // The turn dispatches as an ACP content block ({type:"text", text}) —
    // runAgentTurn wraps a plain string message before calling send().
    const secondTurnText = (parentSession.messages[1] as { text: string }).text
    expect(secondTurnText).toContain("[child-crashed]")
    expect(secondTurnText).toContain("second turn")
    // Flushed exactly once — cleared after being folded into the turn.
    expect(reg.get(parent.id)?.pendingChildCrashNotices).toEqual([])

    const secondTurnEnd = turnEnded()
    parentSession.finishTurn()
    await secondTurnEnd

    expect(parentSession.cancel).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("does NOT enqueue when the crashed child has no notifyParentOnCrash", () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    wireSupervisorNotify({ registry: reg, sessionEvents: bus })
    const enqueueSpy = vi.spyOn(reg, "enqueuePrompt").mockResolvedValue(undefined)

    const parent = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-parent"),
      adapterSlug: "claude-code",
    })
    const child = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-child"),
      adapterSlug: "claude-code",
      parentSessionId: parent.id,
      // notifyParentOnCrash omitted — default off.
    })

    expect(reg.markCrashed(child.id)).toBe(true)
    expect(enqueueSpy).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("does NOT enqueue when the crashed child has notifyParentOnCrash but no parent", () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    wireSupervisorNotify({ registry: reg, sessionEvents: bus })
    const enqueueSpy = vi.spyOn(reg, "enqueuePrompt").mockResolvedValue(undefined)

    const child = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-child"),
      adapterSlug: "claude-code",
      notifyParentOnCrash: true,
      // no parentSessionId — a depth-0 root.
    })

    expect(reg.markCrashed(child.id)).toBe(true)
    expect(enqueueSpy).not.toHaveBeenCalled()
    reg.shutdown()
  })

  it("does NOT enqueue for a non-crash exit (operator kill)", () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    wireSupervisorNotify({ registry: reg, sessionEvents: bus })
    const enqueueSpy = vi.spyOn(reg, "enqueuePrompt").mockResolvedValue(undefined)

    const parent = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-parent"),
      adapterSlug: "claude-code",
    })
    const child = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-child"),
      adapterSlug: "claude-code",
      parentSessionId: parent.id,
      notifyParentOnCrash: true,
    })

    expect(reg.kill(child.id)).toBe(true)
    expect(enqueueSpy).not.toHaveBeenCalled()
    reg.shutdown()
  })
})
