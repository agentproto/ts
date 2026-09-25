/**
 * AIP-58 (RUN) conformance harness — P1 slice.
 *
 * Loads every vendored vector from `specs/resources/aip-58/draft/vectors/`
 * (mirrored by `scripts/sync-specs.mjs`) and registers one `describe` per
 * vector, so the full V1-V8 set is always visible in the test tree even
 * though this PR only makes V1 green.
 *
 * V2-V8 need pieces of the AIP-58 Run resource this runtime doesn't ship
 * yet — an explicit `run.requestInput` signal, a `suspended` run status, a
 * `Run.artifacts[]` / `missing-artifact` check, a generalized host-restart
 * rule, owner-lease liveness, `run.replay`, and a hint-vs-suspend outcome
 * distinction (see `.plans/agent-apps-dogfood/IMPL-aip58.md`, P2-P5). They
 * stay `it.todo` with a one-line reason each so a later PR flips them
 * without re-discovering which vectors exist or what they need.
 *
 * V1 (input validation) is this PR's actual scope: it drives the same
 * validate-before-dispatch seam `runtime/workflow-runner.ts`'s
 * `startFromFile` uses (`validateWorkflowInput`), against a fake tool
 * registry, and asserts zero steps run on a rejected input.
 */

import { describe, expect, it, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { z } from "zod"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineTool } from "@agentproto/tool"
import { runWorkflow, validateWorkflowInput, type RuntimeWorkflow } from "../index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Same resolution corpus/conformance.test.ts uses for `<repo>/specs/resources`.
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

/** One-line reason each not-yet-green vector is `it.todo` in this PR. */
const NOT_YET_GREEN: Record<string, string> = {
  V2: "needs the explicit run.requestInput signal + a `suspended` run status — this runtime has no such seam (P2 Outcome rule / event log).",
  V3: "needs Run.artifacts[] + the missing-artifact check on a required outputsFiles key — not implemented (P2/P4 Run workspace).",
  V4: "needs the generalized host-restart rule across every run kind — workflow-runner.ts only covers its own approval/suspend steps today (P2 State machine).",
  V5: "needs the deferred-publish model (run-scoped artifacts/<key> + explicit run.publish) — outputsFiles still syncs straight to its declared path today (P4 Run workspace).",
  V6: "needs an owner lease/heartbeat liveness check — only host-restart is detected today, not an owner dying independently (P2 State machine).",
  V7: "needs run.replay + journal-sourced step reuse — StepCache exists but has no replay verb (P3 Journal).",
  V8: "needs the hint-vs-suspend outcome distinction — no structured outcome-signal seam exists on this runtime yet (P2 Outcome rule).",
}

describe("AIP-58 conformance vectors", () => {
  it("registers all 8 vectors named in specs/aip-58.mdx", () => {
    expect(vectors.map((v) => v.id).sort()).toEqual(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"])
  })

  for (const vector of vectors) {
    describe(`${vector.id}: ${vector.title}`, () => {
      if (vector.id !== "V1") {
        it.todo(`${vector.id}: ${vector.title} — ${NOT_YET_GREEN[vector.id]}`)
        return
      }

      // ── V1 — required input missing → rejected before any step runs ──

      it("rejects a run whose input fails the declared schema, naming the missing field", () => {
        const manifestExcerpt = vector["manifestExcerpt"] as { inputs: unknown }
        const runCreate = vector["runCreate"] as { input: unknown }

        const validation = validateWorkflowInput(manifestExcerpt.inputs, runCreate.input)

        expect(validation.valid).toBe(false)
        if (validation.valid) throw new Error("unreachable — asserted false above")
        expect(validation.code).toBe("invalid-input")
        expect(validation.fields).toEqual(["productUrl"])
        expect(validation.message).toContain("productUrl")
      })

      it("dispatches zero steps and spawns zero sessions on the rejected input", async () => {
        const manifestExcerpt = vector["manifestExcerpt"] as { inputs: unknown; steps: { id: string; tool: string }[] }
        const runCreate = vector["runCreate"] as { input: unknown }
        const expected = vector["expected"] as { terminalState: string; error: { code: string }; stepsExecuted: unknown[] }

        // Fake tool registry (per the harness contract) — a "pricing-snapshot"
        // tool whose implementation is a spy, so a call would be observable.
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
        const onStepStart = vi.fn()

        // This mirrors the production seam exactly: `runtime/workflow-
        // runner.ts`'s `startFromFile` validates BEFORE calling
        // `compileWorkflow`/dispatching a run — never after.
        const validation = validateWorkflowInput(manifestExcerpt.inputs, runCreate.input)
        let dispatched = false
        if (validation.valid) {
          dispatched = true
          const workflow: RuntimeWorkflow = {
            id: "pricing-brief",
            steps: [{ kind: "tool", id: "fetch", tool, candidates: [driver], input: () => ({}) }],
          }
          await runWorkflow({ workflow, input: runCreate.input, onStepStart })
        }

        // §Outcome rule / §10: failed { code: "invalid-input" }, zero steps
        // dispatched, zero sessions spawned. This runtime has no run-level
        // event log yet (that's P2), so `expected.events` isn't asserted —
        // only the terminal outcome + dispatch count it can already express.
        expect(dispatched).toBe(false)
        expect(onStepStart).not.toHaveBeenCalled()
        expect(impl).not.toHaveBeenCalled()
        expect(expected.terminalState).toBe("failed")
        expect(expected.error.code).toBe("invalid-input")
        expect(expected.stepsExecuted).toEqual([])
      })
    })
  }
})
