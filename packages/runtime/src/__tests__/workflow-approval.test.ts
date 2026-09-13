/**
 * WP-S — `kind: "approval"` steps are resolved by a HUMAN, not auto-approved.
 *
 * The runner passes an `approve` hook into `runWorkflow`: a declarative
 * approval step parks the run as "awaiting-approval" (with an
 * `awaitingApproval` inbox record + a `workflow:approval-requested` event),
 * `resolveApproval` records the human decision — emitting
 * `workflow:approval-resolved` and appending the app-ledger `approval` event
 * with `by: "human"` — and the run resumes on the approve/reject branch.
 * Timeout resolves as rejected (`who: "timeout"`); a run parked awaiting
 * approval survives a daemon restart (reload re-registers the pending item,
 * exactly one ledger event — the dead in-flight execution does not resume).
 *
 * Fixtures mirror workflow-app-ledger.test.ts's fake installed app +
 * mock registry/adapter.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"
import { createWorkflowRunner } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createAppRegistry } from "../app-registry.js"
import { readAppStateEvents } from "../app-state.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { WorkflowRun } from "../workflow-runner.js"
import type { SessionEventBus, SessionEvent } from "../session-event-bus.js"

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
    sendPrompt: vi.fn(async () => {}),
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

const inRootTmpBase = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
)

const APP_ID = "@test/approval-app"
const WORKFLOW_ID = "approval-wf"
const APP_RUN_ID = "apprun_approval_test_1"

let tmpDir: string
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

function writeApprovalWorkflowFile(opts: { timeoutMs?: number }): string {
  const path = join(tmpDir, "WORKFLOW.md")
  writeFileSync(
    path,
    `---
name: Approval
id: ${WORKFLOW_ID}
description: One human approval gate.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: signoff
    kind: approval
    prompt: Approve the release?
    approvers:
      - role: maintainer
    ${opts.timeoutMs !== undefined ? `timeout_ms: ${opts.timeoutMs}` : "timeout_ms: 600000"}
---
`,
    "utf8",
  )
  return path
}

/** A compileWorkflow callback that ignores the file's declarative steps and
 *  returns a hand-built runtime workflow: one approval step with observable
 *  approve/reject branches (each branch records itself into `branches`). */
const compileApprovalWorkflow = (
  handle: { id: string },
  branches?: string[],
): RuntimeWorkflow => ({
  id: handle.id,
  steps: [
    {
      kind: "approval",
      id: "signoff",
      prompt: () => "Approve the release?",
      approvers: ["maintainer"],
      onApprove: [
        {
          kind: "transform",
          id: "approved-out",
          compute: () => {
            branches?.push("approved")
            return "approved-path"
          },
        },
      ],
      onReject: [
        {
          kind: "transform",
          id: "rejected-out",
          compute: () => {
            branches?.push("rejected")
            return "rejected-path"
          },
        },
      ],
    },
  ],
})

function setupApp(): ReturnType<typeof createAppRegistry> {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir: tmpDir,
    dataDir: join(tmpDir, "data"),
    agents: [],
    workflows: [{ id: WORKFLOW_ID, path: join(tmpDir, "WORKFLOW.md") }],
    unvalidatedAgentTools: [],
  })
  return appRegistry
}

async function awaitStatus(
  runner: ReturnType<typeof createWorkflowRunner>,
  runId: string,
  target: WorkflowRun["status"],
): Promise<WorkflowRun> {
  let run = runner.status(runId)
  for (let i = 0; i < 250 && (!run || run.status !== target); i++) {
    await new Promise(res => setTimeout(res, 20))
    run = runner.status(runId)
  }
  if (!run || run.status !== target) {
    throw new Error(`run never reached status "${target}" (last: ${run?.status})`)
  }
  return run
}

describe("WorkflowRunner human approvals (WP-S)", () => {
  it("blocks at the approval step, resolves on approve, runs onApprove + ledger `approval` event with who", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-approval-test-"))
    bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const appRegistry = setupApp()
    const branches: string[] = []
    const path = writeApprovalWorkflowFile({})

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileApprovalWorkflow(handle, branches),
      appRegistry,
    })

    const started = await runner.startFromFile({ path, appRunId: APP_RUN_ID })
    // startFromFile returns immediately; the run may already be parked.
    expect(["running", "awaiting-approval"]).toContain(started.status)

    const parked = await awaitStatus(runner, started.runId, "awaiting-approval")
    // workflow_status shows the parked approval…
    expect(parked.awaitingApproval).toMatchObject({
      stepId: "signoff",
      prompt: "Approve the release?",
    })
    expect(parked.awaitingApproval?.approvalId).toMatch(/^wfappr_/)
    // …and a workflow:approval-requested event went out.
    const requested = events.find(e => e.type === "workflow:approval-requested")
    expect(requested).toMatchObject({
      type: "workflow:approval-requested",
      runId: started.runId,
      stepId: "signoff",
      prompt: "Approve the release?",
      approvers: ["maintainer"],
    })

    // Nothing is ledgered while parked — only the decision writes state.
    const preEvents = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    expect(preEvents.filter(e => e.kind === "approval")).toHaveLength(0)

    const resolved = runner.resolveApproval(started.runId, {
      approvalId: parked.awaitingApproval!.approvalId,
      approved: true,
      who: "jeremy",
      note: "ship it",
    })
    expect(resolved).toEqual({ ok: true })

    const final = await awaitStatus(runner, started.runId, "done")
    // onApprove branch ran; the parked record cleared.
    expect(final.awaitingApproval).toBeUndefined()
    expect(branches).toEqual(["approved"])
    let ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    for (let i = 0; i < 100 && ledger.filter(e => e.kind === "approval").length === 0; i++) {
      await new Promise(res => setTimeout(res, 20))
      ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    }
    const approvals = ledger.filter(e => e.kind === "approval")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      stage: "signoff",
      by: "human",
      appRunId: APP_RUN_ID,
      payload: { approved: true, who: "jeremy", note: "ship it", runId: started.runId },
    })

    const resolvedEv = events.find(e => e.type === "workflow:approval-resolved")
    expect(resolvedEv).toMatchObject({
      type: "workflow:approval-resolved",
      runId: started.runId,
      stepId: "signoff",
      approved: true,
      who: "jeremy",
    })
    expect(final.status).toBe("done")
  })

  it("reject → onReject branch runs, decision recorded", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-approval-reject-test-"))
    bus = createSessionEventBus()
    const appRegistry = setupApp()
    const branches: string[] = []
    const path = writeApprovalWorkflowFile({})

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileApprovalWorkflow(handle, branches),
      appRegistry,
    })

    const started = await runner.startFromFile({ path })
    await awaitStatus(runner, started.runId, "awaiting-approval")

    const resolved = runner.resolveApproval(started.runId, {
      approved: false,
      who: "no-scope-esc",
    })
    expect(resolved).toEqual({ ok: true })

    const final = await awaitStatus(runner, started.runId, "done")
    expect(final.status).toBe("done")
    // The onReject branch ran, not onApprove.
    expect(branches).toEqual(["rejected"])

    let ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    for (let i = 0; i < 100 && ledger.filter(e => e.kind === "approval").length === 0; i++) {
      await new Promise(res => setTimeout(res, 20))
      ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    }
    const approvals = ledger.filter(e => e.kind === "approval")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      by: "human",
      payload: { approved: false, who: "no-scope-esc" },
    })
  })

  it("timeout resolves as REJECTED with who=timeout (by=system on the ledger)", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-approval-timeout-test-"))
    bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(ev => events.push(ev))
    const appRegistry = setupApp()
    const path = writeApprovalWorkflowFile({ timeoutMs: 50 })

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => ({
        ...compileApprovalWorkflow(handle),
        steps: [
          {
            kind: "approval",
            id: "signoff",
            prompt: () => "Approve the release?",
            approvers: ["maintainer"],
            timeoutMs: 50,
            onReject: [{ kind: "transform", id: "rejected-out", compute: () => "rejected-path" }],
          },
        ],
      }),
      appRegistry,
    })

    const started = await runner.startFromFile({ path })
    await awaitStatus(runner, started.runId, "awaiting-approval")

    const final = await awaitStatus(runner, started.runId, "done")
    expect(final.awaitingApproval).toBeUndefined()

    let ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    for (let i = 0; i < 100 && ledger.filter(e => e.kind === "approval").length === 0; i++) {
      await new Promise(res => setTimeout(res, 20))
      ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    }
    const approvals = ledger.filter(e => e.kind === "approval")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      by: "system",
      payload: { approved: false, who: "timeout" },
    })

    const resolvedEv = events.find(e => e.type === "workflow:approval-resolved")
    expect(resolvedEv).toMatchObject({ approved: false, who: "timeout" })
  })

  it("survives a daemon restart: reload keeps awaiting-approval, re-registers the pending item, exactly one ledger event", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-approval-restart-test-"))
    bus = createSessionEventBus()
    const appRegistry = setupApp()
    const persistPath = join(tmpDir, "workflow-runs.json")
    const path = writeApprovalWorkflowFile({})

    const runner1 = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: compileApprovalWorkflow,
      appRegistry,
      persistPath,
    })
    const started = await runner1.startFromFile({ path, appRunId: APP_RUN_ID })
    const parked = await awaitStatus(runner1, started.runId, "awaiting-approval")
    expect(parked.awaitingApproval?.approvalId).toMatch(/^wfappr_/)

    // "Restart": a fresh runner over the same persist file.
    const bus2 = createSessionEventBus()
    const events2: SessionEvent[] = []
    bus2.onAny(ev => events2.push(ev))
    const runner2 = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus2,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: compileApprovalWorkflow,
      appRegistry,
      persistPath,
    })
    const reloaded = runner2.status(started.runId)
    expect(reloaded?.status).toBe("awaiting-approval")
    expect(reloaded?.awaitingApproval).toMatchObject({ stepId: "signoff" })

    const resolved = runner2.resolveApproval(started.runId, {
      approvalId: reloaded!.awaitingApproval!.approvalId,
      approved: true,
      who: "jeremy",
    })
    expect(resolved).toEqual({ ok: true })
    expect(events2.some(e => e.type === "workflow:approval-resolved")).toBe(true)

    let ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    for (let i = 0; i < 100 && ledger.filter(e => e.kind === "approval").length === 0; i++) {
      await new Promise(res => setTimeout(res, 20))
      ledger = (await readAppStateEvents({ dir: tmpDir, dataDir: join(tmpDir, "data") })).events
    }
    const approvals = ledger.filter(e => e.kind === "approval")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ by: "human", payload: { approved: true, who: "jeremy" } })

    // The in-flight execution could not survive the restart — the run fails
    // honestly instead of pretending to resume.
    const final = runner2.status(started.runId)
    expect(final?.status).toBe("failed")
    expect(final?.error).toMatch(/daemon restart/)
    // Second resolution is a no-op.
    expect(
      runner2.resolveApproval(started.runId, { approved: false, who: "late" }).ok,
    ).toBe(false)
  })

  it("resolveApproval errors clearly on unknown run / not-awaiting / id mismatch", async () => {
    tmpDir = mkdtempSync(join(inRootTmpBase, ".workflow-approval-errors-test-"))
    bus = createSessionEventBus()
    const appRegistry = setupApp()
    const path = writeApprovalWorkflowFile({})

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: compileApprovalWorkflow,
      appRegistry,
    })

    expect(runner.resolveApproval("wfrun_nope", { approved: true, who: "x" }).ok).toBe(false)

    const started = await runner.startFromFile({ path })
    await awaitStatus(runner, started.runId, "awaiting-approval")
    const mismatch = runner.resolveApproval(started.runId, {
      approvalId: "wfappr_wrong",
      approved: true,
      who: "x",
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error).toBe("approval_id_mismatch")
  })
})
