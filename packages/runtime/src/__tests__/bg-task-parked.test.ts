import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

/**
 * Parked-with-background-tasks detection (the turn-END twin of
 * stall-watchdog's mid-turn `session:stalled`).
 *
 * Claude Code runs Bash tools with `run_in_background: true`, then ends its
 * turn. The harness's task-notification does NOT trigger a new turn, so the
 * session parks forever: busy:false, awaitingInput:false, background tasks
 * pending — a silent dead end. These tests drive agent stream events through
 * a REAL registry (same harness as stall-watchdog.test.ts) and assert:
 *
 *   1. a turn with one `run_in_background:true` tool-call stamps
 *      `desc.pendingBgTasks = 1` at turn-end and fires `session:bg-tasks-parked`;
 *   2. the next turn-start clears the field and fires `session:bg-tasks-cleared`;
 *   3. a turn with only ordinary tool-calls sets nothing and fires nothing;
 *   4. two bg calls in one turn → count 2.
 */

/** An agent session whose single turn yields the given stream events, then a
 *  turn-end. Each `send()` replays the SAME script — the tests drive a second
 *  turn via sendPrompt to observe the turn-start clear. */
function scriptedAgentSession(
  sessionId: string,
  script: AgentStreamEvent[],
): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      for (const evt of script) yield evt
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

/** A background Bash call, Claude Code style. */
const bgBash = (toolCallId: string, command: string): AgentStreamEvent => ({
  kind: "tool-call",
  toolCallId,
  toolName: "Bash",
  arguments: { command, run_in_background: true },
})

/** An ordinary foreground tool call. */
const fgTool = (toolCallId: string): AgentStreamEvent => ({
  kind: "tool-call",
  toolCallId,
  toolName: "Read",
  arguments: { path: "/tmp/x" },
})

describe("parked-with-background-tasks detection", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bg-task-parked-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("stamps pendingBgTasks and fires session:bg-tasks-parked at turn-end for one bg tool-call", async () => {
    const bus = createSessionEventBus()
    const parked = vi.fn()
    bus.on("session:bg-tasks-parked", parked)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-bg", [bgBash("tc1", "sleep 100")]),
      adapterSlug: "fake",
      label: "bg-one",
      initialPrompt: "go",
    })
    await sleep(20)

    expect(reg.get(desc.id)?.busy).toBe(false) // turn ended
    expect(reg.get(desc.id)?.pendingBgTasks).toBe(1)
    expect(parked).toHaveBeenCalledTimes(1)
    expect(parked).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:bg-tasks-parked",
        sessionId: desc.id,
        count: 1,
        label: "bg-one",
      }),
    )

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("clears the flag and fires session:bg-tasks-cleared on the next turn start", async () => {
    const bus = createSessionEventBus()
    const parked = vi.fn()
    const cleared = vi.fn()
    bus.on("session:bg-tasks-parked", parked)
    bus.on("session:bg-tasks-cleared", cleared)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      // First turn parks (bg call); the SAME session's second turn is an
      // ordinary turn — its turn-start must clear the stale flag.
      agentSession: scriptedAgentSession("acp-bg", [bgBash("tc1", "sleep 100")]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.pendingBgTasks).toBe(1)
    expect(parked).toHaveBeenCalledTimes(1)

    // sendPrompt awaits the whole turn — turn 2 replays the SAME bg script,
    // so it parks AGAIN by the time it resolves. What proves the turn-start
    // clear ran is the bg-tasks-cleared event fired once, BEFORE turn 2's
    // own turn-end re-parked the session.
    await reg.sendPrompt(desc.id, "again")
    await sleep(20)

    expect(cleared).toHaveBeenCalledTimes(1)
    expect(cleared).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:bg-tasks-cleared", sessionId: desc.id }),
    )
    // Turn 2 re-parked (its script starts the bg task again) — the flag is
    // live again and a second parked event fired. The invariant under test is
    // the clear-then-re-park sequence, not a permanently-empty flag.
    expect(parked).toHaveBeenCalledTimes(2)
    expect(reg.get(desc.id)?.pendingBgTasks).toBe(1)

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("a turn with only ordinary tool-calls sets nothing and fires nothing", async () => {
    const bus = createSessionEventBus()
    const parked = vi.fn()
    const cleared = vi.fn()
    bus.on("session:bg-tasks-parked", parked)
    bus.on("session:bg-tasks-cleared", cleared)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-fg", [fgTool("tc1"), fgTool("tc2")]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)

    expect(reg.get(desc.id)?.busy).toBe(false)
    expect(reg.get(desc.id)?.pendingBgTasks).toBeUndefined()
    expect(parked).not.toHaveBeenCalled()
    expect(cleared).not.toHaveBeenCalled()

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("two bg calls in one turn → count 2", async () => {
    const bus = createSessionEventBus()
    const parked = vi.fn()
    bus.on("session:bg-tasks-parked", parked)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-bg2", [
        bgBash("tc1", "sleep 100"),
        fgTool("tc2"),
        bgBash("tc3", "npm run watch"),
      ]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)

    expect(reg.get(desc.id)?.pendingBgTasks).toBe(2)
    expect(parked).toHaveBeenCalledTimes(1)
    expect(parked).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:bg-tasks-parked", sessionId: desc.id, count: 2 }),
    )

    reg.kill(desc.id)
    reg.shutdown()
  })

  it("isUpdate flows count once per toolCallId: (a) bg announce + isUpdate re-announce, (b) argument-less announce + isUpdate carrying the flag", async () => {
    const bus = createSessionEventBus()
    const parked = vi.fn()
    bus.on("session:bg-tasks-parked", parked)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })

    // (a) first-announce-WITH-arguments, then an isUpdate re-announce under
    // the same id — the enrichment is deduped by toolCallId, count stays 1.
    const a = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-bgupd-a", [
        bgBash("tc1", "sleep 100"),
        { ...bgBash("tc1", "sleep 100"), isUpdate: true },
      ]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })

    // (b) announce with NO arguments, then an isUpdate enrichment under the
    // same id that finally carries run_in_background:true — the announce
    // itself doesn't count (nothing to see yet), the enrichment does. This
    // is the flow an `!isUpdate` guard would miss entirely.
    const b = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-bgupd-b", [
        { kind: "tool-call", toolCallId: "tc1", toolName: "Bash" },
        { ...bgBash("tc1", "sleep 100"), isUpdate: true },
      ]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)

    expect(reg.get(a.id)?.pendingBgTasks).toBe(1)
    expect(reg.get(b.id)?.pendingBgTasks).toBe(1)
    expect(parked).toHaveBeenCalledTimes(2)
    expect(parked).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:bg-tasks-parked", sessionId: a.id, count: 1 }),
    )
    expect(parked).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:bg-tasks-parked", sessionId: b.id, count: 1 }),
    )

    reg.kill(a.id)
    reg.kill(b.id)
    reg.shutdown()
  })

  it("a parked session that is killed carries no dangling pendingBgTasks flag", async () => {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedAgentSession("acp-bgkill", [bgBash("tc1", "sleep 100")]),
      adapterSlug: "fake",
      initialPrompt: "go",
    })
    await sleep(20)
    expect(reg.get(desc.id)?.pendingBgTasks).toBe(1)

    reg.kill(desc.id)
    expect(reg.get(desc.id)?.pendingBgTasks).toBeUndefined()
    reg.shutdown()
  })
})
