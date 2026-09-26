/**
 * AIP-58 (RUN) conformance harness — Mastra runner.
 *
 * Same 8 vectors `@agentproto/workflow-runtime`'s own
 * `aip58-conformance.test.ts` (P1) drives against the plain runtime, driven
 * here against `toMastraWorkflow` + the real Mastra engine instead — loaded
 * from the SAME vendored `specs/resources/aip-58/draft/vectors/` corpus
 * (`scripts/sync-specs.mjs` keeps both in sync with the spec).
 *
 * V1 is this PR's actual scope and is green: it proves the projected
 * workflow's OWN `inputSchema` (built from `manifestExcerpt.inputs` via
 * {@link toMastraWorkflow}'s `inputsSchema` option) rejects the run before
 * Mastra ever calls a step's `execute`, and {@link mapMastraInputError} maps
 * Mastra's own thrown validation error back to the same `{code:
 * "invalid-input", fields, message}` shape `validateWorkflowInput` produces.
 *
 * V2-V8 stay `it.todo`, for the SAME reasons the runtime harness gives (see
 * `NOT_YET_GREEN` there) — none of those gaps (an explicit `run.requestInput`
 * signal, `Run.artifacts[]`, a generalized host-restart rule, owner-lease
 * liveness, `run.replay`, a hint-vs-suspend outcome distinction) are
 * implemented ANYWHERE yet, in the plain runtime or here; this projector adds
 * a Mastra target for the step kinds the runtime already executes, not a new
 * Run-resource capability the runtime itself doesn't have.
 */

import { describe, expect, it, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { z } from "zod"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineTool } from "@agentproto/tool"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"
import { toMastraWorkflow, mapMastraInputError } from "../index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Same vendored corpus the runtime harness reads — kept current by
// `scripts/sync-specs.mjs`, not duplicated here.
const VECTORS_DIR = join(__dirname, "../../../../specs/resources/aip-58/draft/vectors")

interface Vector {
  id: string
  title: string
  [key: string]: unknown
}

function loadVectors(): Vector[] {
  return readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8")) as Vector)
}

const vectors = loadVectors()

/** Same gaps `aip58-conformance.test.ts`'s `NOT_YET_GREEN` names — none of
 *  this infrastructure exists in the plain runtime either, so there's nothing
 *  for this Mastra-runner harness to fake that the runtime harness doesn't
 *  already lack. */
const NOT_YET_GREEN: Record<string, string> = {
  V2: "needs the explicit run.requestInput signal + a `suspended` run status — neither the runtime nor this Mastra projector has that seam (P2 Outcome rule / event log). Unrelated to this PR's native SuspendStep/ApprovalStep → Mastra suspend/resume projection, which is a different mechanism than V2's mid-turn tool call.",
  V3: "needs Run.artifacts[] + the missing-artifact check on a required outputsFiles key — not implemented (P2/P4 Run workspace).",
  V4: "needs the generalized host-restart rule across every run kind — not implemented for the Mastra runner either (P2 State machine).",
  V5: "needs the deferred-publish model (run-scoped artifacts/<key> + explicit run.publish) — outputsFiles still syncs straight to its declared path today (P4 Run workspace).",
  V6: "needs an owner lease/heartbeat liveness check — only host-restart is detected today, not an owner dying independently (P2 State machine).",
  V7: "needs run.replay + journal-sourced step reuse — StepCache exists but has no replay verb (P3 Journal).",
  V8: "needs the hint-vs-suspend outcome distinction — no structured outcome-signal seam exists on this runtime yet (P2 Outcome rule).",
}

describe("AIP-58 conformance vectors — Mastra runner", () => {
  it("registers all 8 vectors named in specs/aip-58.mdx", () => {
    expect(vectors.map((v) => v.id).sort()).toEqual(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"])
  })

  for (const vector of vectors) {
    describe(`${vector.id}: ${vector.title}`, () => {
      if (vector.id !== "V1") {
        it.todo(`${vector.id}: ${vector.title} — ${NOT_YET_GREEN[vector.id]}`)
        return
      }

      // ── V1 — required input missing → rejected before any step runs, via toMastraWorkflow's own inputSchema ──

      it("rejects a run whose input fails the projected workflow's inputSchema, naming the missing field", async () => {
        const manifestExcerpt = vector["manifestExcerpt"] as {
          inputs: unknown
          steps: { id: string; tool: string }[]
        }
        const runCreate = vector["runCreate"] as { input: unknown }
        const expected = vector["expected"] as { terminalState: string; error: { code: string }; stepsExecuted: unknown[] }

        // Same fake tool registry the runtime harness uses — a spy body, so a
        // dispatched call would be observable.
        const impl = vi.fn(() => ({ ok: true }))
        const tool = defineTool({
          id: manifestExcerpt.steps[0]!.tool,
          description: "fake pricing snapshot tool for the conformance harness",
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
        })
        const driver = defineDriver({
          id: "fake-pricing-driver",
          name: "Fake pricing driver",
          description: "Conformance-harness stub.",
          kind: "builtin",
          implements: [{ tool: tool.id, version: "0.1.0" }],
          implementations: [implementTool(tool, impl)],
        })

        const workflow: RuntimeWorkflow = {
          id: "pricing-brief",
          steps: [{ kind: "tool", id: "fetch", tool, candidates: [driver], input: () => ({}) }],
        }
        const mastraWorkflow = toMastraWorkflow(workflow, { inputsSchema: manifestExcerpt.inputs })
        const run = await mastraWorkflow.createRun()

        let caught: unknown
        try {
          await run.start({ inputData: runCreate.input })
        } catch (err) {
          caught = err
        }
        const validation = mapMastraInputError(caught)

        // §Outcome rule / §10: failed { code: "invalid-input" }, zero steps
        // dispatched — `run.start()` REJECTS (never resolves to a
        // `{status:"success"}`/`{status:"failed"}` result) when the
        // WORKFLOW-level inputSchema itself is what fails, before Mastra
        // calls a single step's `execute`.
        expect(validation).toBeDefined()
        expect(validation?.code).toBe("invalid-input")
        expect(validation?.fields).toContain("productUrl")
        expect(impl).not.toHaveBeenCalled()
        expect(expected.terminalState).toBe("failed")
        expect(expected.error.code).toBe("invalid-input")
        expect(expected.stepsExecuted).toEqual([])
      })
    })
  }
})
