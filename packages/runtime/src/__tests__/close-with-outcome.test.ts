/**
 * `registry.closeWithOutcome` (FIX-9A part 3) — the session steward's close
 * primitive: for verdict "done"/"abandoned" it terminates a live agent-cli
 * session the same graceful way `kill()` does, recording a Level 2
 * (judged/declared) outcome and leaving the row lazy-resumable exactly like
 * `reapIdle` does. For verdict "blocked"/"needs-input" it does NOT close —
 * it records `SessionDescriptor.wrapupFlag` instead and leaves the session
 * exactly as alive as it was.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, isResumable, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { isKnownSessionEndReason } from "../session-end-reason.js"

function liveAgentSession(sessionId: string, closed: { value: boolean }): AgentSessionLike {
  return {
    sessionId,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {
      closed.value = true
    },
  }
}

describe("registry.closeWithOutcome", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "close-with-outcome-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("verdict:'done' ⇒ endedReason:'steward-completed', outcome has source/verdict/judgedBy, row resumable", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const closed = { value: false }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", closed),
      adapterSlug: "claude-code",
    })

    const ok = reg.closeWithOutcome(desc.id, {
      verdict: "done",
      judgedBy: "steward-rules",
      note: "worktree merged, idle 45m",
      source: "declared",
    })
    expect(ok).toBe(true)
    expect(closed.value).toBe(true)

    const after = reg.get(desc.id)!
    expect(after.status).toBe("killed")
    expect(after.endedReason).toBe("steward-completed")
    expect(isKnownSessionEndReason(after.endedReason)).toBe(true)
    expect(after.outcome?.source).toBe("declared")
    expect(after.outcome?.verdict).toBe("done")
    expect(after.outcome?.judgedBy).toBe("steward-rules")
    expect(after.outcome?.note).toBe("worktree merged, idle 45m")
    // Termination fields are still recorded, same as any other close.
    expect(after.outcome?.termination.status).toBe("killed")
    expect(after.outcome?.termination.reason).toBe("steward-completed")
    // Lazy-resumable — same invariant as reapIdle.
    expect(isResumable(after)).toBe(true)

    reg.shutdown()
  })

  it("verdict other than 'done' ⇒ endedReason:'steward-abandoned'", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })

    expect(
      reg.closeWithOutcome(desc.id, { verdict: "abandoned", judgedBy: "sess_judge1", source: "judged" }),
    ).toBe(true)

    const after = reg.get(desc.id)!
    expect(after.endedReason).toBe("steward-abandoned")
    expect(after.outcome?.source).toBe("judged")
    expect(after.outcome?.verdict).toBe("abandoned")
    expect(after.outcome?.judgedBy).toBe("sess_judge1")

    reg.shutdown()
  })

  it("an explicit summary override replaces the derived one", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })

    reg.closeWithOutcome(desc.id, {
      verdict: "done",
      summary: "Judge's own summary of what happened.",
      source: "judged",
      judgedBy: "sess_judge1",
    })

    expect(reg.get(desc.id)?.outcome?.summary).toBe("Judge's own summary of what happened.")
    reg.shutdown()
  })

  it("refuses (no-op) a session that became busy since the plan", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.busy = true

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")

    reg.shutdown()
  })

  it("refuses (no-op) a session that became awaitingInput since the plan", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.awaitingInput = true

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")

    reg.shutdown()
  })

  it("refuses (no-op) a session that became awaitingPermission since the plan", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.awaitingPermission = true

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")

    reg.shutdown()
  })

  it("refuses (no-op) a session with a pending background-task count, WITHOUT deleting it", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.pendingBgTasks = 1

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")
    expect(reg.get(desc.id)?.pendingBgTasks).toBe(1)

    reg.shutdown()
  })

  it("refuses (no-op) a session with a tracked running background task, WITHOUT deleting it", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.backgroundTasks = [
      { taskId: "t1", status: "running", description: "long build", startedAt: new Date().toISOString() },
    ]

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.status).toBe("running")
    expect(reg.get(desc.id)?.backgroundTasks).toHaveLength(1)

    reg.shutdown()
  })

  it("verdict:'blocked' does NOT close the session — records wrapupFlag instead, session stays running", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const closed = { value: false }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", closed),
      adapterSlug: "claude-code",
    })

    const ok = reg.closeWithOutcome(desc.id, {
      verdict: "blocked",
      judgedBy: "sess_judge1",
      note: "waiting on a missing API key",
      source: "judged",
    })
    expect(ok).toBe(true)
    expect(closed.value).toBe(false)

    const after = reg.get(desc.id)!
    expect(after.status).toBe("running")
    expect(after.endedReason).toBeUndefined()
    expect(after.outcome).toBeUndefined()
    expect(after.wrapupFlag?.verdict).toBe("blocked")
    expect(after.wrapupFlag?.judgedBy).toBe("sess_judge1")
    expect(after.wrapupFlag?.note).toBe("waiting on a missing API key")
    expect(after.wrapupFlag?.at).toBeTruthy()

    reg.shutdown()
  })

  it("verdict:'needs-input' does NOT close the session — records wrapupFlag instead", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })

    expect(reg.closeWithOutcome(desc.id, { verdict: "needs-input", source: "declared" })).toBe(true)

    const after = reg.get(desc.id)!
    expect(after.status).toBe("running")
    expect(after.wrapupFlag?.verdict).toBe("needs-input")

    reg.shutdown()
  })

  it("a flag-only verdict is ALSO refused when the session is busy/awaitingInput/etc.", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.get(desc.id)!.busy = true

    expect(reg.closeWithOutcome(desc.id, { verdict: "blocked", source: "declared" })).toBe(false)
    expect(reg.get(desc.id)?.wrapupFlag).toBeUndefined()

    reg.shutdown()
  })

  it("refuses (no-op) an already-terminal row", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
    })
    reg.kill(desc.id)

    expect(reg.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })).toBe(false)
    reg.shutdown()
  })

  it("refuses (no-op) an unknown session id", () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    expect(reg.closeWithOutcome("nope", { verdict: "done", source: "declared" })).toBe(false)
    reg.shutdown()
  })
})
