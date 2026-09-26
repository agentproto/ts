/**
 * Agent-step sessions are released (host `releaseSession`: end + archive)
 * once the run is done with them: a `map`/`pipeline` item's sessions as soon
 * as that item settles, everything else when the run ends — ok or error —
 * and never before a later `sessionRef` step has reused them. Spawns carry
 * the run-unique `stepKey` inside a map item (`review[1]`).
 */

import { describe, it, expect } from "vitest"
import { runWorkflow, type AgentSessionHost, type RuntimeWorkflow } from "../index.js"

function fakeHost(opts?: { failPrompt?: (sessionId: string) => boolean }) {
  const log: string[] = []
  const spawns: Array<{ id: string; stepKey?: string }> = []
  const labels = new Map<string, string>()
  let n = 0
  const host: AgentSessionHost = {
    async spawn(_adapter, o) {
      const id = `s${n++}`
      spawns.push({ id, ...(o.stepKey !== undefined ? { stepKey: o.stepKey } : {}) })
      if (o.stepId) labels.set(o.stepId, id)
      log.push(`spawn ${id}`)
      return id
    },
    async sendPromptAndWait(sessionId) {
      log.push(`prompt ${sessionId}`)
      if (opts?.failPrompt?.(sessionId)) throw new Error(`turn failed on ${sessionId}`)
    },
    resolveByLabel: (stepId) => labels.get(stepId),
    async readFinalMessage() {
      return "done"
    },
    async releaseSession(sessionId) {
      log.push(`release ${sessionId}`)
    },
  }
  return { host, log, spawns }
}

describe("agent-step session release", () => {
  it("a map item's session is released when that item settles, keyed review[i]", async () => {
    const { host, log, spawns } = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "wf",
      steps: [
        {
          kind: "map",
          id: "m",
          parallelism: 1,
          over: () => ["a", "b"],
          body: () => ({ kind: "agent", id: "review", adapter: "mock", prompt: () => "go" }),
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(spawns.map((s) => s.stepKey)).toEqual(["review[0]", "review[1]"])
    // item 0's session is released before item 1 even spawns
    expect(log).toEqual(["spawn s0", "prompt s0", "release s0", "spawn s1", "prompt s1", "release s1"])
  })

  it("a top-level session outlives its step until the run ends, so a sessionRef step can reuse it", async () => {
    const { host, log, spawns } = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "wf",
      steps: [
        { kind: "agent", id: "first", adapter: "mock", prompt: () => "one" },
        { kind: "agent", id: "second", sessionRef: "first", prompt: () => "two" },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(spawns).toEqual([{ id: "s0" }])
    expect(log).toEqual(["spawn s0", "prompt s0", "prompt s0", "release s0"])
    // the session id stays on the step's output
    expect(output).toMatchObject({ sessionId: "s0" })
  })

  it("releases on failure too — the failing item's session and the run's own", async () => {
    const { host, log } = fakeHost({ failPrompt: (id) => id === "s1" })
    const wf: RuntimeWorkflow = {
      id: "wf",
      steps: [
        { kind: "agent", id: "setup", adapter: "mock", prompt: () => "setup" },
        {
          kind: "map",
          id: "m",
          over: () => ["a"],
          body: () => ({ kind: "agent", id: "review", adapter: "mock", prompt: () => "go" }),
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toThrow(/turn failed on s1/)
    expect(log.filter((l) => l.startsWith("release")).sort()).toEqual(["release s0", "release s1"])
  })

  it("a host without releaseSession is left alone", async () => {
    const { host } = fakeHost()
    delete (host as { releaseSession?: unknown }).releaseSession
    const wf: RuntimeWorkflow = { id: "wf", steps: [{ kind: "agent", id: "a", adapter: "mock", prompt: () => "x" }] }
    await expect(runWorkflow({ workflow: wf, agents: host })).resolves.toBeDefined()
  })
})
