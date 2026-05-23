/**
 * PlaybookEvaluator: shadow vs baseline eval batches.
 */

import { describe, expect, it } from "vitest"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import { PlaybookRegistry } from "../playbooks/registry.js"
import { PlaybookEvaluator, type EvalCase } from "../playbooks/evaluator.js"
import type {
  EvalInputPort,
  EvalResultPort,
  EvalRubricPort,
  EvaluatorPort,
} from "../ports/evaluator.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { loadM0FixtureFs, MemoryFs } from "./_helpers/memory-fs.js"

const fixedClock: ClockPort = {
  now: () => new Date("2026-05-22T15:00:00.000Z"),
  nowMs: () => Date.parse("2026-05-22T15:00:00.000Z"),
}
const stubIdentity: IdentityPort = {
  resolve: async () => ({
    principal: "ws://operators/playbook-evaluator",
    identityTree: ["ws://operators/playbook-evaluator"],
  }),
}

/**
 * Stub evaluator that scores deterministically based on response
 * length — keeps tests reproducible without needing a real LLM.
 * Shadow responses get LENGTH_AS_QUALITY_BOOST × extra to model
 * a "playbook makes responses slightly better".
 */
function makeStubEvaluator(): EvaluatorPort {
  return {
    async evaluate(input: EvalInputPort): Promise<EvalResultPort> {
      // Score = response length normalized to 0..1 with cap at 200.
      const score = Math.min(input.response.length / 200, 1)
      const dims: Record<string, number> = {}
      for (const d of input.rubric.dimensions) dims[d.id] = score
      return {
        score,
        dimensions: dims,
        evaluatorEngineId: "stub",
        evaluatorVersion: "1.0.0",
        evaluatedAt: new Date(0).toISOString(),
      }
    },
  }
}

const RUBRIC: EvalRubricPort = Object.freeze({
  slug: "test-rubric",
  title: "Test",
  version: "1.0.0",
  scoringScale: "0..1",
  passingThreshold: 0.6,
  dimensions: Object.freeze([
    { id: "overall", weight: 1.0, description: "Overall quality" },
  ]),
})

describe("PlaybookEvaluator.runBatch (M9)", () => {
  it("computes winRateVsBaseline + records shadowMetrics on the playbook file", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })

    const cases: EvalCase[] = [
      // Each shadow response is longer → higher stub score → shadow wins.
      { prompt: "p1", shadowResponse: "x".repeat(150), baselineResponse: "x".repeat(100) },
      { prompt: "p2", shadowResponse: "x".repeat(180), baselineResponse: "x".repeat(120) },
      { prompt: "p3", shadowResponse: "x".repeat(90), baselineResponse: "x".repeat(80) },
      // Tie — neither wins.
      { prompt: "p4", shadowResponse: "x".repeat(100), baselineResponse: "x".repeat(100) },
      // Baseline wins on this one.
      { prompt: "p5", shadowResponse: "x".repeat(80), baselineResponse: "x".repeat(160) },
    ]

    const r = await evaluator.runBatch("landing-page-copy", {
      rubric: RUBRIC,
      cases,
    })
    expect(r.playbookSlug).toBe("landing-page-copy")
    expect(r.sampleSize).toBe(5)
    expect(r.winRateVsBaseline).toBeCloseTo(3 / 5, 5) // 3 shadow wins
    expect(r.perCase.length).toBe(5)
    expect(r.perCase[0]!.winnerArm).toBe("shadow")
    expect(r.perCase[3]!.winnerArm).toBe("tie")
    expect(r.perCase[4]!.winnerArm).toBe("baseline")

    // shadowMetrics persisted into PLAYBOOK.md
    const reg = new PlaybookRegistry({
      snapshot: await new CorpusWorkspaceReader({ fs }).read(""),
    })
    const after = reg.bySlugOrNull("landing-page-copy")!
    const m = (after.corpus.shadowMetrics ?? {}) as {
      sampleSize?: number
      winRateVsBaseline?: number | null
      lastEvaluatedAt?: string | null
    }
    expect(m.sampleSize).toBe(5)
    expect(m.winRateVsBaseline).toBeCloseTo(0.6, 5)
    expect(m.lastEvaluatedAt).toBe("2026-05-22T15:00:00.000Z")
  })

  it("readyForActivation respects auto_promote.threshold + minSampleSize", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })

    // 5 cases (< minSampleSize=30 in M0 fixture) — even if winRate=1,
    // not ready for activation.
    const cases: EvalCase[] = []
    for (let i = 0; i < 5; i++) {
      cases.push({
        prompt: `p${i}`,
        shadowResponse: "x".repeat(200),
        baselineResponse: "x".repeat(50),
      })
    }
    const r = await evaluator.runBatch("landing-page-copy", { rubric: RUBRIC, cases })
    expect(r.winRateVsBaseline).toBe(1)
    expect(r.readyForActivation).toBe(false) // sampleSize too small
  })

  it("ties count as non-wins (playbook must strictly beat baseline)", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })

    const cases: EvalCase[] = [
      { prompt: "p", shadowResponse: "x".repeat(100), baselineResponse: "x".repeat(100) },
      { prompt: "p", shadowResponse: "x".repeat(100), baselineResponse: "x".repeat(100) },
    ]
    const r = await evaluator.runBatch("landing-page-copy", { rubric: RUBRIC, cases })
    expect(r.winRateVsBaseline).toBe(0)
    expect(r.perCase.every((c) => c.winnerArm === "tie")).toBe(true)
  })

  it("emits playbook.shadow.evaluated event to _log.md", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })
    await evaluator.runBatch("landing-page-copy", {
      rubric: RUBRIC,
      cases: [
        { prompt: "p", shadowResponse: "x".repeat(150), baselineResponse: "x".repeat(100) },
      ],
    })
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/playbook\.shadow\.evaluated/)
    expect(log).toMatch(/"slug":"landing-page-copy"/)
    expect(log).toMatch(/"sampleSize":1/)
  })

  it("throws PlaybookNotFoundError on a missing slug", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })
    await expect(
      evaluator.runBatch("ghost", { rubric: RUBRIC, cases: [] })
    ).rejects.toThrow(/no playbook found/)
  })

  it("empty cases array → winRate=0, sampleSize=0, not ready", async () => {
    const fs = await loadM0FixtureFs()
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })
    const r = await evaluator.runBatch("landing-page-copy", {
      rubric: RUBRIC,
      cases: [],
    })
    expect(r.sampleSize).toBe(0)
    expect(r.winRateVsBaseline).toBe(0)
    expect(r.readyForActivation).toBe(false)
  })

  it("recovers when _log.md doesn't pre-exist (writes the AIP-10 header)", async () => {
    // Fresh synthetic workspace with a single playbook + no log file.
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "---",
      ].join("\n"),
      "playbooks/p/PLAYBOOK.md": [
        "---",
        "schema: playbooks/v1",
        "slug: p",
        "title: P",
        "targets:",
        "  - { kind: operator, ref: x }",
        "binds_operator: x",
        "kind: overlay",
        "status: shadow",
        "lock_check: []",
        "evidence:",
        "  - { kind: run, ref: /r }",
        "---",
        "## Body",
      ].join("\n"),
    })
    const evaluator = new PlaybookEvaluator({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
      evaluator: makeStubEvaluator(),
    })
    await evaluator.runBatch("p", {
      rubric: RUBRIC,
      cases: [
        { prompt: "p", shadowResponse: "x".repeat(100), baselineResponse: "x".repeat(50) },
      ],
    })
    const log = await fs.readFile("_log.md")
    expect(log).toContain("# Corpus activity log")
    expect(log).toMatch(/playbook\.shadow\.evaluated/)
  })
})
