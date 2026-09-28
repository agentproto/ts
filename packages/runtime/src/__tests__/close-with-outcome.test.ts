/**
 * `registry.closeWithOutcome` (FIX-9A part 3) — the session steward's close
 * primitive: terminates a live agent-cli session the same graceful way
 * `kill()` does, but records a Level 2 (judged/declared) outcome and leaves
 * the row lazy-resumable exactly like `reapIdle` does.
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
