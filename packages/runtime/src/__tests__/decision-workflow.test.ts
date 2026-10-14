/**
 * The shipped `decision-route` workflow, end to end: the REAL WORKFLOW.md +
 * entry.mjs loaded and run through the workflow engine, dispatching to the
 * REAL stage handlers (registered on a recording fake MCP server that applies
 * each tool's zod input schema, as the daemon does). Only the edges are fake:
 * git, the Jev HTTP fetch, the escalation host, the review runner, presets.
 * No live model, no live daemon.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { parseReviewManifest } from "@agentproto/review"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { clearDecisionCache, decisionCacheSize } from "../decision.js"
import type { EscalationHost, EscalationHostResult, EscalationHostRun } from "../decision-escalation.js"
import { parseDecisionPolicy } from "../decision-policy.js"
import type { PresetLookups } from "../decision-profile.js"
import {
  registerDecisionWorkflowTools,
  stageRunReview,
  type DecisionWorkflowDeps,
} from "../decision-workflow-tools.js"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"
import { readFileSync } from "node:fs"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const WORKFLOW_PATH = join(PKG, "workflows", "decision-route", "WORKFLOW.md")
const EXAMPLES = join(PKG, "workflows", "decision-route", "examples")

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)

// ── fake MCP server that applies zod like the daemon ──────────────────────

type ToolHandler = (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown> | unknown

function fakeServer() {
  const tools = new Map<string, { shape: z.ZodRawShape; handler: ToolHandler }>()
  return {
    tools,
    server: {
      tool(name: string, _desc: string, shape: z.ZodRawShape, handler: ToolHandler) {
        tools.set(name, { shape, handler })
      },
    },
  }
}

// ── fakes ─────────────────────────────────────────────────────────────────

const harnessPresets: Record<string, { harnessSlug: string; defaultModel: string; profileRef: string }> = {
  "opencode-free-review": { harnessSlug: "opencode", defaultModel: "glm-4.7-free", profileRef: "zen" },
  "claude-sonnet-review": { harnessSlug: "claude-code", defaultModel: "claude-sonnet-4-5", profileRef: "claude-sub" },
  "esc-free": { harnessSlug: "opencode", defaultModel: "big-pickle", profileRef: "zen" },
  "esc-sonnet": { harnessSlug: "claude-code", defaultModel: "claude-sonnet-4-5", profileRef: "claude-sub" },
  "esc-paid": { harnessSlug: "opencode", defaultModel: "kimi-k2-thinking", profileRef: "zen" },
}

function presetLookups(over: Partial<PresetLookups> = {}): PresetLookups {
  return {
    getHarnessPreset: async id => {
      const p = harnessPresets[id as string]
      return p ? ({ id, name: id, isDefault: false, ...p } as never) : undefined
    },
    getUserPreset: async () => undefined,
    getAuthProfile: async id => ({ id, endpoint: "opencode-go", method: { kind: "api-key" } }) as never,
    getDefaultHarnessPreset: async () => undefined,
    resolveRole: role =>
      role === "review.small" ? ({ model: "claude-sonnet-4-5", adapter: "claude-code" } as never) : undefined,
    ...over,
  }
}

const controls = {
  configured: { posture: "read-only" as const, mcpServers: "none" as const },
  enforced: {
    posture: "prompt-advisory" as const,
    mcpServers: "none-mounted" as const,
    commandSandbox: "not-requested" as const,
    harnessBuiltinToolsAvailable: true as const,
  },
}

function fakeEscalationHost(result: Record<string, unknown> | (() => Promise<EscalationHostResult>)) {
  const runs: EscalationHostRun[] = []
  const host: EscalationHost = {
    async run(input) {
      runs.push(input)
      return typeof result === "function" ? result() : ({ toolControls: controls, ...result } as unknown as EscalationHostResult)
    },
  }
  return { host, runs }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function jevAnswer(choice: string, p: number) {
  const rest = (1 - p) / 2
  const probabilities = Object.fromEntries(["light", "standard", "deep"].map(c => [c, c === choice ? p : rest]))
  return json({ model: "jev-test", answers: { decision: { type: "choice", choice, confidence: p, probabilities } } })
}

interface FakeLane {
  id: string
  kind?: string
  status?: string
  blocking?: boolean
  preset?: string
  model?: string
  fallbacks?: unknown[]
  recovery?: { outcome: string }
}

function fakeReviewRunner(opts: {
  verdict?: "pass" | "block" | "incomplete"
  status?: string
  lanes?: FakeLane[]
  hang?: boolean
}) {
  const starts: Array<Record<string, unknown>> = []
  const cancels: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>(r => (release = r))
  const run = (): never =>
    ({
      runId: "rv-1",
      status: opts.status ?? "done",
      attestation: { verdict: opts.verdict ?? "pass" },
      cached: false,
      lanes: (opts.lanes ?? [{ id: "claims", kind: "agent", status: "done", blocking: false, preset: "opencode-free-review", model: "glm-4.7-free" }]).map(l => ({
        kind: "agent",
        status: "done",
        blocking: false,
        fallbacks: [],
        ...l,
      })),
    }) as never
  return {
    starts,
    cancels,
    runner: {
      start: (input: Record<string, unknown>) => {
        starts.push(input)
        return { ...(run() as object), status: "running" } as never
      },
      wait: async () => {
        if (opts.hang) {
          await gate
          return undefined
        }
        return run()
      },
      cancel: (id: string) => {
        cancels.push(id)
        release?.()
        return true
      },
    },
  }
}

// ── harness ───────────────────────────────────────────────────────────────

let runsRoot: string
beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "agp-decision-wf-"))
  clearDecisionCache()
})
afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true })
})

const NOOP_AGENTS: AgentSessionHost = {
  spawn: vi.fn(async () => {
    throw new Error("the decision-route workflow must not spawn agent steps")
  }),
  sendPromptAndWait: vi.fn(),
  resolveByLabel: vi.fn(),
}

const CODE_EVIDENCE = { changeCounts: { files: 3 }, changeTypes: "code", riskCategories: [], signals: [], completeness: 1 }
const DOCS_EVIDENCE = { changeCounts: { files: 2 }, changeTypes: "docs-only", riskCategories: [], signals: [], completeness: 1 }
const RISK_EVIDENCE = { changeCounts: { files: 1 }, changeTypes: "code", riskCategories: ["auth"], signals: ["hardRisk"], completeness: 1 }

async function runRoute(
  input: Record<string, unknown>,
  deps: DecisionWorkflowDeps = {},
  opts: { runId?: string } = {},
) {
  const { server, tools } = fakeServer()
  const fakeGit: DecisionWorkflowDeps["git"] = async (_cwd, args) => {
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return "/repo\n"
    if (args[0] === "rev-parse") return `${HEAD}\n`
    if (args[0] === "merge-base") return `${BASE}\n`
    if (args[0] === "diff") return `1\t0\tsrc/a.ts\0`
    throw new Error(`unexpected git ${args.join(" ")}`)
  }
  registerDecisionWorkflowTools(server as never, {
    git: fakeGit,
    presetLookups: presetLookups(),
    jev: async () => ({ apiKey: "test-key", model: "jev-test", baseUrl: "https://jev.example/v1" }),
    jevSleep: async () => undefined,
    ...deps,
  })
  const called: string[] = []
  const dispatchTool: DispatchTool = async (name, inputs) => {
    called.push(name)
    const tool = tools.get(name)
    if (!tool) throw new Error(`unregistered tool ${name}`)
    // Exactly what the daemon's MCP layer does: validate against the tool's shape.
    const parsed = z.object(tool.shape).parse(inputs)
    return tool.handler(parsed as Record<string, unknown>, {})
  }
  const handle = await loadWorkflowHandle(WORKFLOW_PATH)
  const compiled = compileWorkflow(handle, { ...createDaemonToolRegistry(handle, dispatchTool) })
  const runId = opts.runId ?? "run-test-1"
  const steps: Record<string, any> = {}
  const order: string[] = []
  await runWorkflow({
    workflow: compiled,
    agents: NOOP_AGENTS,
    input: {
      cwd: EXAMPLES,
      manifestPath: "REVIEW.md",
      parentSessionId: "parent-sess",
      ...input,
    },
    workspace: join(runsRoot, runId, "scratch"),
    onStepComplete: (stepId, output) => {
      order.push(stepId)
      steps[stepId] = output
    },
  })
  return { steps, order, called, report: steps.validate as Record<string, any> }
}

// ── shape ─────────────────────────────────────────────────────────────────

describe("decision-route — shipped files", () => {
  it("the workflow loads with the seven ordered steps, all tool steps", async () => {
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    expect(handle.id).toBe("decision-route")
    expect(handle.steps.map(s => `${s.id}:${s.kind}`)).toEqual([
      "collect:tool",
      "rules:tool",
      "classify:tool",
      "escalate:tool",
      "select:tool",
      "review:tool",
      "validate:tool",
    ])
  })

  it("the example DECISION.md and REVIEW.md parse, and bindings name checks (never model ids)", () => {
    const decision = parseDecisionPolicy(readFileSync(join(EXAMPLES, "DECISION.md"), "utf8"))
    expect(decision.ok).toBe(true)
    const manifest = parseReviewManifest(readFileSync(join(EXAMPLES, "REVIEW.md"), "utf8"))
    expect(Object.keys(manifest.bindings ?? {}).sort()).toEqual(["deep", "deep-free", "light", "local"])
  })
})

// ── zero-model and direct-API paths ───────────────────────────────────────

describe("decision-route — rule-certain and Jev direct", () => {
  it("a rule-certain range uses zero models and reports the owner trail", async () => {
    const jevFetch = vi.fn()
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"deep"}', sessionId: "x" })
    const createEscalationHost = vi.fn(() => esc.host)
    const { report, order, steps } = await runRoute(
      { profile: "remote-sonnet", evidence: DOCS_EVIDENCE },
      { jevFetch: jevFetch as never, createEscalationHost },
    )
    expect(order).toEqual(["collect", "rules", "classify", "escalate", "select", "review", "validate"])
    expect(jevFetch).not.toHaveBeenCalled()
    expect(createEscalationHost).not.toHaveBeenCalled()
    expect(esc.runs).toHaveLength(0)
    expect(report).toMatchObject({
      ok: true,
      state: "shadow",
      approved: false,
      choice: "light",
      decisionSource: "rule",
      decisionStatus: "decided",
      binding: "light",
    })
    // Every stage carries the same workflow / run / parent / profile.
    for (const id of order) {
      expect(steps[id].trace).toMatchObject({
        workflow: "decision-route",
        runId: "run-test-1",
        parentSessionId: "parent-sess",
        profile: "remote-sonnet",
      })
    }
    expect(steps.classify.classifier).toMatchObject({ attempted: false, status: "skipped" })
    expect(steps.escalate.escalation).toMatchObject({ attempted: false })
  })

  it("an unresolved range gets exactly one Jev direct-API call and no harness", async () => {
    const jevFetch = vi.fn(async () => jevAnswer("standard", 0.93))
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"deep"}', sessionId: "x" })
    const { report, steps } = await runRoute(
      { profile: "remote-sonnet", evidence: CODE_EVIDENCE },
      { jevFetch: jevFetch as never, createEscalationHost: () => esc.host },
    )
    expect(jevFetch).toHaveBeenCalledTimes(1)
    expect(esc.runs).toHaveLength(0)
    expect(report).toMatchObject({ choice: "standard", decisionSource: "classifier", decisionStatus: "decided", binding: "local" })
    expect(steps.classify.trace).toMatchObject({ harness: "jev-api", decisionSource: "classifier" })
    expect(steps.classify.classifier).toMatchObject({ attempted: true, status: "ok" })
  })

  it("a hard-risk floor settles without any model", async () => {
    const jevFetch = vi.fn()
    const { report } = await runRoute({ profile: "remote-sonnet", evidence: RISK_EVIDENCE }, { jevFetch: jevFetch as never })
    expect(jevFetch).not.toHaveBeenCalled()
    expect(report).toMatchObject({ choice: "deep", decisionStatus: "decided", binding: "deep" })
  })

  it("Jev is not called under local-free unless the operator enables it", async () => {
    const jevFetch = vi.fn(async () => jevAnswer("standard", 0.93))
    const { steps } = await runRoute({ profile: "local-free", evidence: CODE_EVIDENCE }, { jevFetch: jevFetch as never })
    expect(jevFetch).not.toHaveBeenCalled()
    expect(steps.classify.classifier).toMatchObject({ attempted: false, status: "skipped" })

    const on = await runRoute(
      { profile: "local-free", profileOptions: { jev: true }, evidence: CODE_EVIDENCE },
      { jevFetch: jevFetch as never },
    )
    expect(jevFetch).toHaveBeenCalledTimes(1)
    expect(on.report).toMatchObject({ choice: "standard", decisionSource: "classifier" })
  })
})

// ── escalation ────────────────────────────────────────────────────────────

describe("decision-route — one profile-gated escalation", () => {
  const lowConfidence = () => vi.fn(async () => jevAnswer("light", 0.5))

  it("low confidence escalates exactly once through the configured harness, owned by the workflow", async () => {
    const jevFetch = lowConfidence()
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"standard"}', sessionId: "esc-1", model: "big-pickle", toolControls: controls })
    const { report, steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: jevFetch as never, createEscalationHost: () => esc.host },
    )
    expect(jevFetch).toHaveBeenCalledTimes(1)
    expect(esc.runs).toHaveLength(1)
    expect(esc.runs[0]).toMatchObject({
      spawn: { adapter: "opencode", model: "big-pickle" },
      owner: { runId: "run-test-1", workflowId: "decision-route", stepId: "escalate" },
      parentSessionId: "parent-sess",
    })
    expect(esc.runs[0]!.prompt).toContain("light | standard | deep")
    expect(report).toMatchObject({ choice: "standard", decisionSource: "escalation", decisionStatus: "decided" })
    expect(steps.escalate.escalation).toMatchObject({ attempted: true, status: "decided", wait: "turn", actualModel: "big-pickle", sessionId: "esc-1" })
    expect(steps.escalate.escalation.toolControls.enforced.harnessBuiltinToolsAvailable).toBe(true)
    expect(steps.escalate.trace).toMatchObject({ harness: "opencode", model: "big-pickle", wait: "turn" })
  })

  it("the classifier answer is replayed, not re-asked, by the escalation stage", async () => {
    const jevFetch = lowConfidence()
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"standard"}', sessionId: "e" })
    await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: jevFetch as never, createEscalationHost: () => esc.host },
    )
    expect(jevFetch).toHaveBeenCalledTimes(1)
  })

  it("only declared choices are accepted: an out-of-set reply falls back to the conservative default", async () => {
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"ultra"}', sessionId: "e" })
    const { report, steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: lowConfidence() as never, createEscalationHost: () => esc.host },
    )
    expect(esc.runs).toHaveLength(1)
    expect(steps.escalate.escalation).toMatchObject({ status: "invalid-reply" })
    expect(report).toMatchObject({ choice: "deep", decisionSource: "default", decisionStatus: "fallback", approved: false })
  })

  it.each([
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["failed", "provider-unavailable"],
  ] as const)("a %s escalation is recorded as such and never becomes an approval", async (status, wait) => {
    const esc = fakeEscalationHost({ status, wait, error: `${status} happened`, sessionId: "e" })
    const { report, steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: lowConfidence() as never, createEscalationHost: () => esc.host },
    )
    expect(esc.runs).toHaveLength(1)
    expect(steps.escalate.escalation).toMatchObject({ attempted: true, status, wait })
    expect(report).toMatchObject({ decisionStatus: "fallback", decisionSource: "default", approved: false })
    expect(report.escalation).toMatchObject({ status, wait })
  })

  it("a Jev failure is normal uncertainty: it flows to the one escalation, not to a human", async () => {
    const jevFetch = vi.fn(async () => json({ error: "down" }, 500))
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"light"}', sessionId: "e" })
    const { report, steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: jevFetch as never, createEscalationHost: () => esc.host },
    )
    expect(jevFetch).toHaveBeenCalledTimes(1) // maxRetries 0: no hidden retry
    expect(steps.classify.classifier).toMatchObject({ attempted: true, status: "failed" })
    expect(esc.runs).toHaveLength(1)
    expect(report).toMatchObject({ choice: "light", decisionSource: "escalation" })
  })

  it("incomplete evidence is never trusted to the classifier", async () => {
    const jevFetch = vi.fn(async () => jevAnswer("light", 0.99))
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"standard"}', sessionId: "e" })
    const { report } = await runRoute(
      {
        profile: "local-free",
        profileOptions: { jev: true, escalation: { preset: "esc-free" } },
        evidence: { ...CODE_EVIDENCE, completeness: 0.5 },
      },
      { jevFetch: jevFetch as never, createEscalationHost: () => esc.host },
    )
    expect(report.decisionSource).not.toBe("classifier")
  })

  it("human-input-required from the escalation is its own state, not an approval", async () => {
    const esc = fakeEscalationHost({ status: "failed", wait: "human-input-required", error: "asked a question", sessionId: "e" })
    const rr = fakeReviewRunner({ verdict: "pass" })
    const { report } = await runRoute(
      { profile: "local-free", mode: "enforce", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE },
      { jevFetch: lowConfidence() as never, createEscalationHost: () => esc.host, reviewRunner: rr.runner as never },
    )
    expect(report).toMatchObject({ state: "human-input-required", approved: false })
    expect(report.escalation).toMatchObject({ wait: "human-input-required" })
  })
})

// ── profile enforcement before spawn ──────────────────────────────────────

describe("decision-route — the profile is enforced BEFORE spawn", () => {
  const lowConf = () => vi.fn(async () => jevAnswer("light", 0.5))

  it.each([
    ["Sonnet preset", "esc-sonnet"],
    ["paid OpenCode id", "esc-paid"],
    ["unknown preset", "nope"],
  ])("free-only refuses a %s escalation target without touching the host", async (_n, preset) => {
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"light"}', sessionId: "e" })
    const createEscalationHost = vi.fn(() => esc.host)
    const { report, steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true, escalation: { preset } }, evidence: CODE_EVIDENCE },
      { jevFetch: lowConf() as never, createEscalationHost },
    )
    expect(esc.runs).toHaveLength(0)
    expect(createEscalationHost).not.toHaveBeenCalled()
    expect(steps.escalate.escalation).toMatchObject({ attempted: false, status: "refused" })
    expect(report).toMatchObject({ decisionSource: "default", decisionStatus: "fallback", approved: false })
  })

  it("local-free with no escalation target is refused, not defaulted to a paid model", async () => {
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"light"}', sessionId: "e" })
    const { steps } = await runRoute(
      { profile: "local-free", profileOptions: { jev: true }, evidence: CODE_EVIDENCE },
      { jevFetch: lowConf() as never, createEscalationHost: () => esc.host },
    )
    expect(esc.runs).toHaveLength(0)
    expect(steps.escalate.escalation).toMatchObject({ status: "refused" })
  })

  it("an entitlement cannot be widened through input", async () => {
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"light"}', sessionId: "e" })
    const { steps } = await runRoute(
      {
        profile: "local-free",
        profileOptions: { jev: true, escalation: { adapter: "claude-code", model: "claude-sonnet-4-5" }, entitlement: "subscription" },
        evidence: CODE_EVIDENCE,
      },
      { jevFetch: lowConf() as never, createEscalationHost: () => esc.host },
    )
    expect(esc.runs).toHaveLength(0)
    expect(steps.escalate.trace.entitlement).toBe("free-only")
  })

  it("subscription uses the configured Claude Code Sonnet harness (role default)", async () => {
    const esc = fakeEscalationHost({ status: "ended", text: '{"choice":"standard"}', sessionId: "e", model: "claude-sonnet-4-5" })
    const { report, steps } = await runRoute(
      { profile: "remote-sonnet", evidence: CODE_EVIDENCE },
      { jevFetch: lowConf() as never, createEscalationHost: () => esc.host },
    )
    expect(esc.runs).toHaveLength(1)
    expect(esc.runs[0]!.spawn).toMatchObject({ adapter: "claude-code", model: "claude-sonnet-4-5" })
    expect(report).toMatchObject({ choice: "standard", decisionSource: "escalation" })
    expect(steps.escalate.trace).toMatchObject({ harness: "claude-code", model: "claude-sonnet-4-5", profile: "remote-sonnet" })
  })

  it("the conservative deep route cannot bypass free-only: a Sonnet 'deep' binding is refused, nothing substituted", async () => {
    const rr = fakeReviewRunner({})
    const { report, steps } = await runRoute(
      // freeBindings emptied: the fallback `deep` binding would use the Sonnet check.
      { profile: "local-free", mode: "enforce", freeBindings: {}, evidence: RISK_EVIDENCE },
      { reviewRunner: rr.runner as never },
    )
    expect(steps.select).toMatchObject({ ready: false, state: "refused", binding: "deep" })
    expect(steps.select.targets.some((t: { ok: boolean; preset: string }) => !t.ok && t.preset === "claude-sonnet-review")).toBe(true)
    expect(rr.starts).toHaveLength(0)
    expect(report).toMatchObject({ state: "refused", approved: false })
  })

  it("free-only maps deep to deep-free and that binding is fully free", async () => {
    const { steps, report } = await runRoute({ profile: "local-free", evidence: RISK_EVIDENCE })
    expect(steps.select).toMatchObject({ ready: true, binding: "deep-free" })
    expect(steps.select.targets.every((t: { ok: boolean }) => t.ok)).toBe(true)
    expect(report).toMatchObject({ choice: "deep", binding: "deep-free" })
  })

  it("subscription takes the Sonnet deep binding", async () => {
    const { steps } = await runRoute({ profile: "remote-sonnet", evidence: RISK_EVIDENCE })
    expect(steps.select).toMatchObject({ ready: true, binding: "deep" })
  })

  it("a paid review.recovery preset or model override refuses a free-only selection", async () => {
    const paidPreset = await runRoute(
      { profile: "local-free", evidence: DOCS_EVIDENCE },
      { getRecovery: () => ({ presets: ["claude-sonnet-review"] }) as never },
    )
    expect(paidPreset.steps.select).toMatchObject({ ready: false, state: "refused" })
    const paidModel = await runRoute(
      { profile: "local-free", evidence: DOCS_EVIDENCE },
      { getRecovery: () => ({ presets: ["opencode-free-review"], model: { model: "claude-sonnet-4-5" } }) as never },
    )
    expect(paidModel.steps.select).toMatchObject({ ready: false, state: "refused" })
    const free = await runRoute(
      { profile: "local-free", evidence: DOCS_EVIDENCE },
      { getRecovery: () => ({ presets: ["opencode-free-review"] }) as never },
    )
    expect(free.steps.select).toMatchObject({ ready: true })
  })

  it("a choice with no binding mapping is refused, not guessed", async () => {
    const { steps } = await runRoute({ profile: "remote-sonnet", bindings: { standard: "local" }, evidence: DOCS_EVIDENCE })
    expect(steps.select).toMatchObject({ ready: false, state: "refused" })
  })
})

// ── review: shadow vs enforce, verdict validation ─────────────────────────

describe("decision-route — review and verdict validation", () => {
  it("shadow (the default) never starts a review lane", async () => {
    const rr = fakeReviewRunner({})
    const { report, steps } = await runRoute({ profile: "remote-sonnet", evidence: DOCS_EVIDENCE }, { reviewRunner: rr.runner as never })
    expect(rr.starts).toHaveLength(0)
    expect(steps.review).toMatchObject({ started: false, mode: "shadow", state: "shadow" })
    expect(report).toMatchObject({ state: "shadow", approved: false })
  })

  it("enforce starts the selected binding on the frozen range under the parent and approves only a real pass", async () => {
    const rr = fakeReviewRunner({ verdict: "pass" })
    const { report, steps } = await runRoute(
      { profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE },
      { reviewRunner: rr.runner as never },
    )
    expect(rr.starts).toHaveLength(1)
    expect(rr.starts[0]).toMatchObject({ binding: "light", base: BASE, head: HEAD, parentSessionId: "parent-sess" })
    expect(steps.review.trace.wait).toBe("review")
    expect(report).toMatchObject({ state: "completed", approved: true, verdict: "pass", violations: [] })
  })

  it("a block verdict completes but is not an approval", async () => {
    const rr = fakeReviewRunner({ verdict: "block" })
    const { report } = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: rr.runner as never })
    expect(report).toMatchObject({ state: "completed", approved: false, verdict: "block" })
  })

  it("an incomplete verdict is not an approval", async () => {
    const rr = fakeReviewRunner({ verdict: "incomplete" })
    const { report } = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: rr.runner as never })
    expect(report).toMatchObject({ state: "incomplete", approved: false })
  })

  it("no recovery from unknown evidence: an insufficient_evidence recovery is never an approval", async () => {
    const rr = fakeReviewRunner({
      verdict: "incomplete",
      lanes: [
        {
          id: "claims",
          status: "failed",
          preset: "opencode-free-review",
          model: "glm-4.7-free",
          recovery: { outcome: "insufficient_evidence" },
        },
      ],
    })
    const { report } = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: rr.runner as never })
    expect(report.approved).toBe(false)
    expect(report.state).not.toBe("completed")
    expect(report.recoveryCount).toBe(1)
    expect(report.unrecoveredLanes).toEqual([{ id: "claims", outcome: "insufficient_evidence" }])
  })

  it("reports fallback and recovery counts and provider-unavailable separately", async () => {
    const rr = fakeReviewRunner({
      verdict: "incomplete",
      status: "failed",
      lanes: [
        { id: "claims", status: "skipped", preset: "opencode-free-review", fallbacks: [{}, {}], recovery: { outcome: "unavailable" } },
      ],
    })
    // status "failed" folds into `failed`; use a done-but-incomplete run for the provider path:
    const rr2 = fakeReviewRunner({
      verdict: "incomplete",
      lanes: [
        { id: "claims", status: "skipped", preset: "opencode-free-review", fallbacks: [{}, {}], recovery: { outcome: "unavailable" } },
      ],
    })
    const failed = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: rr.runner as never })
    expect(failed.report).toMatchObject({ state: "failed", approved: false })
    const unavailable = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: rr2.runner as never })
    expect(unavailable.report).toMatchObject({ state: "provider-unavailable", approved: false, fallbackCount: 2, recoveryCount: 1 })
    expect(unavailable.steps.review.trace).toMatchObject({ fallbackCount: 2, recoveryCount: 1 })
  })

  it("a lane that ran outside the preflighted set (or on a paid model) is a profile violation, not a pass", async () => {
    const stray = fakeReviewRunner({
      verdict: "pass",
      lanes: [{ id: "claims", status: "done", preset: "claude-sonnet-review", model: "claude-sonnet-4-5" }],
    })
    const a = await runRoute({ profile: "local-free", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: stray.runner as never })
    expect(a.report).toMatchObject({ state: "failed", approved: false })
    expect(a.report.violations.length).toBeGreaterThan(0)

    const paidModel = fakeReviewRunner({
      verdict: "pass",
      lanes: [{ id: "claims", status: "done", preset: "opencode-free-review", model: "kimi-k2-thinking" }],
    })
    const b = await runRoute({ profile: "local-free", mode: "enforce", evidence: DOCS_EVIDENCE }, { reviewRunner: paidModel.runner as never })
    expect(b.report).toMatchObject({ state: "failed", approved: false })
  })

  it("the review deadline cancels the run and reports timeout", async () => {
    const rr = fakeReviewRunner({ hang: true })
    const { report, steps } = await runRoute(
      { profile: "remote-sonnet", mode: "enforce", profileOptions: { reviewTimeoutMs: 150 }, evidence: DOCS_EVIDENCE },
      { reviewRunner: rr.runner as never },
    )
    expect(rr.cancels).toEqual(["rv-1"])
    expect(steps.review).toMatchObject({ started: true, state: "deadline" })
    expect(steps.review.trace.wait).toBe("review-deadline")
    expect(report).toMatchObject({ state: "timeout", approved: false })
  })

  it("an abort signal cancels a running review exactly once", async () => {
    const rr = fakeReviewRunner({ hang: true })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const out = await stageRunReview(
      {
        policy: readFileSync(join(EXAMPLES, "DECISION.md"), "utf8"),
        profile: "remote-sonnet",
        select: { ready: true, binding: "light" },
        range: { baseSha: BASE, headSha: HEAD },
        cwd: EXAMPLES,
        mode: "enforce",
        signal: ac.signal,
      },
      { reviewRunner: rr.runner as never },
    )
    expect(rr.cancels).toEqual(["rv-1"])
    expect(out).toMatchObject({ started: true, state: "cancelled" })
  })

  it("enforce without a wired runner starts nothing and says why", async () => {
    const { report, steps } = await runRoute({ profile: "remote-sonnet", mode: "enforce", evidence: DOCS_EVIDENCE })
    expect(steps.review).toMatchObject({ started: false, state: "not-started" })
    expect(report).toMatchObject({ state: "failed", approved: false })
  })
})

// ── cache / failure behaviour at workflow level ───────────────────────────

describe("decision-route — staged decisions bypass the shared cache", () => {
  it("running the workflow never populates the decision cache, and a failure is not remembered", async () => {
    const before = decisionCacheSize()
    const esc = fakeEscalationHost({ status: "failed", wait: "provider-unavailable", error: "down", sessionId: "e" })
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "down" }, 500))
      .mockResolvedValue(jevAnswer("standard", 0.95))
    const input = { profile: "local-free", profileOptions: { jev: true, escalation: { preset: "esc-free" } }, evidence: CODE_EVIDENCE }
    const first = await runRoute(input, { jevFetch: flaky as never, createEscalationHost: () => esc.host })
    expect(first.report).toMatchObject({ decisionStatus: "fallback", decisionSource: "default" })
    // Backend recovered: the next identical run asks again and is decided — the
    // earlier conservative fallback was not cached as a trusted answer.
    const second = await runRoute(input, { jevFetch: flaky as never, createEscalationHost: () => esc.host })
    expect(second.report).toMatchObject({ decisionStatus: "decided", decisionSource: "classifier", choice: "standard" })
    expect(decisionCacheSize()).toBe(before)
  })
})

// ── shadow client helpers ─────────────────────────────────────────────────

describe("shadow-client example", () => {
  it("maps GATE_EXEC_PROFILE to exactly one workflow profile and builds metadata-only shadow input", async () => {
    const mod: any = await import(join(EXAMPLES, "shadow-client.mjs"))
    expect(mod.profileFor("free-only")).toBe("local-free")
    expect(mod.profileFor("subscription")).toBe("remote-sonnet")
    expect(mod.profileFor(undefined)).toBe("remote-sonnet")
    expect(mod.profileFor("whatever")).toBeNull()

    const evidence = mod.buildEvidence(
      [
        { path: "README.md", added: 3, deleted: 1 },
        { path: "docs/logo.png", added: 0, deleted: 0 },
      ],
      { categories: ["auth"], signals: ["hardRisk"], decision: "deep" },
    )
    expect(evidence).toMatchObject({ changeTypes: "docs-only", riskCategories: ["auth"], signals: ["hardRisk"] })
    expect(JSON.stringify(evidence)).not.toContain("README.md")
    expect(JSON.stringify(evidence)).not.toContain("deep") // the router's own decision is not evidence

    const input = mod.buildShadowInput({ repo: "/r", execProfile: "free-only", escalationPreset: "esc-free", evidence })
    expect(input).toMatchObject({ cwd: "/r", profile: "local-free", mode: "shadow", profileOptions: { escalation: { preset: "esc-free" } } })
    expect(() => mod.buildShadowInput({ repo: "/r", execProfile: "paid" })).toThrow()
  })

  it("runShadow polls to a terminal status and cancels on its own deadline", async () => {
    const mod: any = await import(join(EXAMPLES, "shadow-client.mjs"))
    const calls: string[][] = []
    const done = await mod.runShadow(
      { cwd: "/r" },
      {
        repo: "/r",
        pollMs: 1,
        exec: async (args: string[]) => {
          calls.push(args)
          return args[1] === "run-file" ? { runId: "r1" } : { status: "done" }
        },
      },
    )
    expect(done).toMatchObject({ runId: "r1", status: { status: "done" } })

    const calls2: string[][] = []
    const timedOut = await mod.runShadow(
      { cwd: "/r" },
      {
        repo: "/r",
        waitMs: 20,
        pollMs: 5,
        exec: async (args: string[]) => {
          calls2.push(args)
          return args[1] === "run-file" ? { runId: "r2" } : { status: "running" }
        },
      },
    )
    expect(timedOut.status.status).toBe("timeout")
    expect(calls2.some(c => c[1] === "cancel")).toBe(true)
  })
})
