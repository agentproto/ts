/**
 * AIP-58 (RUN) conformance harness — P1 + P2 slice.
 *
 * Loads every vendored vector from `specs/resources/aip-58/draft/vectors/`
 * (mirrored by `scripts/sync-specs.mjs`) and registers one `describe` per
 * vector, so the full V1-V8 set is always visible in the test tree even
 * though P1 only made V1 green.
 *
 * V3-V7 need pieces of the AIP-58 Run resource this runtime doesn't ship
 * yet — `Run.artifacts[]` / `missing-artifact`, a generalized host-restart
 * rule, owner-lease liveness, `run.replay` (see
 * `.plans/agent-apps-dogfood/IMPL-aip58.md`, P2-P5). They stay `it.todo`
 * with a one-line reason each so a later PR flips them without
 * re-discovering which vectors exist or what they need.
 *
 * V1 (input validation, P1) drives the same validate-before-dispatch seam
 * `runtime/workflow-runner.ts`'s `startFromFile` uses (`validateWorkflowInput`),
 * against a fake tool registry, and asserts zero steps run on a rejected
 * input.
 *
 * V2 and V8 (P2 Outcome rule) drive `runWorkflow` directly against a fake
 * `AgentSessionHost` scripted from the vector's `agentTurn`: a `toolCall`
 * makes `takeInputRequest` return the signal (V2); its absence, with a
 * question-shaped final message, does not (V8). Like V1, only the pieces
 * expressible at the `runWorkflow` layer are asserted — there's no run-level
 * event log yet (that's P3), so `expected.events` isn't checked. V8's own
 * `manifestExcerpt` has no `outputSchema` (a vacuous contract always
 * succeeds per §3, which would make the vector inapplicable as written) —
 * this test adds one in the fixture adapter; the spec PR
 * (agentproto/agentproto, branch `aip58-vacuous-contract`) updates the
 * vector itself to match.
 */

import { describe, expect, it, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { z } from "zod"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineTool } from "@agentproto/tool"
import {
  compileWorkflow,
  runWorkflow,
  validateWorkflowInput,
  type AgentSessionHost,
  type RuntimeWorkflow,
} from "../index.js"

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
  V3: "needs Run.artifacts[] + the missing-artifact check on a required outputsFiles key — not implemented (P2/P4 Run workspace).",
  V4: "needs the generalized host-restart rule across every run kind — workflow-runner.ts only covers its own approval/suspend steps today (P2 State machine).",
  V5: "needs the deferred-publish model (run-scoped artifacts/<key> + explicit run.publish) — outputsFiles still syncs straight to its declared path today (P4 Run workspace).",
  V6: "needs an owner lease/heartbeat liveness check — only host-restart is detected today, not an owner dying independently (P2 State machine).",
  V7: "needs run.replay + journal-sourced step reuse — StepCache exists but has no replay verb (P3 Journal).",
}

/** Minimal fake {@link AgentSessionHost} for the V2/V8 vectors below — a
 *  single agent step spawns "sess_fake", its turn "ends" immediately, and
 *  `takeInputRequest` is scripted per-test from the vector's `agentTurn`. */
function fakeHost(overrides: Partial<AgentSessionHost>): AgentSessionHost {
  return {
    spawn: vi.fn(async () => "sess_fake"),
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined),
    ...overrides,
  }
}

describe("AIP-58 conformance vectors", () => {
  it("registers all 8 vectors named in specs/aip-58.mdx", () => {
    expect(vectors.map((v) => v.id).sort()).toEqual(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"])
  })

  for (const vector of vectors) {
    describe(`${vector.id}: ${vector.title}`, () => {
      if (vector.id !== "V1" && vector.id !== "V2" && vector.id !== "V8") {
        it.todo(`${vector.id}: ${vector.title} — ${NOT_YET_GREEN[vector.id]}`)
        return
      }

      if (vector.id === "V2") {
        // ── V2 — explicit run.requestInput signal → suspended, never a heuristic ──

        it("agent step calling run.requestInput suspends from the signal's own payload — the turn ending is not itself success", async () => {
          const agentTurn = vector["agentTurn"] as {
            toolCall: { args: { stepId: string; prompt: string; schema?: Record<string, unknown> } }
          }
          const expected = vector["expected"] as {
            terminalState: string
            stepStatus: string
            stepSuspend: { reason: string; prompt: string; schema?: unknown }
          }
          const manifestExcerpt = vector["manifestExcerpt"] as { steps: { id: string; prompt: string }[] }
          const stepId = manifestExcerpt.steps[0]!.id

          let signalled = false
          const host = fakeHost({
            takeInputRequest: vi.fn(() => {
              if (signalled) return undefined
              signalled = true
              return { prompt: agentTurn.toolCall.args.prompt, schema: agentTurn.toolCall.args.schema }
            }),
          })
          const onInputRequired = vi.fn(async (req: { stepId: string; prompt: string; schema?: unknown }) => {
            // §3: `StepRecord.suspend` comes from the signal's OWN payload.
            expect(req.stepId).toBe(stepId)
            expect(req.prompt).toBe(expected.stepSuspend.prompt)
            expect(req.schema).toEqual(expected.stepSuspend.schema)
            // Vector notes: a valid resume payload (`{ tone: "formal" }`) re-enters the step.
            return { tone: "formal" }
          })

          const workflow: RuntimeWorkflow = {
            id: "pricing-brief",
            steps: [{ kind: "agent", id: stepId, adapter: "mock", prompt: () => manifestExcerpt.steps[0]!.prompt }],
          }
          const { output } = await runWorkflow({ workflow, agents: host, onInputRequired })

          expect(onInputRequired).toHaveBeenCalledTimes(1)
          expect(expected.terminalState).toBe("suspended")
          expect(expected.stepStatus).toBe("suspended")
          expect(expected.stepSuspend.reason).toBe("input-required")
          // No outputSchema on this vector's step ⇒ vacuous contract — the
          // re-entered step succeeds once resumed (§3's third branch).
          expect(output).toEqual({ sessionId: "sess_fake" })
        })

        it("the same signal with no onInputRequired hook wired throws — it never silently resolves as success", async () => {
          const agentTurn = vector["agentTurn"] as { toolCall: { args: { stepId: string; prompt: string } } }
          const manifestExcerpt = vector["manifestExcerpt"] as { steps: { id: string; prompt: string }[] }
          const stepId = manifestExcerpt.steps[0]!.id
          const host = fakeHost({
            takeInputRequest: vi.fn(() => ({ prompt: agentTurn.toolCall.args.prompt })),
          })
          const workflow: RuntimeWorkflow = {
            id: "pricing-brief",
            steps: [{ kind: "agent", id: stepId, adapter: "mock", prompt: () => manifestExcerpt.steps[0]!.prompt }],
          }
          await expect(runWorkflow({ workflow, agents: host })).rejects.toMatchObject({
            name: "AgentInputRequiredError",
            stepId,
          })
        })

        return
      }

      if (vector.id === "V8") {
        // ── V8 — question-shaped final text, no explicit signal → failed missing-output, hinted ──

        it("turn ends with a trailing-'?' message and no explicit signal → failed { code: missing-output }, hinted — never suspended", async () => {
          const agentTurn = vector["agentTurn"] as { finalMessage: string; toolCall: null; protocolAwaitingInputEvent: boolean }
          const expected = vector["expected"] as {
            terminalState: string
            stepStatus: string
            error: { code: string; stepId: string }
            hint: string
          }
          const manifestExcerpt = vector["manifestExcerpt"] as { id: string; steps: Record<string, unknown>[] }
          const stepId = manifestExcerpt.steps[0]!["id"] as string

          expect(agentTurn.toolCall).toBeNull()
          expect(agentTurn.protocolAwaitingInputEvent).toBe(false)

          const onInputRequired = vi.fn()
          // No `takeInputRequest` override: this host, like the vector, never
          // observes an explicit signal — `ctx.agents.takeInputRequest` is
          // simply absent, same as a host with no signal wiring at all.
          const host = fakeHost({
            readFinalMessage: vi.fn(async () => agentTurn.finalMessage),
          })

          // Compiled straight from the vector's own `manifestExcerpt` — its
          // step's `outputSchema` is plain JSON Schema (YAML frontmatter has
          // no zod instance to author), exactly what `compileAgentStep`
          // adapts via ajv into the `{ safeParse }` shape `execAgentStep`
          // consumes. `manifestExcerpt.steps[0].outputSchema` is added
          // locally ahead of agentproto/agentproto#39 (branch
          // `aip58-vacuous-contract`, which makes the same addition upstream
          // and amends §3 to say a step declaring no contract has a vacuous
          // contract — see the vendored vector's own `notes[]`). The vector
          // itself is silent on which adapter spawns the session (that's a
          // host wiring detail, not part of the abstract vector) — `adapter:
          // "mock"` is added here for the same reason V1's test supplies a
          // fake tool/driver around its vector data.
          const manifestForCompile = {
            ...manifestExcerpt,
            steps: manifestExcerpt.steps.map((s) => ({ ...s, adapter: "mock" })),
          }
          const workflow = compileWorkflow(manifestForCompile as unknown as Parameters<typeof compileWorkflow>[0], {
            tools: {},
            candidates: [],
          })

          await expect(runWorkflow({ workflow, agents: host, onInputRequired })).rejects.toMatchObject({
            name: "StepOutcomeError",
            stepId,
            code: expected.error.code,
            hint: expected.hint,
          })
          // The heuristic never upgrades to a suspend — no signal, no hook call.
          expect(onInputRequired).not.toHaveBeenCalled()
          expect(expected.terminalState).toBe("failed")
          expect(expected.stepStatus).toBe("failed")
        })

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
