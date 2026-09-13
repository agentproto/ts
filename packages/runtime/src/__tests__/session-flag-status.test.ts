/**
 * Unit tests for the registry-level `flagAwaitingInput` (sessions.ts) — the
 * write-path behind the `session_flag_status` MCP verb. Covers the liveness
 * guard (inverse of `archiveSession`'s), the set/clear semantics of
 * `awaitingInput`/`awaitingQuestion`, and the `session:awaiting-input-flagged`
 * event. Mirrors session-archive.test.ts / session-rename.test.ts's harness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-flag-status-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

describe("flagAwaitingInput", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-flag-status-test-"))
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

  it("refuses a terminal-status session — the inverse of archiveSession's guard", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.kill(desc.id)
    expect(reg.get(desc.id)?.status).toBe("killed") // sanity: now terminal

    expect(() =>
      reg.flagAwaitingInput(desc.id, { awaitingInput: true, reason: "test" })
    ).toThrow(/not live/)
    expect(reg.get(desc.id)?.awaitingInput).toBeUndefined()

    reg.shutdown()
  })

  it("sets awaitingInput true with an attached question on a live session", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    expect(desc.status).toBe("running") // sanity

    const updated = reg.flagAwaitingInput(desc.id, {
      awaitingInput: true,
      question: "Which branch should I target?",
      reason: "heuristic missed a real question buried mid-output",
    })
    expect(updated.awaitingInput).toBe(true)
    expect(updated.awaitingQuestion).toEqual({
      text: "Which branch should I target?",
      source: "structured",
    })

    reg.shutdown()
  })

  it("sets awaitingInput true with no question — awaitingQuestion stays absent", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)

    const updated = reg.flagAwaitingInput(desc.id, {
      awaitingInput: true,
      reason: "confirming a real question without transcribing it",
    })
    expect(updated.awaitingInput).toBe(true)
    expect(updated.awaitingQuestion).toBeUndefined()

    reg.shutdown()
  })

  it("clearing awaitingInput:false also clears any prior awaitingQuestion", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawn(reg)
    reg.flagAwaitingInput(desc.id, {
      awaitingInput: true,
      question: "Continue?",
      reason: "seed a question",
    })
    expect(reg.get(desc.id)?.awaitingQuestion).toBeDefined()

    const cleared = reg.flagAwaitingInput(desc.id, {
      awaitingInput: false,
      reason: "false positive — session was just narrating, not asking",
    })
    expect(cleared.awaitingInput).toBe(false)
    expect(cleared.awaitingQuestion).toBeUndefined()

    reg.shutdown()
  })

  it("emits session:awaiting-input-flagged carrying the reason and new value", () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const reg = createSessionsRegistry({ persistPath, persist: false, sessionEvents: bus })
    const desc = spawn(reg)

    reg.flagAwaitingInput(desc.id, {
      awaitingInput: true,
      question: "Deploy now?",
      reason: "spotted a real question the heuristic missed",
    })
    const flagged = events.find(e => e.type === "session:awaiting-input-flagged")
    expect(flagged).toMatchObject({
      type: "session:awaiting-input-flagged",
      sessionId: desc.id,
      awaitingInput: true,
      reason: "spotted a real question the heuristic missed",
      question: { text: "Deploy now?", source: "structured" },
    })

    events.length = 0
    reg.flagAwaitingInput(desc.id, { awaitingInput: false, reason: "false positive" })
    const cleared = events.find(e => e.type === "session:awaiting-input-flagged")
    expect(cleared).toMatchObject({
      type: "session:awaiting-input-flagged",
      awaitingInput: false,
      reason: "false positive",
    })
    expect((cleared as { question?: unknown }).question).toBeUndefined()

    reg.shutdown()
  })

  it("throws on an unknown session id", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(() =>
      reg.flagAwaitingInput("sess_nope", { awaitingInput: true, reason: "test" })
    ).toThrow(/no session/)
    reg.shutdown()
  })

  it(
    "does NOT survive a daemon restart — boot-reclassification clears it " +
      "like any other in-flight awaiting-input signal (clearInFlightFlags), " +
      "since the live session it described no longer exists to be corrected",
    () => {
      const reg1 = createSessionsRegistry({ persistPath })
      const desc = reg1.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeAgent,
        adapterSlug: "fake",
      })
      reg1.flagAwaitingInput(desc.id, {
        awaitingInput: true,
        question: "Persisted?",
        reason: "persistence check",
      })
      reg1.shutdown() // forces a synchronous flush (persist is debounced)

      const reg2 = createSessionsRegistry({ persistPath })
      const ghost = reg2.get(desc.id)
      expect(ghost?.status).toBe("killed") // reclassified — the process died with the daemon
      expect(ghost?.endedReason).toBe("daemon-restart")
      expect(ghost?.awaitingInput).toBe(false)
      expect(ghost?.awaitingQuestion).toBeUndefined()
      reg2.shutdown()
    },
  )
})
