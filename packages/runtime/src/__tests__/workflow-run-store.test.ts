/**
 * Bounded workflow-run persistence: output ceilings, per-run files with
 * dirty-only writes, lazy load of terminal runs, legacy-registry migration,
 * stale-approval expiry, and a synthetic 700-run size comparison.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"
import {
  createWorkflowRunner,
  type WorkflowRun,
  type WorkflowRunner,
} from "../workflow-runner.js"
import {
  DEFAULT_OUTPUT_LIMITS,
  boundOutput,
  isBoundedOutputRef,
  leaseFilePath,
  listRunIds,
  migrateLegacyRuns,
  readRunFull,
  readRunHeader,
  runFilePath,
  runStoreDir,
  spillFilePath,
  applyOutputCeilings,
} from "../workflow-run-store.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createAppRegistry } from "../app-registry.js"
import type { SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const tmpBase = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules")

let tmpDir: string
let persistPath: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpBase, ".workflow-run-store-test-"))
  persistPath = join(tmpDir, "workflow-runs.json")
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeRegistry(): SessionsRegistry {
  return {
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    findByIdOrName: vi.fn(),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

const adapter: AgentAdapterResolver = vi.fn(async () => ({
  startSession: async () => ({
    sessionId: "adapter_x",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }),
  commandPreview: "mock-adapter",
}))

const APP_ID = "@test/store-app"
const WORKFLOW_ID = "store-wf"

function writeWorkflowMd(): string {
  const path = join(tmpDir, "WORKFLOW.md")
  writeFileSync(
    path,
    `---\nname: Store\nid: ${WORKFLOW_ID}\ndescription: test\nversion: 0.1.0\ninputs: {}\noutputs: {}\nsteps:\n  - id: s\n    kind: transform\n---\n`,
    "utf8",
  )
  return path
}

function appRegistry(): ReturnType<typeof createAppRegistry> {
  const reg = createAppRegistry()
  reg.upsertApp({
    appId: APP_ID,
    dir: tmpDir,
    dataDir: join(tmpDir, "data"),
    agents: [],
    workflows: [{ id: WORKFLOW_ID, path: join(tmpDir, "WORKFLOW.md") }],
    unvalidatedAgentTools: [],
  })
  return reg
}

function makeRunner(
  compile: (handle: { id: string }) => RuntimeWorkflow,
  extra: Partial<Parameters<typeof createWorkflowRunner>[0]> = {},
): WorkflowRunner {
  return createWorkflowRunner({
    registry: makeRegistry(),
    sessionEvents: createSessionEventBus(),
    resolveAgentAdapter: adapter,
    compileWorkflow: compile,
    appRegistry: appRegistry(),
    persistPath,
    runsRoot: join(tmpDir, "runs"),
    persistMinIntervalMs: 0,
    ...extra,
  })
}

async function waitStatus(runner: WorkflowRunner, runId: string, target: WorkflowRun["status"]): Promise<WorkflowRun> {
  for (let i = 0; i < 300; i++) {
    const r = runner.status(runId)
    if (r?.status === target) return r
    await new Promise(res => setTimeout(res, 20))
  }
  throw new Error(`run never reached ${target} (last ${runner.status(runId)?.status})`)
}

const bigString = (n: number): string => "x".repeat(n)

function transformWorkflow(outputs: Record<string, unknown>): (h: { id: string }) => RuntimeWorkflow {
  return handle => ({
    id: handle.id,
    steps: Object.entries(outputs).map(([id, value]) => ({
      kind: "transform" as const,
      id,
      compute: () => value,
    })),
  })
}

function approvalWorkflow(handle: { id: string }): RuntimeWorkflow {
  return {
    id: handle.id,
    steps: [
      {
        kind: "approval",
        id: "signoff",
        prompt: () => "Approve?",
        approvers: ["maintainer"],
        onApprove: [{ kind: "transform", id: "ok", compute: () => "ok" }],
        onReject: [{ kind: "transform", id: "no", compute: () => "no" }],
      },
    ],
  }
}

function syntheticRun(i: number, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const startedAt = new Date(Date.now() - (800 - i) * 60_000).toISOString()
  return {
    runId: `wfrun_syn${String(i).padStart(4, "0")}`,
    workflowId: "synthetic",
    status: "done",
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 5_000).toISOString(),
    stages: [
      {
        index: 0,
        status: "done",
        steps: [
          { index: 0, label: "list", status: "done", output: { rows: Array.from({ length: 200 }, (_, k) => ({ id: k, note: bigString(300) })) } },
          { index: 1, label: "judge", status: "done", output: bigString(20_000) },
        ],
      },
    ],
    output: { summary: bigString(5_000) },
    ...over,
  } as WorkflowRun
}

describe("output ceilings", () => {
  it("boundOutput keeps small values inline and turns big ones into preview + pointer", () => {
    const small = boundOutput({ a: 1 }, "step-output:s", { inlineBytes: 100, previewChars: 10, budgetLeft: 1000 })
    expect(small.stored).toEqual({ a: 1 })
    expect(small.spill).toBeUndefined()

    const big = boundOutput(bigString(500), "step-output:s", { inlineBytes: 100, previewChars: 10, budgetLeft: 1000 })
    expect(isBoundedOutputRef(big.stored)).toBe(true)
    expect(big.stored).toMatchObject({ truncated: true, ref: "step-output:s", bytes: 502 })
    expect((big.stored as { preview: string }).preview).toHaveLength(10)
    expect(JSON.parse(big.spill!)).toBe(bigString(500))

    // Already-bounded values are left alone (idempotent).
    expect(boundOutput(big.stored, "step-output:s", { inlineBytes: 1, previewChars: 1, budgetLeft: 0 }).spill).toBeUndefined()
  })

  it("applyOutputCeilings enforces the per-run budget across steps", () => {
    const run = syntheticRun(1)
    const spilled: string[] = []
    applyOutputCeilings(
      run,
      { ...DEFAULT_OUTPUT_LIMITS, stepInlineBytes: 1_000_000, runBudgetBytes: 3_000, runOutputInlineBytes: 1_000, previewChars: 100 },
      ref => spilled.push(ref),
    )
    const [list, judge] = run.stages[0]!.steps
    expect(isBoundedOutputRef(list!.output)).toBe(true)
    expect(isBoundedOutputRef(judge!.output)).toBe(true)
    expect(spilled).toContain("step-output:list")
    expect(spilled).toContain("step-output:judge")
    expect(isBoundedOutputRef(run.output)).toBe(true)
  })

  it("persists a bounded preview, spills the full value, and status/readArtifact still reach it", async () => {
    const full = bigString(50_000)
    const runner = makeRunner(transformWorkflow({ small: "tiny", huge: full }))
    const started = await runner.startFromFile({ path: writeWorkflowMd() })
    await waitStatus(runner, started.runId, "done")
    await runner.flush()

    const steps = runner.status(started.runId)!.stages.flatMap(s => s.steps)
    const small = steps.find(s => s.label === "small")!
    const huge = steps.find(s => s.label === "huge")!
    expect(small.output).toBe("tiny")
    expect(isBoundedOutputRef(huge.output)).toBe(true)
    expect((huge.output as { preview: string }).preview.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_LIMITS.previewChars)

    // On disk: the run file carries only the pointer; the spill file the full value.
    const file = runFilePath(runStoreDir(persistPath), started.runId)!
    expect(statSync(file).size).toBeLessThan(20_000)
    const spill = spillFilePath(join(tmpDir, "runs"), started.runId, "step-output:huge")!
    expect(existsSync(spill)).toBe(true)
    expect(JSON.parse(readFileSync(spill, "utf8"))).toBe(full)

    // workflow_status full:true → resolved copy; the stored record is untouched.
    const resolved = runner.status(started.runId, { resolveOutputs: true })!
    expect(resolved.stages.flatMap(s => s.steps).find(s => s.label === "huge")!.output).toBe(full)
    expect(isBoundedOutputRef(runner.status(started.runId)!.stages.flatMap(s => s.steps).find(s => s.label === "huge")!.output)).toBe(true)

    // workflow_artifact_get
    const art = await runner.readArtifact(started.runId, "step-output:huge")
    expect(art.ok).toBe(true)
    if (art.ok) expect(JSON.parse(art.content.toString("utf8"))).toBe(full)
  })

  it("honours configured limits", async () => {
    const runner = makeRunner(transformWorkflow({ mid: bigString(300) }), {
      outputLimits: { stepInlineBytes: 100, previewChars: 20 },
    })
    const started = await runner.startFromFile({ path: writeWorkflowMd() })
    await waitStatus(runner, started.runId, "done")
    const mid = runner.status(started.runId)!.stages.flatMap(s => s.steps).find(s => s.label === "mid")!
    expect(isBoundedOutputRef(mid.output)).toBe(true)
    expect((mid.output as { preview: string }).preview).toHaveLength(20)
  })
})

describe("per-run files, dirty-only writes", () => {
  it("writes only the run that changed, and lease heartbeats touch only the lease sidecar", async () => {
    const runner = makeRunner(approvalWorkflow, { heartbeatIntervalMs: 25 })
    const a = await runner.startFromFile({ path: writeWorkflowMd() })
    await waitStatus(runner, a.runId, "awaiting-approval")
    const b = await runner.startFromFile({ path: writeWorkflowMd() })
    await waitStatus(runner, b.runId, "awaiting-approval")
    await new Promise(res => setTimeout(res, 100))
    await runner.flush()

    const dir = runStoreDir(persistPath)
    const fileA = runFilePath(dir, a.runId)!
    const fileB = runFilePath(dir, b.runId)!
    const leaseA = leaseFilePath(dir, a.runId)!
    const mtime = (p: string): number => statSync(p).mtimeMs
    const runFilesBefore = [mtime(fileA), mtime(fileB)]
    const leaseBefore = readFileSync(leaseA, "utf8")

    await new Promise(res => setTimeout(res, 200))
    await runner.flush()

    expect([mtime(fileA), mtime(fileB)]).toEqual(runFilesBefore)
    expect(readFileSync(leaseA, "utf8")).not.toBe(leaseBefore)

    // Resolving A rewrites A only.
    const before = mtime(fileB)
    runner.resolveApproval(a.runId, { approved: true, who: "t" })
    await waitStatus(runner, a.runId, "done")
    for (let i = 0; i < 50 && readRunFull(fileA)?.status !== "done"; i++) {
      await new Promise(res => setTimeout(res, 20))
      await runner.flush()
    }
    expect(mtime(fileB)).toBe(before)
    expect(readRunFull(fileA)?.status).toBe("done")
    // A finished run no longer has a lease sidecar.
    expect(existsSync(leaseA)).toBe(false)
  })
})

describe("memory: summaries and lazy load", () => {
  it("keeps only a bounded terminal index in memory and lazy-loads the rest from disk", async () => {
    const dir = runStoreDir(persistPath)
    const seed = makeRunner(transformWorkflow({}), {})
    await seed.flush()
    const { serializeRunFile, writeFileAtomicSync } = await import("../workflow-run-store.js")
    for (let i = 0; i < 40; i++) {
      const run = syntheticRun(i)
      applyOutputCeilings(run, DEFAULT_OUTPUT_LIMITS, () => {})
      writeFileAtomicSync(runFilePath(dir, run.runId)!, dir, serializeRunFile(run))
    }
    const runner = makeRunner(transformWorkflow({}), { summaryMaxCount: 10, summaryMaxAgeMs: 0 })
    const listed = runner.list()
    expect(listed).toHaveLength(10)
    // newest ten
    expect(listed.map(r => r.runId).sort()[0]).toBe("wfrun_syn0030")
    // summaries carry no step outputs
    expect(listed.every(r => r.stages.every(s => s.steps.every(st => st.output === undefined)))).toBe(true)

    // an evicted old run is still reachable through status()
    const old = runner.status("wfrun_syn0001")
    expect(old?.status).toBe("done")
    expect(old?.stages[0]?.steps[0]?.label).toBe("list")
    // and a summary run's detail is lazy-loaded with its bounded output
    const detail = runner.status("wfrun_syn0035")!
    expect(isBoundedOutputRef(detail.stages[0]!.steps[1]!.output)).toBe(true)
    expect(runner.status("wfrun_missing")).toBeUndefined()
  })
})

describe("legacy migration", () => {
  function legacyFixture(): { runs: WorkflowRun[]; multiMbId: string } {
    const runs: WorkflowRun[] = []
    for (let i = 0; i < 6; i++) runs.push(syntheticRun(i))
    const huge = syntheticRun(6)
    huge.stages[0]!.steps[1]!.output = bigString(3 * 1024 * 1024)
    runs.push(huge)
    runs.push(
      syntheticRun(7, {
        status: "running",
        endedAt: undefined,
        lease: { ownerId: "dead-owner", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      } as Partial<WorkflowRun>),
    )
    runs.push(
      syntheticRun(8, {
        status: "awaiting-approval",
        endedAt: undefined,
        awaitingApproval: { approvalId: "wfappr_legacy", stepId: "signoff", prompt: "Approve?", since: new Date().toISOString() },
      } as Partial<WorkflowRun>),
    )
    return { runs, multiMbId: huge.runId }
  }

  it("splits the registry into per-run files with ceilings applied, keeps a .bak, preserves live runs", async () => {
    const { runs, multiMbId } = legacyFixture()
    writeFileSync(persistPath, JSON.stringify(runs))
    const legacyBytes = statSync(persistPath).size
    expect(legacyBytes).toBeGreaterThan(3 * 1024 * 1024)

    const runner = makeRunner(transformWorkflow({}))
    await runner.flush()

    expect(existsSync(persistPath)).toBe(false)
    expect(existsSync(`${persistPath}.bak`)).toBe(true)
    expect(statSync(`${persistPath}.bak`).size).toBe(legacyBytes)

    const dir = runStoreDir(persistPath)
    expect(listRunIds(dir).sort()).toEqual(runs.map(r => r.runId).sort())
    // Multi-MB run: the run file is small, the full value lives in the spill.
    const bigFile = runFilePath(dir, multiMbId)!
    expect(statSync(bigFile).size).toBeLessThan(30_000)
    const spill = spillFilePath(join(tmpDir, "runs"), multiMbId, "step-output:judge")!
    expect(statSync(spill).size).toBeGreaterThan(3 * 1024 * 1024)

    // Running run: its owner is dead → failed "orphaned"/interrupted, never dropped.
    const running = runner.status("wfrun_syn0007")!
    expect(running).toBeDefined()
    expect(running.status).not.toBe("running")
    // Awaiting approval survives with its pending approval.
    const awaiting = runner.status("wfrun_syn0008")!
    expect(awaiting.status).toBe("awaiting-approval")
    expect(awaiting.awaitingApproval?.approvalId).toBe("wfappr_legacy")
    // Everything is still reachable.
    expect(runner.status("wfrun_syn0000")?.status).toBe("done")
    expect(runner.list()).toHaveLength(runs.length)
  })

  it("is idempotent and crash-safe: a half-done migration is completed, a finished one is not redone", async () => {
    const { runs } = legacyFixture()
    writeFileSync(persistPath, JSON.stringify(runs))
    const dir = runStoreDir(persistPath)
    const limits = { ...DEFAULT_OUTPUT_LIMITS }
    const runsRoot = join(tmpDir, "runs")

    // Crash simulation: migrate, then put the legacy file back as if the
    // final rename never happened.
    const first = migrateLegacyRuns({ persistPath, dir, runsRoot, limits })!
    expect(first.migrated).toBe(runs.length)
    const marker = readFileSync(runFilePath(dir, runs[0]!.runId)!, "utf8")
    rmSync(runFilePath(dir, runs[1]!.runId)!)
    writeFileSync(persistPath, JSON.stringify(runs))

    const second = migrateLegacyRuns({ persistPath, dir, runsRoot, limits })!
    expect(second.migrated).toBe(1)
    expect(second.alreadyPresent).toBe(runs.length - 1)
    // existing per-run files are not overwritten
    expect(readFileSync(runFilePath(dir, runs[0]!.runId)!, "utf8")).toBe(marker)
    expect(readRunHeader(runFilePath(dir, runs[1]!.runId)!)?.runId).toBe(runs[1]!.runId)

    // Nothing left to migrate.
    expect(migrateLegacyRuns({ persistPath, dir, runsRoot, limits })).toBeUndefined()
  })

  it("skips junk elements without losing the rest", () => {
    writeFileSync(persistPath, JSON.stringify([syntheticRun(1), { nope: true }, 5, syntheticRun(2)]))
    const dir = runStoreDir(persistPath)
    const r = migrateLegacyRuns({ persistPath, dir, runsRoot: join(tmpDir, "runs"), limits: DEFAULT_OUTPUT_LIMITS })!
    expect(r.migrated).toBe(2)
    expect(r.skipped).toBe(1)
  })
})

describe("stale approvals", () => {
  async function parkApproval(extra: Partial<Parameters<typeof createWorkflowRunner>[0]> = {}) {
    const runner = makeRunner(approvalWorkflow, extra)
    const started = await runner.startFromFile({ path: writeWorkflowMd() })
    const parked = await waitStatus(runner, started.runId, "awaiting-approval")
    await runner.flush()
    return { runner, runId: started.runId, approvalId: parked.awaitingApproval!.approvalId }
  }

  it("a restart keeps a fresh approval as an envelope; deciding it resolves the full run from its file", async () => {
    const { runId, approvalId } = await parkApproval()
    const runner2 = makeRunner(approvalWorkflow)
    const env = runner2.status(runId)!
    expect(env.status).toBe("awaiting-approval")
    expect(env.awaitingApproval?.approvalId).toBe(approvalId)

    expect(runner2.resolveApproval(runId, { approvalId, approved: true, who: "jeremy" })).toEqual({ ok: true })
    const final = runner2.status(runId)!
    expect(final.status).toBe("failed")
    // The full run (stages, input, ...) was re-read, not the bare envelope.
    expect(final.stages.length).toBeGreaterThan(0)
    await runner2.flush()
    expect(readRunFull(runFilePath(runStoreDir(persistPath), runId)!)?.status).toBe("failed")
  })

  it("expires an approval older than approvalTtlMs at boot", async () => {
    const { runId } = await parkApproval()
    const later = new Date(Date.now() + 10_000)
    const runner2 = makeRunner(approvalWorkflow, { approvalTtlMs: 5_000, now: () => later })
    const run = runner2.status(runId)!
    expect(run.status).toBe("failed")
    expect(run.awaitingApproval).toBeUndefined()
    expect(run.error).toMatch(/expired/i)
    expect(runner2.resolveApproval(runId, { approved: true, who: "late" }).ok).toBe(false)
  })

  it("sweep() expires a restart-orphaned approval once it ages past the TTL; approvalTtlMs: 0 never expires", async () => {
    const { runId } = await parkApproval()
    const runner2 = makeRunner(approvalWorkflow, { approvalTtlMs: 60_000 })
    expect(runner2.sweep(new Date(Date.now() + 1_000)).expiredApprovals ?? []).toEqual([])
    expect(runner2.status(runId)!.status).toBe("awaiting-approval")
    const swept = runner2.sweep(new Date(Date.now() + 120_000))
    expect(swept.expiredApprovals).toEqual([runId])
    const run = runner2.status(runId)!
    expect(run.status).toBe("failed")
    expect(run.errorCode).toBe("approval-expired")

    const { runId: id2 } = await parkApproval()
    const runner3 = makeRunner(approvalWorkflow, { approvalTtlMs: 0 })
    runner3.sweep(new Date(Date.now() + 365 * 86_400_000))
    expect(runner3.status(id2)!.status).toBe("awaiting-approval")
  })
})

describe("synthetic 700-run registry: before vs after", () => {
  it("shrinks the on-disk registry and the resident heap", async () => {
    const runs = Array.from({ length: 700 }, (_, i) => syntheticRun(i))
    const legacyText = JSON.stringify(runs)
    writeFileSync(persistPath, legacyText)
    const legacyBytes = Buffer.byteLength(legacyText)

    const dir = runStoreDir(persistPath)
    const t0 = Date.now()
    const runner = makeRunner(transformWorkflow({}))
    const bootMs = Date.now() - t0
    await runner.flush()

    const newBytes = listRunIds(dir).reduce((n, id) => n + statSync(runFilePath(dir, id)!).size, 0)
    const spillBytes = (() => {
      let n = 0
      const root = join(tmpDir, "runs")
      for (const id of readdirSync(root)) {
        const sub = join(root, id, "step-outputs")
        if (existsSync(sub)) for (const f of readdirSync(sub)) n += statSync(join(sub, f)).size
      }
      return n
    })()
    expect(runner.list()).toHaveLength(500)
    expect(newBytes).toBeLessThan(legacyBytes / 8)

    // Resident size proxy: JSON length of everything list() returns, vs. the
    // legacy behaviour of holding every run in full.
    const residentAfter = Buffer.byteLength(JSON.stringify(runner.list()))
    expect(residentAfter).toBeLessThan(legacyBytes / 20)
    console.info(
      `[bench] 700 synthetic runs: legacy registry ${(legacyBytes / 1e6).toFixed(1)} MB → per-run files ` +
        `${(newBytes / 1e6).toFixed(2)} MB (+${(spillBytes / 1e6).toFixed(1)} MB spilled outputs); ` +
        `resident list() ${(residentAfter / 1e6).toFixed(2)} MB vs ${(legacyBytes / 1e6).toFixed(1)} MB; boot ${bootMs} ms`,
    )
  })
})
