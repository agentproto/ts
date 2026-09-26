import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import {
  compileReview,
  parseReviewManifest,
  ReviewCompileError,
  toLaneResult,
  type LaneInvocation,
  type LaneOutcome,
  type ReviewLaneExecutor,
  type ReviewOutcome,
  type ReviewTarget,
} from "../index.js"

const EXAMPLE = readFileSync(new URL("../../examples/REVIEW.md", import.meta.url), "utf8")
const TARGET: ReviewTarget = { repoRemote: "github.com/acme/repo", baseSha: "b".repeat(40), headSha: "h".repeat(40) }

const md = (...lines: string[]) => ["---", "kind: review", "id: demo", "target: git-range", ...lines, "---", ""].join("\n")

/** A fake executor: records invocations, answers from a per-lane table. */
function fakeExecutor(answers: Record<string, LaneOutcome | (() => Promise<LaneOutcome>)>) {
  const calls: LaneInvocation[] = []
  const executor: ReviewLaneExecutor = {
    async runLane(lane) {
      calls.push(lane)
      const a = answers[lane.check.id]
      if (a === undefined) throw new Error(`no fake answer for '${lane.check.id}'`)
      return typeof a === "function" ? a() : a
    },
  }
  return { executor, calls }
}

async function run(compiled: ReturnType<typeof compileReview>, cwd?: string): Promise<ReviewOutcome> {
  const workflow = compileWorkflow(compiled.workflow, { tools: {}, candidates: [] })
  const result = await runWorkflow({ workflow, ...(cwd ? { cwd } : {}) })
  return result.output as ReviewOutcome
}

describe("compileReview — workflow shape", () => {
  it("compiles the local binding to prepare → freeze → parallel lanes → verdict", () => {
    const { executor } = fakeExecutor({})
    const compiled = compileReview(parseReviewManifest(EXAMPLE), {
      binding: "local",
      vars: { changed: "...[origin/main]" },
      freeze: async () => TARGET,
      executor,
    })
    const steps = compiled.workflow.steps as unknown as Array<Record<string, unknown>>
    expect(steps.map((s) => [s.id, s.kind])).toEqual([
      ["prepare-changeset", "gate"],
      ["freeze", "transform"],
      ["lanes", "parallel"],
      ["verdict", "transform"],
    ])
    expect(steps[0]).toMatchObject({ command: "sh", args: ["-c", "pnpm changeset:auto"], timeout_ms: 600_000 })
    const branches = steps[2]!.branches as Array<{ id: string; steps: Array<{ id: string; kind: string }> }>
    expect(branches.map((b) => b.id)).toEqual(["types", "correctness"])
    expect(branches[0]!.steps).toMatchObject([{ id: "lane-types", kind: "transform" }])
    expect(compiled.workflow.id).toBe("review-agentproto-ts-local")
    expect(compiled.workflow.result).toBe("$steps.verdict")
    expect(compiled.prepare.map((c) => c.id)).toEqual(["changeset"])
    expect(compiled.lanes.map((c) => c.id)).toEqual(["types", "correctness"])
  })

  it("compiles the ci binding with no prepare steps", () => {
    const { executor } = fakeExecutor({})
    const compiled = compileReview(parseReviewManifest(EXAMPLE), {
      binding: "ci",
      vars: { changed: "x" },
      freeze: async () => TARGET,
      executor,
    })
    const steps = compiled.workflow.steps as unknown as Array<{ id: string }>
    expect(steps.map((s) => s.id)).toEqual(["freeze", "lanes", "verdict"])
  })

  it("rejects an unbound placeholder at compile time", () => {
    const { executor } = fakeExecutor({})
    expect(() =>
      compileReview(parseReviewManifest(EXAMPLE), { binding: "ci", freeze: async () => TARGET, executor }),
    ).toThrow(/check 'build' uses placeholder \{changed\}, which is not bound — bound: \{base\}, \{head\}/)
  })

  it("rejects {head} in a prepare step — the range isn't frozen yet", () => {
    const m = parseReviewManifest(
      md(
        "checks:",
        "  - {id: stamp, kind: command, run: 'echo {head}', effects: true}",
        "  - {id: types, kind: command, run: tsc}",
        "bindings:",
        "  local: {prepare: [stamp], checks: [types]}",
      ),
    )
    const { executor } = fakeExecutor({})
    expect(() => compileReview(m, { freeze: async () => TARGET, executor })).toThrow(ReviewCompileError)
    expect(() => compileReview(m, { freeze: async () => TARGET, executor })).toThrow(
      /prepare check 'stamp' uses \{head\}, which is not bound yet/,
    )
  })
})

describe("compileReview — executed by the workflow runtime", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-review-compile-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("runs lanes in parallel and folds a pass verdict", async () => {
    let inFlight = 0
    let peak = 0
    const slow = (outcome: LaneOutcome) => async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return outcome
    }
    const { executor, calls } = fakeExecutor({
      build: slow({ outcome: "exited", exitCode: 0 }),
      correctness: slow({
        outcome: "reported",
        report: { findings: [{ severity: "medium", title: "nit", detail: "" }] },
        sessionId: "s-1",
        preset: "kimi",
      }),
    })
    const out = await run(
      compileReview(parseReviewManifest(EXAMPLE), {
        binding: "ci",
        vars: { changed: "...[bbb]" },
        freeze: async () => TARGET,
        executor,
      }),
    )
    expect(peak).toBe(2)
    expect(out.verdict).toBe("pass")
    expect(out.target).toEqual(TARGET)
    expect(out.lanes.map((l) => [l.id, l.status])).toEqual([
      ["build", "pass"],
      ["correctness", "pass"],
    ])
    expect(out.lanes[1]).toMatchObject({ sessionId: "s-1", preset: "kimi", findings: [{ severity: "medium" }] })
    // Placeholders substituted against the frozen range + host vars.
    expect(calls.find((c) => c.check.id === "build")).toMatchObject({
      kind: "command",
      command: "turbo run build --filter=...[bbb]",
    })
  })

  it("a failing lane doesn't abort its siblings; the verdict blocks", async () => {
    const { executor } = fakeExecutor({
      build: { outcome: "exited", exitCode: 2, output: "error TS2322" },
      correctness: { outcome: "reported", report: { findings: [] } },
    })
    const out = await run(
      compileReview(parseReviewManifest(EXAMPLE), {
        binding: "ci",
        vars: { changed: "x" },
        freeze: async () => TARGET,
        executor,
      }),
    )
    expect(out.verdict).toBe("block")
    expect(out.lanes[0]).toMatchObject({
      status: "fail",
      exitCode: 2,
      findings: [{ severity: "high", title: "'build' exited with code 2", detail: "error TS2322" }],
    })
    expect(out.lanes[1]!.status).toBe("pass")
  })

  it("an executor that throws makes its lane skipped → incomplete, never pass", async () => {
    const { executor } = fakeExecutor({
      build: { outcome: "exited", exitCode: 0 },
      correctness: async () => {
        throw new Error("preset 'kimi' not found")
      },
    })
    const out = await run(
      compileReview(parseReviewManifest(EXAMPLE), {
        binding: "ci",
        vars: { changed: "x" },
        freeze: async () => TARGET,
        executor,
      }),
    )
    expect(out.verdict).toBe("incomplete")
    expect(out.lanes[1]).toMatchObject({ status: "skipped", error: "preset 'kimi' not found" })
  })

  it("an agent finding at blockOn blocks; a timeout alone is incomplete", async () => {
    const blocked = await run(
      compileReview(parseReviewManifest(EXAMPLE), {
        binding: "ci",
        vars: { changed: "x" },
        freeze: async () => TARGET,
        executor: fakeExecutor({
          build: { outcome: "exited", exitCode: 0 },
          correctness: { outcome: "reported", report: { findings: [{ severity: "high", title: "bug", detail: "d" }] } },
        }).executor,
      }),
    )
    expect(blocked.verdict).toBe("block")

    const timedOut = await run(
      compileReview(parseReviewManifest(EXAMPLE), {
        binding: "ci",
        vars: { changed: "x" },
        freeze: async () => TARGET,
        executor: fakeExecutor({
          build: { outcome: "exited", exitCode: 0 },
          correctness: { outcome: "timeout", error: "reviewer exceeded 900000ms", sessionId: "s-9" },
        }).executor,
      }),
    )
    expect(timedOut.verdict).toBe("incomplete")
    expect(timedOut.lanes[1]).toMatchObject({ status: "timeout", sessionId: "s-9" })
  })

  it("runs prepare through the engine's gate BEFORE freezing the range", async () => {
    const m = parseReviewManifest(
      md(
        "checks:",
        "  - {id: stamp, kind: command, run: 'printf {base} > prepared.txt', effects: true}",
        "  - {id: types, kind: command, run: tsc}",
        "bindings:",
        "  local: {prepare: [stamp], checks: [types]}",
      ),
    )
    let seenAtFreeze: string | undefined
    const out = await run(
      compileReview(m, {
        vars: { base: "base-sha" },
        freeze: async () => {
          seenAtFreeze = await readFile(join(dir, "prepared.txt"), "utf8")
          return TARGET
        },
        executor: fakeExecutor({ types: { outcome: "exited", exitCode: 0 } }).executor,
      }),
      dir,
    )
    expect(seenAtFreeze).toBe("base-sha")
    expect(out.verdict).toBe("pass")
  })

  it("a failing prepare step fails the run before any lane starts", async () => {
    const m = parseReviewManifest(
      md(
        "checks:",
        "  - {id: stamp, kind: command, run: 'exit 3', effects: true}",
        "  - {id: types, kind: command, run: tsc}",
        "bindings:",
        "  local: {prepare: [stamp], checks: [types]}",
      ),
    )
    const { executor, calls } = fakeExecutor({ types: { outcome: "exited", exitCode: 0 } })
    let froze = false
    const compiled = compileReview(m, {
      freeze: async () => {
        froze = true
        return TARGET
      },
      executor,
    })
    await expect(run(compiled, dir)).rejects.toThrow(/prepare-stamp.*exit code 3/)
    expect(froze).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("a cancelled review skips lanes that haven't started", async () => {
    const ac = new AbortController()
    ac.abort()
    const { executor, calls } = fakeExecutor({ types: { outcome: "exited", exitCode: 0 } })
    const m = parseReviewManifest(md("checks:", "  - {id: types, kind: command, run: tsc}"))
    const out = await run(compileReview(m, { freeze: async () => TARGET, executor, signal: ac.signal }))
    expect(calls).toHaveLength(0)
    expect(out.verdict).toBe("incomplete")
    expect(out.lanes[0]).toMatchObject({ status: "skipped", error: "review cancelled before this lane started" })
  })

  it("reports each lane as it settles", async () => {
    const settled: string[] = []
    const m = parseReviewManifest(md("checks:", "  - {id: types, kind: command, run: tsc}"))
    await run(
      compileReview(m, {
        freeze: async () => TARGET,
        executor: fakeExecutor({ types: { outcome: "exited", exitCode: 0 } }).executor,
        onLaneSettled: (l) => settled.push(`${l.id}:${l.status}`),
      }),
    )
    expect(settled).toEqual(["types:pass"])
  })
})

describe("toLaneResult", () => {
  const m = parseReviewManifest(EXAMPLE)
  const build = m.checks.find((c) => c.id === "build")!
  const correctness = m.checks.find((c) => c.id === "correctness")!

  it("keeps only the tail of a long command output", () => {
    const r = toLaneResult(build, { outcome: "exited", exitCode: 1, output: "x".repeat(10_000) + "END" }, 5)
    expect(r.findings[0]!.detail.endsWith("END")).toBe(true)
    expect(r.findings[0]!.detail.length).toBeLessThan(5_000)
  })

  it("never lets an outcome of the wrong kind pass", () => {
    expect(toLaneResult(build, { outcome: "reported", report: { findings: [] } }, 1).status).toBe("skipped")
    expect(toLaneResult(correctness, { outcome: "exited", exitCode: 0 }, 1).status).toBe("skipped")
  })

  it("carries the reviewer summary", () => {
    const r = toLaneResult(correctness, { outcome: "reported", report: { summary: "lgtm", findings: [] } }, 1)
    expect(r).toMatchObject({ status: "pass", summary: "lgtm", blocking: true, kind: "agent" })
  })
})
