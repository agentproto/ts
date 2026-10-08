/**
 * AIP-58 §6 Journal — `run.retry` (P5). Host-level tests for
 * `WorkflowRunner.retry()` / the `workflow_retry` MCP tool: given a
 * failed/cancelled runId, a NEW run replays every step the original already
 * completed from its own journal (no re-execution) and re-executes only from
 * the first step that never succeeded — working REGARDLESS of whether the
 * original run ever passed a `cacheKey` (the internal, always-on per-run
 * journal — see `internalJournal` in `workflow-runner.ts`). When the
 * original DID pass its own `cacheKey`, that cache's existing semantics stay
 * unchanged (only steps declared `cacheable: true` write anywhere) — its
 * writes are additionally relayed into the internal journal
 * (`teeIntoInternalJournal`) so `retry()` still finds them.
 *
 * V7 (`specs/resources/aip-58/draft/vectors/v7-replay.json`) names a more
 * general `run.replay { of, fromStep }` verb that can replay from an
 * arbitrary step of ANY run, including an already-`succeeded` one. This P5
 * slice implements the narrower `run.retry` shape actually requested here:
 * only a `failed`/`cancelled` run is retryable, and the resume point is
 * always auto-detected (the first step that never succeeded) rather than a
 * caller-chosen `fromStep`. The journal-sourced replay MECHANISM underneath
 * — steps 1..N-1 reused verbatim, step N onward re-executed fresh — is
 * exactly what the vector exercises; see the last test in this file for a
 * run built to the vector's own shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createWorkflowRunner, type WorkflowRun } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VECTORS_DIR = join(__dirname, "../../../../specs/resources/aip-58/draft/vectors")

function makeMockRegistry(overrides: Partial<SessionsRegistry> = {}): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()
  return {
    spawnAgent: (input: { cwd: string; label?: string }) => {
      const id = `sess_${Math.random().toString(36).slice(2, 8)}`
      const desc = {
        id,
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        label: input.label,
      }
      descriptors.set(id, desc)
      return desc
    },
    sendPrompt: async () => {},
    get: (id: string) => descriptors.get(id),
    ...overrides,
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return (async () => ({
    startSession: async () => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  })) as unknown as AgentAdapterResolver
}

/** A `{n: number}` in, `{n: n+1}` out tool — the spy counts real dispatches
 *  (never incremented on a journal replay, since a cache hit never calls
 *  into the driver at all). */
function makeIncTool(id: string) {
  let calls = 0
  const tool = defineTool({
    id,
    description: "n -> n+1",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ n: z.number() }),
  })
  const driver = defineDriver({
    id: `${id}-driver`,
    name: id,
    description: "n -> n+1",
    kind: "builtin",
    implements: [{ tool: id, version: "0.1.0" }],
    implementations: [
      implementTool(tool, ({ input }) => {
        calls++
        return { n: input.n + 1 }
      }),
    ],
  })
  return { tool, driver, calls: () => calls }
}

/** Same shape as `makeIncTool`, but throws on its FIRST call and succeeds
 *  (n -> n+1) on every call after — simulates a step that failed the
 *  original run and succeeds once retried. */
function makeFlakyIncTool(id: string) {
  let calls = 0
  const tool = defineTool({
    id,
    description: "n -> n+1, fails once",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ n: z.number() }),
  })
  const driver = defineDriver({
    id: `${id}-driver`,
    name: id,
    description: "n -> n+1, fails once",
    kind: "builtin",
    implements: [{ tool: id, version: "0.1.0" }],
    implementations: [
      implementTool(tool, ({ input }) => {
        calls++
        if (calls === 1) throw new Error(`${id}: transient failure`)
        return { n: input.n + 1 }
      }),
    ],
  })
  return { tool, driver, calls: () => calls }
}

/** 5-step chain: fetch -> parse -> draft(flaky) -> polish -> save, each
 *  `{n}` in / `{n: n+1}` out, threaded `$steps.<id>.n`. `fetch` alone reads
 *  `$input.n` directly — everything downstream depends on it transitively.
 *  `cacheableSteps` (default: none declared) marks the named steps
 *  `cacheable: true` in the generated manifest — needed for a test that
 *  starts the run with its OWN explicit `cacheKey` (that path respects each
 *  step's declared `cacheable` exactly as before P5, never forcing it). */
function makeFiveStepWorkflow(cacheableSteps: readonly string[] = []) {
  const fetch = makeIncTool("demo.fetch")
  const parse = makeIncTool("demo.parse")
  const draft = makeFlakyIncTool("demo.draft")
  const polish = makeIncTool("demo.polish")
  const save = makeIncTool("demo.save")
  const cacheableLine = (id: string): string => (cacheableSteps.includes(id) ? "\n    cacheable: true" : "")
  const manifest = `---
name: Five step chain
id: five-step-chain
description: fetch -> parse -> draft(flaky) -> polish -> save.
version: 0.1.0
inputs:
  type: object
  properties:
    n: { type: number }
  required: ["n"]
outputs: {}
steps:
  - id: fetch
    kind: tool
    tool: demo.fetch
    inputs:
      n: $input.n${cacheableLine("fetch")}
  - id: parse
    kind: tool
    tool: demo.parse
    inputs:
      n: $steps.fetch.n${cacheableLine("parse")}
  - id: draft
    kind: tool
    tool: demo.draft
    inputs:
      n: $steps.parse.n${cacheableLine("draft")}
  - id: polish
    kind: tool
    tool: demo.polish
    inputs:
      n: $steps.draft.n${cacheableLine("polish")}
  - id: save
    kind: tool
    tool: demo.save
    inputs:
      n: $steps.polish.n${cacheableLine("save")}
---
`
  const tools = {
    "demo.fetch": fetch.tool,
    "demo.parse": parse.tool,
    "demo.draft": draft.tool,
    "demo.polish": polish.tool,
    "demo.save": save.tool,
  }
  const candidates = [fetch.driver, parse.driver, draft.driver, polish.driver, save.driver]
  return { manifest, tools, candidates, steps: { fetch, parse, draft, polish, save } }
}

async function waitTerminal(runner: ReturnType<typeof createWorkflowRunner>, runId: string): Promise<WorkflowRun | undefined> {
  const terminal = new Set(["done", "failed", "cancelled"])
  let final = runner.status(runId)
  for (let i = 0; i < 200 && final && !terminal.has(final.status); i++) {
    await new Promise(res => setTimeout(res, 10))
    final = runner.status(runId)
  }
  return final
}

describe("AIP-58 §6 Journal — WorkflowRunner.retry() (P5)", () => {
  let tmpDir: string
  let persistPath: string
  let runsRoot: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workflow-retry-"))
    persistPath = join(tmpDir, "workflow-runs.json")
    runsRoot = join(tmpDir, "runs")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("failure at step 3 of 5 — retry replays steps 1-2 from the journal (no re-dispatch) and runs 3-5 fresh", async () => {
    const wf = makeFiveStepWorkflow()
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(path, wf.manifest, "utf8")

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
    })

    const original = await runner.startFromFile({ path, input: { n: 1 } })
    const failed = await waitTerminal(runner, original.runId)
    expect(failed?.status).toBe("failed")
    expect(wf.steps.fetch.calls()).toBe(1)
    expect(wf.steps.parse.calls()).toBe(1)
    expect(wf.steps.draft.calls()).toBe(1) // the failing attempt
    expect(wf.steps.polish.calls()).toBe(0)
    expect(wf.steps.save.calls()).toBe(0)
    const byLabel = new Map(failed!.stages[0]!.steps.map(s => [s.label, s]))
    expect(byLabel.get("fetch")?.status).toBe("done")
    expect(byLabel.get("parse")?.status).toBe("done")
    expect(byLabel.get("draft")?.status).toBe("failed")

    const result = await runner.retry(original.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.run.runId).not.toBe(original.runId)
    expect(result.run.retryOf).toBe(original.runId)

    const retried = await waitTerminal(runner, result.run.runId)
    expect(retried?.status).toBe("done")
    expect(retried?.output).toEqual({ n: 6 }) // 1 -> 2 -> 3 -> 4 -> 5 -> 6

    // Steps 1-2 never re-dispatched — journal-sourced, no new tool call.
    expect(wf.steps.fetch.calls()).toBe(1)
    expect(wf.steps.parse.calls()).toBe(1)
    // Step 3 onward re-executed for real (draft's 2nd call finally succeeds).
    expect(wf.steps.draft.calls()).toBe(2)
    expect(wf.steps.polish.calls()).toBe(1)
    expect(wf.steps.save.calls()).toBe(1)

    const retriedByLabel = new Map(retried!.stages[0]!.steps.map(s => [s.label, s]))
    expect(retriedByLabel.get("fetch")).toMatchObject({ status: "done", cached: true })
    expect(retriedByLabel.get("parse")).toMatchObject({ status: "done", cached: true })
    expect(retriedByLabel.get("draft")?.cached).toBeUndefined()
    expect(retriedByLabel.get("polish")?.cached).toBeUndefined()
    expect(retriedByLabel.get("save")?.cached).toBeUndefined()

    // The original run is untouched — still failed, still immutable.
    expect(runner.status(original.runId)?.status).toBe("failed")

    // AIP-58 events: retry linkage rides on the NEW run's run.created data.
    const events = runner.events(result.run.runId)
    expect(events?.[0]).toMatchObject({ type: "run.created", data: { workflowId: "five-step-chain", retryOf: original.runId } })
  })

  it("input overrides on retry invalidate the affected steps (and only those)", async () => {
    const wf = makeFiveStepWorkflow()
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(path, wf.manifest, "utf8")

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
    })

    const original = await runner.startFromFile({ path, input: { n: 1 } })
    const failed = await waitTerminal(runner, original.runId)
    expect(failed?.status).toBe("failed")
    expect(wf.steps.fetch.calls()).toBe(1)
    expect(wf.steps.parse.calls()).toBe(1)

    // A different `n` changes fetch's resolved input directly, and parse's
    // transitively (it reads fetch's now-different output) — both must miss
    // the journal and re-dispatch, even though both already succeeded once.
    const result = await runner.retry(original.runId, { input: { n: 100 } })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")

    const retried = await waitTerminal(runner, result.run.runId)
    expect(retried?.status).toBe("done")
    expect(retried?.output).toEqual({ n: 105 }) // 100 -> 101 -> 102 -> 103 -> 104 -> 105

    expect(wf.steps.fetch.calls()).toBe(2) // re-dispatched under the new input
    expect(wf.steps.parse.calls()).toBe(2) // re-dispatched (transitively affected)
    expect(wf.steps.draft.calls()).toBe(2) // never cached either way (failed originally)
    expect(wf.steps.polish.calls()).toBe(1)
    expect(wf.steps.save.calls()).toBe(1)

    const byLabel = new Map(retried!.stages[0]!.steps.map(s => [s.label, s]))
    expect(byLabel.get("fetch")?.cached).toBeUndefined()
    expect(byLabel.get("parse")?.cached).toBeUndefined()
  })

  it("a run started WITH an explicit cacheKey is still fully retryable — the caller's own cache and the internal journal coexist", async () => {
    vi.stubEnv("HOME", tmpDir) // createFileStepCache's default dir (the caller's OWN cacheKey cache) is under homedir()
    try {
      // fetch/parse declared cacheable — required for the caller's OWN
      // cacheKey feature to journal them at all (unchanged pre-P5
      // semantics: a step not marked cacheable never writes anywhere,
      // cacheKey or not).
      const wf = makeFiveStepWorkflow(["fetch", "parse"])
      const path = join(tmpDir, "WORKFLOW.md")
      writeFileSync(path, wf.manifest, "utf8")

      const runner = createWorkflowRunner({
        registry: makeMockRegistry(),
        sessionEvents: createSessionEventBus(),
        resolveAgentAdapter: makeMockAdapter(),
        persist: true,
        persistPath,
        runsRoot,
        compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
      })

      const original = await runner.startFromFile({ path, input: { n: 1 }, cacheKey: "my-explicit-cache-key" })
      const failed = await waitTerminal(runner, original.runId)
      expect(failed?.status).toBe("failed")
      expect(wf.steps.fetch.calls()).toBe(1)
      expect(wf.steps.parse.calls()).toBe(1)
      expect(wf.steps.draft.calls()).toBe(1)

      // Retry never takes a cacheKey argument — it must find fetch/parse's
      // already-succeeded output via the internal journal alone, without
      // ever being told "my-explicit-cache-key".
      const result = await runner.retry(original.runId)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")

      const retried = await waitTerminal(runner, result.run.runId)
      expect(retried?.status).toBe("done")
      expect(retried?.output).toEqual({ n: 6 }) // 1 -> 2 -> 3 -> 4 -> 5 -> 6

      // Steps 1-2 replayed from the journal — no re-dispatch — exactly as
      // when the original run never passed a cacheKey at all.
      expect(wf.steps.fetch.calls()).toBe(1)
      expect(wf.steps.parse.calls()).toBe(1)
      // Step 3 onward re-executed for real.
      expect(wf.steps.draft.calls()).toBe(2)
      expect(wf.steps.polish.calls()).toBe(1)
      expect(wf.steps.save.calls()).toBe(1)

      const byLabel = new Map(retried!.stages[0]!.steps.map(s => [s.label, s]))
      expect(byLabel.get("fetch")).toMatchObject({ status: "done", cached: true })
      expect(byLabel.get("parse")).toMatchObject({ status: "done", cached: true })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("retry of a succeeded run is refused", async () => {
    const inc = makeIncTool("demo.only")
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: One step
id: one-step
description: A single always-succeeding step.
version: 0.1.0
inputs:
  type: object
  properties:
    n: { type: number }
outputs: {}
steps:
  - id: only
    kind: tool
    tool: demo.only
    inputs:
      n: $input.n
---
`,
      "utf8",
    )
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: { "demo.only": inc.tool }, candidates: [inc.driver] }),
    })
    const run = await runner.startFromFile({ path, input: { n: 1 } })
    const done = await waitTerminal(runner, run.runId)
    expect(done?.status).toBe("done")

    const result = await runner.retry(run.runId)
    expect(result).toEqual({
      ok: false,
      error: "not_retryable",
      message: expect.stringContaining("succeeded"),
    })
  })

  it("retry of an unknown runId is refused", async () => {
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
    })
    const result = await runner.retry("wfrun_does-not-exist")
    expect(result).toEqual({
      ok: false,
      error: "run_not_found",
      message: expect.stringContaining("wfrun_does-not-exist"),
    })
  })

  it("retry of a cancelled run is allowed", async () => {
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
    })
    // An agent step whose session never signals turn-end stays running until cancelled.
    const run = await runner.start({
      workflowId: "wf",
      stages: [{ steps: [{ label: "wait", adapter: "mock", prompt: "go" }] }],
    })
    runner.cancel(run.runId)
    expect(runner.status(run.runId)?.status).toBe("cancelled")

    const result = await runner.retry(run.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.run.retryOf).toBe(run.runId)
    expect(result.run.status).toBe("running")
    runner.cancel(result.run.runId)
  })

  it("a step interrupted by cancel is genuinely re-executed on retry, not replayed from the journal as if it had succeeded", async () => {
    // The internal journal (P5) only ever writes a step's output AFTER it
    // resolves — a step killed mid-flight by `cancel()` throws instead, so
    // nothing is ever written for it. This is the regression the underlying
    // fix (`run-workflow.ts`'s cancel handling + `SessionsRegistryAgentHost`
    // actually killing the in-flight session) exists to guarantee: without
    // it, retry would either hang on the same never-finishing step or —
    // worse — silently treat a partial run as fully cached.
    const descriptors = new Map<string, SessionDescriptor>()
    const bus = createSessionEventBus()
    const registry = makeMockRegistry({
      spawnAgent: (input: { cwd: string }) => {
        const id = `sess_${descriptors.size}`
        const desc = {
          id,
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd,
        }
        descriptors.set(id, desc)
        return desc
      },
      // Never turn-ends on its own — only a `kill()` (via cancel) settles it.
      sendPrompt: async () => {},
      get: (id: string) => descriptors.get(id),
      kill: (id: string) => {
        const desc = descriptors.get(id)
        if (!desc || desc.status === "killed") return false
        desc.status = "killed"
        bus.emit({ type: "session:exited", sessionId: id, status: "killed", ts: new Date().toISOString() })
        return true
      },
      archiveSession: (id: string) => {
        const desc = descriptors.get(id)!
        desc.archived = true
        return desc
      },
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
    })

    const run = await runner.start({
      workflowId: "cancel-then-retry",
      stages: [{ steps: [{ label: "step1", adapter: "mock", prompt: "go" }] }],
    })

    // Let the step actually spawn (genuinely in flight) before cancelling.
    for (let i = 0; i < 100 && descriptors.size === 0; i++) await new Promise(res => setTimeout(res, 0))
    expect(descriptors.size).toBe(1)

    runner.cancel(run.runId)
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final?.stages[0]?.steps[0]?.status === "running"; i++) {
      await new Promise(res => setTimeout(res, 5))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("cancelled")
    // The interrupted step is `cancelled`, never a fabricated `done` —
    // otherwise retry would see it as already-succeeded and skip it.
    expect(final?.stages[0]?.steps[0]?.status).toBe("cancelled")
    expect(descriptors.get("sess_0")?.status).toBe("killed")

    const result = await runner.retry(run.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")

    // A genuine re-execution spawns a SECOND, brand-new session — it is NOT
    // replayed from the journal (which would spawn zero new sessions and
    // mark the step `cached: true`).
    for (let i = 0; i < 100 && descriptors.size < 2; i++) await new Promise(res => setTimeout(res, 0))
    expect(descriptors.size).toBe(2)

    let retried = runner.status(result.run.runId)
    for (let i = 0; i < 100 && retried?.stages[0]?.steps[0]?.status !== "running"; i++) {
      await new Promise(res => setTimeout(res, 5))
      retried = runner.status(result.run.runId)
    }
    expect(retried?.stages[0]?.steps[0]?.cached).toBeUndefined()
    expect(retried?.stages[0]?.steps[0]?.sessionId).toBe("sess_1")

    runner.cancel(result.run.runId)
  })

  it("a run whose lease expired (orphaned — V6) is reported failed and is retryable", async () => {
    let clock = new Date("2026-09-25T10:00:00.000Z")
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      ownerId: "worker-7",
      leaseTtlMs: 30_000,
      now: () => clock,
    })
    // Never signals turn-end — stays "running" until swept.
    const run = await runner.start({
      workflowId: "youtube-transcriber",
      stages: [{ steps: [{ label: "transcribe", adapter: "mock", prompt: "go" }] }],
    })
    expect(runner.status(run.runId)?.status).toBe("running")

    clock = new Date(clock.getTime() + 31_000)
    const { orphaned } = runner.sweep()
    expect(orphaned).toEqual([run.runId])
    const swept = runner.status(run.runId)
    expect(swept?.status).toBe("failed")
    expect(swept?.errorCode).toBe("orphaned")

    // Not stuck "running" forever — a fresh retry starts cleanly.
    const result = await runner.retry(run.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.run.status).toBe("running")
    runner.cancel(result.run.runId)
  })

  it("survives a daemon restart: retry works from a FRESH runner instance reloading the same persisted state", async () => {
    const wf = makeFiveStepWorkflow()
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(path, wf.manifest, "utf8")

    const runnerA = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
    })
    const original = await runnerA.startFromFile({ path, input: { n: 1 } })
    const failed = await waitTerminal(runnerA, original.runId)
    expect(failed?.status).toBe("failed")
    expect(wf.steps.fetch.calls()).toBe(1)
    expect(wf.steps.parse.calls()).toBe(1)

    // A fresh runner over the SAME persistPath/runsRoot IS a daemon restart
    // (`loadRuns`) — the original run's record (and its journal file under
    // runsRoot) survive on disk, independent of this process.
    const runnerB = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
    })
    // Still failed — reload doesn't touch an already-terminal run.
    expect(runnerB.status(original.runId)?.status).toBe("failed")

    const result = await runnerB.retry(original.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    const retried = await waitTerminal(runnerB, result.run.runId)
    expect(retried?.status).toBe("done")
    expect(retried?.output).toEqual({ n: 6 })
    // fetch/parse replayed from the journal written by runnerA — not re-dispatched.
    expect(wf.steps.fetch.calls()).toBe(1)
    expect(wf.steps.parse.calls()).toBe(1)
  })

  it("retry() never throws when the original WORKFLOW.md source can no longer be reloaded — refuses not_retryable instead", async () => {
    const wf = makeFiveStepWorkflow()
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(path, wf.manifest, "utf8")

    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: wf.tools, candidates: wf.candidates }),
    })

    const original = await runner.startFromFile({ path, input: { n: 1 } })
    const failed = await waitTerminal(runner, original.runId)
    expect(failed?.status).toBe("failed")

    // The source file is gone by the time someone calls retry() — a moved/
    // deleted WORKFLOW.md, or one edited into something that no longer
    // compiles.
    rmSync(path, { force: true })

    const result = await runner.retry(original.runId)
    expect(result).toEqual({
      ok: false,
      error: "not_retryable",
      message: expect.stringContaining(original.runId),
    })
  })

  it("V7 shape — original run's steps 1-2 succeeded, retry (auto-detected resume point) reuses them and re-executes from step 3", async () => {
    // Mirrors v7-replay.json's own topology (fetch/parse/draft/save, steps
    // 1-2 already succeeded) adapted to THIS runtime's narrower `run.retry`
    // (a failed/cancelled source, auto-detected resume point) rather than
    // the vector's general `run.replay { of, fromStep }` — see this file's
    // module doc comment.
    const vector = JSON.parse(readFileSync(join(VECTORS_DIR, "v7-replay.json"), "utf8")) as {
      originalRun: { steps: { stepId: string; status: string }[] }
    }
    expect(vector.originalRun.steps.map(s => s.stepId)).toEqual(["fetch", "parse", "draft", "save"])

    const fetch = makeIncTool("demo.v7fetch")
    const parse = makeIncTool("demo.v7parse")
    const draft = makeFlakyIncTool("demo.v7draft")
    const save = makeIncTool("demo.v7save")
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: V7 shape
id: v7-shape
description: fetch -> parse -> draft(flaky) -> save.
version: 0.1.0
inputs:
  type: object
  properties:
    n: { type: number }
outputs: {}
steps:
  - id: fetch
    kind: tool
    tool: demo.v7fetch
    inputs:
      n: $input.n
  - id: parse
    kind: tool
    tool: demo.v7parse
    inputs:
      n: $steps.fetch.n
  - id: draft
    kind: tool
    tool: demo.v7draft
    inputs:
      n: $steps.parse.n
  - id: save
    kind: tool
    tool: demo.v7save
    inputs:
      n: $steps.draft.n
---
`,
      "utf8",
    )
    const tools = { "demo.v7fetch": fetch.tool, "demo.v7parse": parse.tool, "demo.v7draft": draft.tool, "demo.v7save": save.tool }
    const candidates = [fetch.driver, parse.driver, draft.driver, save.driver]
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools, candidates }),
    })

    // Assert against the real, host-generated runId throughout — not the
    // vector's literal fixture id ("run_orig"), which isn't part of the
    // public API.
    const original = await runner.startFromFile({ path, input: { n: 1 } })
    const failed = await waitTerminal(runner, original.runId)
    expect(failed?.status).toBe("failed")
    const byLabel = new Map(failed!.stages[0]!.steps.map(s => [s.label, s]))
    expect(byLabel.get("fetch")?.status).toBe("done")
    expect(byLabel.get("parse")?.status).toBe("done")
    expect(byLabel.get("draft")?.status).toBe("failed")
    expect(byLabel.get("save")?.status).toBe("pending") // listed up front (static), never started

    const result = await runner.retry(original.runId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    const replay = await waitTerminal(runner, result.run.runId)
    expect(replay?.status).toBe("done")
    // fetch/parse: "reused from journal", no re-execution (matches the
    // vector's own notes[] — copied forward, not re-run).
    expect(fetch.calls()).toBe(1)
    expect(parse.calls()).toBe(1)
    // draft onward: "re-executes fresh".
    expect(draft.calls()).toBe(2)
    expect(save.calls()).toBe(1)
    // run_orig is untouched — still its own terminal status, still immutable.
    expect(runner.status(original.runId)?.status).toBe("failed")
    expect(result.run.runId).not.toBe(original.runId)
  })

  it("persist throttle: a status change is on disk at once, even inside the coalescing window", async () => {
    const runner = createWorkflowRunner({
      registry: makeMockRegistry(),
      sessionEvents: createSessionEventBus(),
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      persistMinIntervalMs: 60_000,
    })
    const run = await runner.start({
      workflowId: "youtube-transcriber",
      stages: [{ steps: [{ label: "transcribe", adapter: "mock", prompt: "go" }] }],
    })
    const onDisk = (): WorkflowRun | undefined =>
      (JSON.parse(readFileSync(persistPath, "utf8")) as WorkflowRun[]).find(r => r.runId === run.runId)
    expect(onDisk()?.status).toBe("running")
    runner.cancel(run.runId)
    expect(onDisk()?.status).toBe("cancelled")
  })

})
