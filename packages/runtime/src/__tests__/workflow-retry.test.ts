/**
 * AIP-58 §6 Journal — `run.retry` (P5). Host-level tests for
 * `WorkflowRunner.retry()` / the `workflow_retry` MCP tool: given a
 * failed/cancelled runId, a NEW run replays every step the original already
 * completed from its own journal (no re-execution) and re-executes only from
 * the first step that never succeeded — working even when the original run
 * never passed a `cacheKey` (the internal, always-on per-run journal — see
 * `internalJournal` in `workflow-runner.ts` — is the source, not the
 * caller-facing `cacheKey` feature).
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

import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
 *  `$input.n` directly — everything downstream depends on it transitively. */
function makeFiveStepWorkflow() {
  const fetch = makeIncTool("demo.fetch")
  const parse = makeIncTool("demo.parse")
  const draft = makeFlakyIncTool("demo.draft")
  const polish = makeIncTool("demo.polish")
  const save = makeIncTool("demo.save")
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
      n: $input.n
  - id: parse
    kind: tool
    tool: demo.parse
    inputs:
      n: $steps.fetch.n
  - id: draft
    kind: tool
    tool: demo.draft
    inputs:
      n: $steps.parse.n
  - id: polish
    kind: tool
    tool: demo.polish
    inputs:
      n: $steps.draft.n
  - id: save
    kind: tool
    tool: demo.save
    inputs:
      n: $steps.polish.n
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

    const origRun = "run_orig"
    const original = await runner.startFromFile({ path, input: { n: 1 } })
    // Rename isn't part of the public API — assert against the real runId
    // instead of the vector's literal fixture id (host-generated, not
    // caller-supplied).
    void origRun
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
})
