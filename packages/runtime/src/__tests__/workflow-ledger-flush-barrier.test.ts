/**
 * The app-ledger write barrier (regression for the flaky
 * `app-boundary-workflow.test.ts` ENOTEMPTY on `apps/<app>/data/state`).
 *
 * The runner's app-ledger appends are a SEPARATE async chain from the run
 * files: `executeRunWorkflow` flips `run.status` to its terminal value
 * BEFORE draining that chain, so a caller that observes a terminal status
 * (a test cleanup, a shutdown path) can still be racing the last
 * `mkdir`/`open` into the app's `data/state` dir — which is exactly the
 * intermittent `ENOTEMPTY` on `rmSync` of that dir.
 *
 * This test is DETERMINISTIC: the ledger write is held behind a gate, so
 * the in-flight append provably outlives the terminal status. Without the
 * barrier (`runner.flush()` draining the resident runs' ledger queues) the
 * `flush()` promise resolves while the write is still pending; with it,
 * `flush()` cannot resolve until the write has landed.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createAppRegistry } from "../app-registry.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"
import { createWorkflowRunner } from "../workflow-runner.js"

/** The gate: every ledger append parks here until the test releases it. */
const gate = vi.hoisted(() => {
  let release!: () => void
  const promise = new Promise<void>(r => {
    release = r
  })
  return { promise, release, started: 0, finished: 0 }
})

vi.mock("../app-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../app-state.js")>()
  return {
    ...actual,
    appendAppStateEvent: async (
      app: Parameters<typeof actual.appendAppStateEvent>[0],
      input: Parameters<typeof actual.appendAppStateEvent>[1],
    ) => {
      gate.started += 1
      // Simulated slow ledger write: the append is in flight (and has NOT
      // yet created `data/state`) while the run already reports terminal.
      await gate.promise
      try {
        return await actual.appendAppStateEvent(app, input)
      } finally {
        gate.finished += 1
      }
    },
  }
})

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ledger-flush-barrier-"))
  gate.started = 0
  gate.finished = 0
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeApp(appDir: string, workflowId: string): string {
  mkdirSync(join(appDir, ".agentproto", "workflows", workflowId), { recursive: true })
  writeFileSync(
    join(appDir, "entry.mjs"),
    `export default {
      name: "T", id: "${workflowId}", description: "d", version: "0.1.0", inputs: {}, outputs: {},
      steps: [{ id: "extract", kind: "agent", adapter: "mock", prompt: () => "go" }]
    }`,
  )
  const path = join(appDir, ".agentproto", "workflows", workflowId, "WORKFLOW.md")
  writeFileSync(
    path,
    `---
name: T
id: ${workflowId}
description: d
version: 0.1.0
entry: ../../../entry.mjs
inputs: {}
outputs: {}
steps:
  - id: extract
    kind: agent
---
`,
  )
  return path
}

function fixture() {
  const bus = createSessionEventBus()
  const startSession = vi.fn(async () => ({
    sessionId: "adapter_1",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({
    startSession,
    commandPreview: "mock",
  }))
  const descriptors = new Map<string, SessionDescriptor>()
  const registry = {
    spawnAgent: vi.fn((input: { cwd?: string; meta?: Record<string, string> }) => {
      const id = `sess_${descriptors.size}`
      descriptors.set(id, {
        id,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        ...(input.meta ? { meta: input.meta } : {}),
      } as SessionDescriptor)
      return descriptors.get(id)!
    }),
    sendPrompt: vi.fn(async (sessionId: string) => {
      bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
    }),
    get: vi.fn((id: string) => descriptors.get(id)),
    kill: vi.fn(),
    archiveSession: vi.fn(),
  } as unknown as SessionsRegistry
  return { bus, registry, resolveAgentAdapter }
}

describe("workflow runner — app-ledger write barrier", () => {
  it("flush() does not resolve while an app-ledger append is still in flight", async () => {
    const { bus, registry, resolveAgentAdapter } = fixture()
    const appDir = join(tmp, "apps", "yt")
    const path = writeApp(appDir, "transcribe")
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@test/yt",
      dir: appDir,
      dataDir: join(appDir, "data"),
      agents: [],
      workflows: [{ id: "transcribe", path }],
      unvalidatedAgentTools: [],
    })
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter,
      compileWorkflow: handle => compileWorkflow(handle, { tools: {}, candidates: [] }),
      appRegistry,
      persist: true,
      persistPath: join(tmp, "runs.json"),
      runsRoot: join(tmp, "runs"),
    })

    const run = await runner.startFromFile({ path })

    // The run must NOT report a terminal status while the ledger append is
    // still in flight — that gap is exactly what let a cleanup `rmSync` of
    // the app's `data/state` dir race the append's `mkdir`/`open`
    // (ENOTEMPTY). The barrier is in the runner, not in the test.
    const terminal = new Set(["done", "failed", "cancelled"])
    let s = runner.status(run.runId)
    for (let i = 0; i < 300 && s && !terminal.has(s.status); i++) {
      await new Promise(r => setTimeout(r, 10))
      s = runner.status(run.runId)
      if (gate.started > 0 && gate.finished === 0) break
    }
    expect(gate.started).toBeGreaterThan(0)
    expect(gate.finished).toBe(0)
    expect(terminal.has(s?.status ?? "")).toBe(false)

    // The barrier: `flush()` must NOT resolve while the append is pending.
    let flushResolved = false
    const flushed = runner.flush().then(() => {
      flushResolved = true
    })
    await new Promise(r => setTimeout(r, 50))
    expect(flushResolved).toBe(false)

    // Release the write: the run then goes terminal, the barrier lets the
    // append through, and the app's ledger dir is created exactly once —
    // before any cleanup can race it.
    gate.release()
    await flushed
    expect(flushResolved).toBe(true)
    expect(gate.finished).toBeGreaterThan(0)
    expect(existsSync(join(appDir, "data", "state"))).toBe(true)

    let done = runner.status(run.runId)
    for (let i = 0; i < 300 && done && !terminal.has(done.status); i++) {
      await new Promise(r => setTimeout(r, 10))
      done = runner.status(run.runId)
    }
    expect(done?.status).toBe("done")

    // Cleanup is now safe: no pending write can recreate the dir under it.
    expect(() => rmSync(tmp, { recursive: true, force: true })).not.toThrow()
  })
})
