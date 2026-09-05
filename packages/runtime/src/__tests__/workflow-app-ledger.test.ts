/**
 * WP-Q — the runner-written side of the app state ledger bridge: a run
 * started on behalf of an installed app (startFromFile, workflow id owned
 * by exactly one installed app per the registry) appends stage-started /
 * gate-report / stage-done / blocked events with `by: "runner"` and the
 * run's `appRunId` to `<dataDir>/state/events.jsonl`. Fixtures mirror
 * workflow-runner.test.ts's mock registry/adapter (#1144's gate test) and
 * app-state.test.ts's fake installed app (#1141).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createWorkflowRunner } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createAppRegistry } from "../app-registry.js"
import { appStateEventsPath, readAppStateEvents, appStateSnapshot } from "../app-state.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AppStateEvent } from "../app-state.js"
import type { SessionEventBus } from "../session-event-bus.js"

let bus: SessionEventBus

function makeMockRegistry(): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()
  return {
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn((input) => {
      const id = "sess_prep"
      descriptors.set(id, {
        id,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
      })
      return descriptors.get(id)!
    }),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async (_sessionId: string) => {
      bus.emit({ type: "session:turn-end", sessionId: _sessionId, awaitingInput: false, ts: "t" })
    }),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn((id) => descriptors.get(id)),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    findByIdOrName: vi.fn((q) => descriptors.get(q)),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: async () => ({
      sessionId: "adapter_prep",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  }))
}

// Same harness constraint as workflow-runner.test.ts's startFromFile block:
// entry.mjs is dynamically imported by the loader, so the temp dir must live
// under the package root (gitignored node_modules/) to stay in Vite's fs.allow.
const inRootTmpBase = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
)

const APP_ID = "@test/ledger-app"
const WORKFLOW_ID = "ledger-wf"
const APP_RUN_ID = "apprun_ledger_test_1"

let tmpDir: string
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

function setupApp(workflowPath: string) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir: tmpDir,
    dataDir: join(tmpDir, "data"),
    agents: [],
    workflows: [{ id: WORKFLOW_ID, path: workflowPath }],
    unvalidatedAgentTools: [],
  })
  return appRegistry
}

describe("WorkflowRunner app state ledger bridge", () => {
  it("appends stage-started / gate-report / stage-done / blocked with by=runner and the run's appRunId, in order", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-app-ledger-test-"))
    bus = createSessionEventBus()
    const appRegistry = setupApp(join(tmpDir, "WORKFLOW.md"))

    writeFileSync(
      join(tmpDir, "entry.mjs"),
      `export default {
        name: "Ledger",
        id: "${WORKFLOW_ID}",
        description: "Agent step, passing gate, failing gate.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [
          { id: "prep", kind: "agent", adapter: "mock", prompt: () => "prep" },
          { id: "check", kind: "gate", command: "node", args: ["-e", "process.exit(0)"] },
          { id: "verify", kind: "gate", command: "node", args: ["-e", "process.exit(1)"] },
        ],
      }`,
      "utf8",
    )
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Ledger
id: ${WORKFLOW_ID}
description: Agent step, passing gate, failing gate.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: prep
    kind: agent
  - id: check
    kind: gate
    command: node
    args: ["-e", "process.exit(0)"]
  - id: verify
    kind: gate
    command: node
    args: ["-e", "process.exit(1)"]
---
`,
      "utf8",
    )

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: {}, candidates: [] }),
      appRegistry,
    })

    const run = await runner.startFromFile({ path, appRunId: APP_RUN_ID })
    // Provenance resolved from the registry: the workflow id is owned by
    // exactly one installed app.
    expect(run.appId).toBe(APP_ID)
    expect(run.appRunId).toBe(APP_RUN_ID)

    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 200 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 20))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("failed")

    const app = { dir: tmpDir, dataDir: join(tmpDir, "data") }
    // The final `blocked` append is queued behind the others — poll briefly.
    let events: AppStateEvent[] = []
    for (let i = 0; i < 250; i++) {
      events = (await readAppStateEvents(app)).events
      if (events.some(e => e.kind === "blocked")) break
      await new Promise(res => setTimeout(res, 20))
    }

    const mine = events.filter(e => e.appRunId === APP_RUN_ID)
    expect(mine.length).toBeGreaterThan(0)
    for (const e of mine) expect(e.by).toBe("runner")

    const kindsFor = (stage: string): string[] =>
      mine.filter(e => e.stage === stage).map(e => e.kind)
    expect(kindsFor("prep")).toEqual(["stage-started", "stage-done"])
    expect(kindsFor("check")).toEqual(["stage-started", "gate-report", "stage-done"])
    expect(kindsFor("verify")).toEqual(["stage-started", "gate-report", "blocked"])

    const gateReports = mine.filter(e => e.kind === "gate-report")
    expect(gateReports[0]).toMatchObject({ stage: "check", payload: { ok: true, exitCode: 0, attempt: 1, runId: run.runId } })
    expect(gateReports[1]).toMatchObject({ stage: "verify", payload: { ok: false, exitCode: 1, attempt: 1, runId: run.runId } })

    const stageStarts = mine.filter(e => e.kind === "stage-started")
    expect(stageStarts[0]).toMatchObject({ stage: "prep", payload: { runId: run.runId, kind: "agent" } })
    expect(stageStarts[1]).toMatchObject({ stage: "check", payload: { runId: run.runId, kind: "gate" } })

    const blocked = mine.find(e => e.kind === "blocked")
    expect(blocked).toMatchObject({ stage: "verify", payload: { runId: run.runId } })
    expect(String(blocked?.payload.reason)).toMatch(/gate failed/)

    const done = mine.filter(e => e.kind === "stage-done")
    for (const e of done) expect(e.payload.runId).toBe(run.runId)

    // The fold produces sensible stage statuses from these events as-is —
    // no reducer change needed.
    const snapshot = await appStateSnapshot(app)
    expect(snapshot.stages.prep?.status).toBe("done")
    expect(snapshot.stages.check?.status).toBe("done")
    expect(snapshot.stages.verify?.status).toBe("blocked")
    expect(snapshot.stages.check?.lastGate).toMatchObject({ ok: true, exitCode: 0 })
  })

  it("writes nothing to the ledger when the run has no app provenance", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-app-ledger-noapp-test-"))
    bus = createSessionEventBus()

    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Plain gate
id: plain-gate-wf
description: A gate with no app.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: g
    kind: gate
    command: node
    args: ["-e", "process.exit(0)"]
---
`,
      "utf8",
    )

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: {}, candidates: [] }),
    })

    const run = await runner.startFromFile({ path })
    expect(run.appId).toBeUndefined()
    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 200 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 20))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("done")

    const { events } = await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })
    expect(events).toHaveLength(0)
    expect(appStateEventsPath({ dir: tmpDir, dataDir: join(tmpDir, "data") })).toContain("state")
  })

  it("a ledger append failure never fails the run (best-effort)", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-app-ledger-badapp-test-"))
    bus = createSessionEventBus()
    // A real FILE at the dataDir path — mkdir(dataDir/state) fails with
    // ENOTDIR, so every append must degrade to a warning.
    const blocker = join(tmpDir, "blocker")
    writeFileSync(blocker, "not a directory", "utf8")
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir: tmpDir,
      dataDir: blocker,
      agents: [],
      workflows: [{ id: WORKFLOW_ID, path: join(tmpDir, "WORKFLOW.md") }],
      unvalidatedAgentTools: [],
    })
    writeFileSync(
      join(tmpDir, "WORKFLOW.md"),
      `---
name: Ledger gate
id: ${WORKFLOW_ID}
description: A single passing gate under a hostile dataDir.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: g
    kind: gate
    command: node
    args: ["-e", "process.exit(0)"]
---
`,
      "utf8",
    )

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: {}, candidates: [] }),
      appRegistry,
    })

    const run = await runner.startFromFile({ path: join(tmpDir, "WORKFLOW.md"), appRunId: APP_RUN_ID })
    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 200 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 20))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("done")
    warnSpy.mockRestore()
  })
})
