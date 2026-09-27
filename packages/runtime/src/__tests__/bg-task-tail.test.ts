import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"

/**
 * `SessionsRegistry.readBackgroundTaskTail` — the registry method behind
 * `GET /sessions/:id/background-tasks/:taskId/tail` and the
 * `session_bg_task_tail` MCP tool. Scoped to a currently-RUNNING task on
 * `SessionDescriptor.backgroundTasks` — see the interface doc for why a
 * settled task (dropped from that list moments after it settles) is not
 * readable through this path, and why the caller supplies a `taskId` rather
 * than a raw filesystem path.
 */

interface FakeAgent extends AgentSessionLike {
  emit(evt: AgentStreamEvent): void
}

function fakeAgent(turns: AgentStreamEvent[][]): FakeAgent {
  let listener: ((evt: AgentStreamEvent) => void) | undefined
  const sent: unknown[] = []
  return {
    sessionId: "acp-bg-tail",
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

const settled = (taskId: string): AgentStreamEvent => ({
  kind: "background-task",
  phase: "settled",
  task: {
    taskId,
    status: "completed",
    summary: `Background command "run ${taskId}" completed (exit code 0)`,
  },
})

describe("SessionsRegistry.readBackgroundTaskTail", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bg-task-tail-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function setup(agent: FakeAgent) {
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
      label: "bg-tail",
      initialPrompt: "start it in the background",
    })
    return { reg, id: desc.id }
  }

  it("returns the running task plus its output tail", async () => {
    const outputFile = join(tmp, "bx1.output")
    writeFileSync(outputFile, "line 1\nline 2\n")
    const agent = fakeAgent([[started("bx1", outputFile)]])
    const { reg, id } = setup(agent)
    await sleep(20)

    const result = reg.readBackgroundTaskTail(id, "bx1")
    expect(result).toEqual({
      task: expect.objectContaining({ taskId: "bx1", status: "running", outputFile }),
      tail: "line 1\nline 2",
    })
    reg.kill(id)
    reg.shutdown()
  })

  it("returns tail: null when the task has no outputFile", async () => {
    const agent = fakeAgent([[started("bx1")]])
    const { reg, id } = setup(agent)
    await sleep(20)

    const result = reg.readBackgroundTaskTail(id, "bx1")
    expect(result).toEqual({
      task: expect.objectContaining({ taskId: "bx1" }),
      tail: null,
    })
    reg.kill(id)
    reg.shutdown()
  })

  it("returns null for an unknown task id", async () => {
    const agent = fakeAgent([[started("bx1")]])
    const { reg, id } = setup(agent)
    await sleep(20)

    expect(reg.readBackgroundTaskTail(id, "no-such-task")).toBeNull()
    reg.kill(id)
    reg.shutdown()
  })

  it("returns null for an unknown session", async () => {
    const agent = fakeAgent([[started("bx1")]])
    const { reg, id } = setup(agent)
    await sleep(20)
    expect(reg.readBackgroundTaskTail(`${id}-nope`, "bx1")).toBeNull()
    reg.kill(id)
    reg.shutdown()
  })

  it("returns null once the task has settled — it is no longer on backgroundTasks", async () => {
    const agent = fakeAgent([[started("bx1")], []])
    const { reg, id } = setup(agent)
    await sleep(20)

    agent.emit(settled("bx1"))
    await sleep(20)

    expect(reg.get(id)?.backgroundTasks).toBeUndefined()
    expect(reg.readBackgroundTaskTail(id, "bx1")).toBeNull()
    reg.kill(id)
    reg.shutdown()
  })
})
