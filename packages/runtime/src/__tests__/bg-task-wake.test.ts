import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { buildBackgroundTaskWakePrompt } from "../background-task-wake.js"

/**
 * Background-task lifecycle + wake.
 *
 * A fake agent session stands in for claude-code over ACP: its first turn
 * starts a background task (the AIR `asyncTasks` `background-task` event)
 * and ends; later the test pushes what the agent emits with NO prompt in
 * flight through `onOutOfTurnEvent` — the task settling and, when the agent
 * wakes itself, its autonomous task-notification cycle.
 */

interface FakeAgent extends AgentSessionLike {
  sent: unknown[]
  emit(evt: AgentStreamEvent): void
}

function fakeAgent(turns: AgentStreamEvent[][]): FakeAgent {
  let listener: ((evt: AgentStreamEvent) => void) | undefined
  const sent: unknown[] = []
  return {
    sessionId: "acp-bg",
    sent,
    emit(evt) {
      listener?.(evt)
    },
    async *send(message) {
      const script = turns[sent.length] ?? []
      sent.push(message)
      for (const evt of script) yield evt
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    onOutOfTurnEvent(l) {
      listener = l
      return () => {
        listener = undefined
      }
    },
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

const started = (taskId: string, outputFile?: string): AgentStreamEvent => ({
  kind: "background-task",
  phase: "started",
  task: {
    taskId,
    taskKind: "shell",
    description: `run ${taskId}`,
    status: "running",
    ...(outputFile ? { outputFile } : {}),
  },
})

const settled = (taskId: string, outputFile?: string): AgentStreamEvent => ({
  kind: "background-task",
  phase: "settled",
  task: {
    taskId,
    status: "completed",
    summary: `Background command "run ${taskId}" completed (exit code 0)`,
    ...(outputFile ? { outputFile } : {}),
  },
})

/** Claude Code's own wake-up: text, then the cost-bearing result frame. */
const autonomousCycle: AgentStreamEvent[] = [
  { kind: "text-delta", text: "The background command printed: done\n" },
  {
    kind: "usage_update",
    size: 200_000,
    used: 10_000,
    cost: { amount: 0.01, currency: "USD" },
    origin: "task-notification",
  },
]

describe("background-task lifecycle + wake", () => {
  let tmp: string
  let events: SessionEvent[]
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bg-task-wake-"))
    events = []
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup(
    agent: FakeAgent,
    backgroundTaskWake?: { enabled?: boolean; graceMs?: number },
  ) {
    const bus = createSessionEventBus()
    for (const type of ["session:bg-task", "session:turn-end"] as const) {
      bus.on(type, (e: SessionEvent) => events.push(e))
    }
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      backgroundTaskWake: backgroundTaskWake ?? { graceMs: 40 },
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
      label: "bg",
      initialPrompt: "start it in the background",
    })
    return { reg, id: desc.id }
  }

  it("mirrors a running task onto the descriptor and the compact bus events", async () => {
    const agent = fakeAgent([[started("bx1")]])
    const { reg, id } = setup(agent)
    await sleep(20)

    expect(reg.get(id)?.busy).toBe(false)
    expect(reg.get(id)?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bx1", status: "running", taskKind: "shell", description: "run bx1" }),
    ])
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session:bg-task", phase: "started", taskId: "bx1", sessionId: id }),
    )
    reg.kill(id)
    reg.shutdown()
  })

  it("tracks the agent's own wake-up as an autonomous turn and does NOT send a second wake", async () => {
    const agent = fakeAgent([[started("bx1")]])
    const { reg, id } = setup(agent)
    await sleep(20)
    const busy = vi.fn()

    agent.emit(settled("bx1"))
    expect(reg.get(id)?.backgroundTasks).toBeUndefined()
    agent.emit(autonomousCycle[0]!)
    busy(reg.get(id)?.busy)
    agent.emit(autonomousCycle[1]!)
    await sleep(80) // past the grace window

    expect(busy).toHaveBeenCalledWith(true) // busy while it worked unprompted
    expect(reg.get(id)?.busy).toBe(false)
    expect(reg.get(id)?.turnsCompleted).toBe(2)
    expect(events.filter(e => e.type === "session:turn-end").at(-1)).toMatchObject({
      autonomous: true,
      reason: "completed",
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session:bg-task", phase: "settled", taskId: "bx1", status: "completed" }),
    )
    // It woke itself — the daemon never prompted it again.
    expect(agent.sent).toHaveLength(1)
    // Its output is no longer dropped on the floor.
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    const out = lines.join("\n")
    expect(out).toContain("The background command printed: done")
    reg.kill(id)
    reg.shutdown()
  })

  it("wakes an idle session that did not wake itself, quoting the task's output tail", async () => {
    const outputFile = join(tmp, "bx1.output")
    writeFileSync(outputFile, "line 1\ndone\n")
    const agent = fakeAgent([[started("bx1", outputFile)], []])
    const { reg, id } = setup(agent)
    await sleep(20)

    agent.emit(settled("bx1"))
    await sleep(120)

    expect(agent.sent).toHaveLength(2)
    const wake = String((agent.sent[1] as { text: string }).text)
    expect(wake).toContain(`[background task bx1 completed] run bx1. Output: ${outputFile}`)
    expect(wake).toContain("done")
    expect(reg.get(id)?.busy).toBe(false)
    reg.kill(id)
    reg.shutdown()
  })

  it("coalesces several settles into ONE wake", async () => {
    const agent = fakeAgent([[started("bx1"), started("bx2")], []])
    const { reg, id } = setup(agent)
    await sleep(20)

    agent.emit(settled("bx1"))
    agent.emit(settled("bx2"))
    await sleep(120)

    expect(agent.sent).toHaveLength(2)
    const wake = String((agent.sent[1] as { text: string }).text)
    expect(wake).toContain("[background task bx1 completed]")
    expect(wake).toContain("[background task bx2 completed]")
    reg.kill(id)
    reg.shutdown()
  })

  it("folds claude-agent-acp's provisional 'stopped' settle into the corrected one", async () => {
    // Seen live: the adapter's replace-level closes the task as "stopped",
    // then the authoritative edge says "completed" (no description on it).
    const agent = fakeAgent([
      [started("bx1"), { kind: "tool-call", toolCallId: "t1", toolName: "Bash", arguments: { command: "sleep 20", run_in_background: true } }],
      [],
    ])
    const { reg, id } = setup(agent)
    await sleep(20)
    // The agent reports its lifecycle → not "parked with no wake-up path".
    expect(reg.get(id)?.pendingBgTasks).toBeUndefined()

    agent.emit({ kind: "background-task", phase: "settled", task: { taskId: "bx1", status: "stopped" } })
    agent.emit(settled("bx1"))
    await sleep(120)

    expect(agent.sent).toHaveLength(2)
    const wake = String((agent.sent[1] as { text: string }).text)
    expect(wake).toContain("[background task bx1 completed] run bx1.")
    expect(wake).not.toContain("stopped")
    expect(wake.match(/\[background task bx1/g)).toHaveLength(1)
    reg.kill(id)
    reg.shutdown()
  })

  it("never wakes when opted out", async () => {
    const agent = fakeAgent([[started("bx1")], []])
    const { reg, id } = setup(agent, { enabled: false, graceMs: 20 })
    await sleep(20)

    agent.emit(settled("bx1"))
    await sleep(80)

    expect(agent.sent).toHaveLength(1)
    expect(reg.get(id)?.backgroundTasks).toBeUndefined() // lifecycle still tracked
    reg.kill(id)
    reg.shutdown()
  })

  it("leaves a mid-turn settle to the agent (no wake)", async () => {
    const agent = fakeAgent([[started("bx1"), settled("bx1")], []])
    const { reg, id } = setup(agent)
    await sleep(120)

    expect(agent.sent).toHaveLength(1)
    expect(reg.get(id)?.backgroundTasks).toBeUndefined()
    reg.kill(id)
    reg.shutdown()
  })

  it("holds a queued prompt behind the autonomous turn, then delivers it", async () => {
    const agent = fakeAgent([[started("bx1")], []])
    const { reg, id } = setup(agent)
    await sleep(20)

    agent.emit(settled("bx1"))
    agent.emit(autonomousCycle[0]!)
    const res = await reg.enqueuePrompt(id, "what next?", { queue: true })
    expect(res).toEqual({ queued: true })
    expect(agent.sent).toHaveLength(1)

    agent.emit(autonomousCycle[1]!) // the cycle ends → the queue drains
    await sleep(20)
    expect(agent.sent).toHaveLength(2)
    expect(agent.sent[1]).toEqual({ type: "text", text: "what next?" })
    reg.kill(id)
    reg.shutdown()
  })
})

describe("buildBackgroundTaskWakePrompt", () => {
  it("names the task, its status, description and output file, plus the tail", () => {
    const text = buildBackgroundTaskWakePrompt(
      [
        {
          taskId: "bx1",
          status: "failed",
          description: "pnpm test",
          outputFile: "/tmp/bx1.output",
          summary: 'Background command "pnpm test" failed (exit code 1)',
          startedAt: "2026-09-26T00:00:00.000Z",
        },
      ],
      () => "FAIL src/x.test.ts",
    )
    expect(text).toBe(
      [
        "[background task bx1 failed] pnpm test. Output: /tmp/bx1.output",
        'Background command "pnpm test" failed (exit code 1)',
        "Last lines of output:",
        "```",
        "FAIL src/x.test.ts",
        "```",
      ].join("\n"),
    )
  })
})
