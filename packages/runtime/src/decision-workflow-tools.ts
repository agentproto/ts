/**
 * Stage tools for the shipped `decision-route` workflow
 * (`packages/runtime/workflows/decision-route`): collect bounded evidence →
 * rules → Jev classification → ONE profile-gated harness escalation → closed
 * choice → review-binding selection → review run → verdict validation.
 *
 * Each stage is a pure-ish exported function (`stage*`) over injected deps,
 * wrapped by a thin MCP registration. The workflow (the parent) owns the step
 * order and records, per stage, a `trace`: workflow / run id / step / parent
 * session / profile / actual harness+model / decision source / wait reason /
 * fallback + recovery counts.
 *
 * Failure policy: a stage NEVER throws an MCP error for backend trouble —
 * failures are returned as data (`ok:false`, or a non-approving `state`) so a
 * failed escalation or an unavailable provider is recorded as such, never as
 * an approval. Nothing here retries; every stage runs at most once.
 *
 * Tool restrictions are reported honestly (`toolControls` on the escalation):
 * the escalation session is spawned with `posture: "read-only"` and no MCP
 * servers, but the harness's own built-in tools stay available — "read-only"
 * is an adapter control where the adapter supports it and an advisory prompt
 * line where it does not. It is not a no-tools guarantee and is never called
 * one.
 */

import { readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  getCheck,
  parseReviewManifest,
  resolveBinding,
  resolvePacks,
  type ReviewManifest,
} from "@agentproto/review"
import { z } from "zod"

import { decide, type ClassifierOutcome, type DecisionOutcome } from "./decision.js"
import { collectEvidence, type CollectedEvidence, type GitRunner } from "./decision-evidence.js"
import {
  createBoundedEscalation,
  type EscalationHost,
  type EscalationRecord,
  type EscalationWait,
} from "./decision-escalation.js"
import { parseDecisionPolicy, type DecisionPolicy } from "./decision-policy.js"
import {
  resolveAndValidateTarget,
  resolveExecProfile,
  validateSpawnTarget,
  type DecisionExecProfile,
  type DecisionProfileInput,
  type PresetLookups,
  type ResolvedTarget,
} from "./decision-profile.js"
import { jevClassifierIdentity, makeJevDecisionClassifier } from "./decision-tools.js"
import { resolveJevApiKey, resolveJevConfig } from "./jev-client.js"
import { createReviewPackLoader } from "./review-pack-loader.js"
import type { ReviewRecoveryConfig } from "./review-reviewer-host.js"
import { resolveRepo, type ReviewRun, type ReviewRunInput, type ReviewRunner } from "./review-runner.js"

export const DECISION_WORKFLOW_ID = "decision-route"

export type DecisionRouteMode = "shadow" | "enforce"

// ── deps ──────────────────────────────────────────────────────────────────

export interface JevConnection {
  readonly apiKey: string | null
  readonly model?: string
  readonly baseUrl?: string
}

export interface DecisionWorkflowDeps {
  /** Builds the escalation host for a resolved profile (the host re-checks the
   *  live session against it). Absent ⇒ escalation is recorded as refused. */
  readonly createEscalationHost?: (profile: DecisionExecProfile) => EscalationHost | undefined
  readonly reviewRunner?: Pick<ReviewRunner, "start" | "wait" | "cancel">
  readonly presetLookups?: PresetLookups
  /** The review host's recovery config — preflighted like any other reviewer. */
  readonly getRecovery?: () => ReviewRecoveryConfig | undefined
  readonly jev?: () => Promise<JevConnection>
  readonly jevFetch?: typeof fetch
  readonly jevSleep?: (ms: number) => Promise<void>
  readonly git?: GitRunner
  readonly loadManifest?: (cwd: string, manifestPath?: string) => Promise<ReviewManifest>
  readonly now?: () => number
}

// ── shared input / trace ──────────────────────────────────────────────────

export interface StageContext {
  readonly policy: string
  readonly profile?: string
  readonly profileOptions?: Omit<DecisionProfileInput, "profile">
  /** `$run.workspace` of the calling workflow run (`<runs>/<runId>/scratch`). */
  readonly runWorkspace?: string
  readonly parentSessionId?: string
  readonly signal?: AbortSignal
}

export interface StageTrace {
  readonly workflow: typeof DECISION_WORKFLOW_ID
  readonly runId: string
  readonly step: string
  readonly parentSessionId?: string
  readonly profile: string
  readonly entitlement: string
  readonly harness?: string
  readonly model?: string
  readonly decisionSource?: string
  readonly wait: EscalationWait | "review" | "review-deadline" | "none"
  readonly fallbackCount: number
  readonly recoveryCount: number
  readonly note?: string
}

function runIdOf(runWorkspace: string | undefined): string {
  if (!runWorkspace) return "unknown"
  const base = basename(runWorkspace)
  return base === "scratch" ? basename(dirname(runWorkspace)) : base
}

type Prepared =
  | { readonly ok: true; readonly policy: DecisionPolicy; readonly profile: DecisionExecProfile; readonly runId: string }
  | { readonly ok: false; readonly error: string; readonly errors?: readonly string[] }

function prepare(ctx: StageContext): Prepared {
  const parsed = parseDecisionPolicy(ctx.policy)
  if (!parsed.ok) return { ok: false, error: "invalid DECISION.md policy", errors: parsed.errors }
  const profile = resolveExecProfile({ ...(ctx.profileOptions ?? {}), ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}) })
  if (!profile.ok) return { ok: false, error: profile.error }
  return { ok: true, policy: parsed.policy, profile: profile.profile, runId: runIdOf(ctx.runWorkspace) }
}

function trace(
  step: string,
  ctx: StageContext,
  p: Extract<Prepared, { ok: true }>,
  extra: Partial<Omit<StageTrace, "workflow" | "runId" | "step" | "profile" | "entitlement">> = {},
): StageTrace {
  return {
    workflow: DECISION_WORKFLOW_ID,
    runId: p.runId,
    step,
    ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
    profile: p.profile.id,
    entitlement: p.profile.entitlement,
    wait: "none",
    fallbackCount: 0,
    recoveryCount: 0,
    ...extra,
  }
}

const failed = (step: string, p: Extract<Prepared, { ok: false }>) => ({
  ok: false as const,
  step,
  error: p.error,
  ...(p.errors ? { errors: p.errors } : {}),
})

// ── 1. collect-evidence ───────────────────────────────────────────────────

export interface CollectStageInput extends Omit<StageContext, "policy"> {
  /** DECISION.md text, or … */
  readonly policy?: string
  /** … a path (relative to `cwd`) the stage reads; the text is echoed back as
   *  `policy` for the later steps. */
  readonly policyPath?: string
  readonly cwd: string
  readonly base?: string
  readonly head?: string
  /** Consumer-built evidence (e.g. a studio router's tier-1 state). */
  readonly supplied?: Record<string, unknown>
}

/** The workflow engine does not apply `inputs.*.default`, so the tools carry
 *  the documented defaults themselves. */
export const DEFAULT_POLICY_PATH = "DECISION.md"
export const DEFAULT_BINDINGS: Readonly<Record<string, string>> = { skip: "light", light: "light", standard: "local", deep: "deep" }
export const DEFAULT_FREE_BINDINGS: Readonly<Record<string, string>> = { deep: "deep-free" }

export async function stageCollectEvidence(input: CollectStageInput, deps: DecisionWorkflowDeps = {}) {
  let policyText = input.policy
  const policyPath = input.policyPath ?? (policyText === undefined ? DEFAULT_POLICY_PATH : undefined)
  if (policyText === undefined && policyPath) {
    try {
      policyText = await readFile(resolve(input.cwd, policyPath), "utf8")
    } catch (e) {
      return { ok: false as const, step: "collect-evidence", error: `policy not readable: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (policyText === undefined) {
    return { ok: false as const, step: "collect-evidence", error: "pass `policy` (DECISION.md text) or `policyPath`" }
  }
  const p = prepare({ ...input, policy: policyText })
  if (!p.ok) return failed("collect-evidence", p)
  const collected: CollectedEvidence = await collectEvidence({
    cwd: input.cwd,
    policy: p.policy,
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.head !== undefined ? { head: input.head } : {}),
    ...(input.supplied !== undefined ? { supplied: input.supplied } : {}),
    ...(deps.git ? { git: deps.git } : {}),
  })
  return {
    ok: true as const,
    policy: policyText,
    evidence: collected.evidence,
    range: collected.range ?? null,
    complete: collected.complete,
    withheld: collected.withheld,
    notes: collected.notes,
    trace: trace("collect-evidence", { ...input, policy: policyText }, p, {
      note: collected.complete ? "metadata only" : "evidence incomplete — classifier scores will not be trusted",
    }),
  }
}

// ── decision carry ────────────────────────────────────────────────────────

export interface ClassifierRecord {
  attempted: boolean
  status: "ok" | "failed" | "skipped"
  reason?: string
  model?: string
  durationMs?: number
}

export interface StageDecision {
  readonly decision: DecisionOutcome
  /** Settled by a rule, floor, accepted classifier answer or escalation. */
  readonly settled: boolean
}

/** Coerce an untrusted (workflow-journal) value back into a ClassifierOutcome. */
function asClassifierOutcome(raw: unknown): ClassifierOutcome | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.ok === true && typeof r.choice === "string") {
    const probs: Record<string, number> = {}
    if (r.probabilities && typeof r.probabilities === "object") {
      for (const [k, v] of Object.entries(r.probabilities as Record<string, unknown>)) {
        if (typeof v === "number") probs[k] = v
      }
    }
    return {
      ok: true,
      choice: r.choice,
      probabilities: probs,
      ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
      ...(typeof r.model === "string" ? { model: r.model } : {}),
    }
  }
  if (r.ok === false && typeof r.error === "string") return { ok: false, error: r.error }
  return null
}

// ── 2. apply-rules ────────────────────────────────────────────────────────

export interface RulesStageInput extends StageContext {
  readonly evidence: Record<string, unknown>
}

export async function stageRules(input: RulesStageInput) {
  const p = prepare(input)
  if (!p.ok) return failed("apply-rules", p)
  // No deps: this stage can never spend a model call.
  const decision = await decide(p.policy, input.evidence, {}, { cache: false })
  const settled = decision.status === "decided"
  return {
    ok: true as const,
    settled,
    decision,
    trace: trace("apply-rules", input, p, { decisionSource: decision.source }),
  }
}

// ── 3. classify (Jev direct API) ──────────────────────────────────────────

export interface ClassifyStageInput extends StageContext {
  readonly evidence: Record<string, unknown>
  /** The apply-rules stage output. */
  readonly rules: { readonly ok?: boolean; readonly settled?: boolean; readonly decision?: DecisionOutcome }
}

export async function stageClassify(input: ClassifyStageInput, deps: DecisionWorkflowDeps = {}) {
  const p = prepare(input)
  if (!p.ok) return failed("classify", p)
  const skip = (reason: string, decision?: DecisionOutcome) => ({
    ok: true as const,
    settled: input.rules.settled === true,
    decision: decision ?? input.rules.decision ?? null,
    classifier: { attempted: false, status: "skipped", reason } satisfies ClassifierRecord,
    rawClassifier: null,
    trace: trace("classify", input, p, { decisionSource: (decision ?? input.rules.decision)?.source, note: reason }),
  })
  if (input.rules.ok === false) return skip("rules stage did not complete")
  if (input.rules.settled === true) return skip("settled by rules — no model call")
  if (p.policy.classifier.kind === "none") return skip("classifier disabled by policy")
  if (!p.profile.jev.enabled) return skip(`Jev classification is disabled by profile ${p.profile.id}`)

  const conn = await (deps.jev ?? defaultJev)()
  const model = p.policy.classifier.model ?? conn.model
  const now = deps.now ?? Date.now
  const started = now()
  let raw: ClassifierOutcome | null = null
  const inner = makeJevDecisionClassifier({
    apiKey: conn.apiKey,
    ...(model !== undefined ? { model } : {}),
    ...(conn.baseUrl !== undefined ? { baseUrl: conn.baseUrl } : {}),
    ...(deps.jevFetch ? { fetchImpl: deps.jevFetch } : {}),
    ...(deps.jevSleep ? { sleep: deps.jevSleep } : {}),
    maxRetries: 0,
    timeoutMs: p.profile.jev.timeoutMs,
  })
  const decision = await decide(
    p.policy,
    input.evidence,
    {
      classify: async q => {
        raw = await inner(q)
        return raw
      },
      classifierIdentity: jevClassifierIdentity(model, conn.baseUrl),
    },
    { cache: false },
  )
  const captured = raw as ClassifierOutcome | null
  const record: ClassifierRecord = {
    attempted: true,
    status: captured?.ok ? "ok" : "failed",
    durationMs: now() - started,
    ...(captured && !captured.ok ? { reason: captured.error } : {}),
    ...(captured?.ok && captured.model ? { model: captured.model } : {}),
  }
  const settled = decision.status === "decided"
  return {
    ok: true as const,
    settled,
    decision,
    classifier: record,
    rawClassifier: captured,
    trace: trace("classify", input, p, {
      decisionSource: decision.source,
      ...(record.model ?? model ? { model: record.model ?? model } : {}),
      harness: "jev-api",
    }),
  }
}

async function defaultJev(): Promise<JevConnection> {
  const cfg = await resolveJevConfig()
  return {
    apiKey: await resolveJevApiKey(),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
  }
}

// ── 4. escalate (≤1, profile-gated, configured harness) ───────────────────

export interface EscalateStageInput extends StageContext {
  readonly evidence: Record<string, unknown>
  readonly classify: {
    readonly ok?: boolean
    readonly settled?: boolean
    readonly decision?: DecisionOutcome | null
    readonly rawClassifier?: unknown
  }
  readonly rules: { readonly decision?: DecisionOutcome }
}

export async function stageEscalate(input: EscalateStageInput, deps: DecisionWorkflowDeps = {}) {
  const p = prepare(input)
  if (!p.ok) return failed("escalate", p)
  const prior = input.classify.decision ?? input.rules.decision ?? null
  const escalation = (e: Partial<EscalationRecord>): EscalationRecord => ({
    attempted: false,
    status: "not-attempted",
    wait: "none",
    ...e,
  })
  const pass = (reason: string, rec?: EscalationRecord) => ({
    ok: true as const,
    settled: input.classify.settled === true,
    decision: prior,
    escalation: rec ?? escalation({ reason }),
    trace: trace("escalate", input, p, { decisionSource: prior?.source, note: reason }),
  })
  if (input.classify.ok === false) return pass("classify stage did not complete")
  if (input.classify.settled === true) return pass("settled before escalation — no harness session")
  if (!p.policy.escalation.enabled || p.policy.escalation.limit < 1) return pass("escalation disabled by policy")

  // Gate BEFORE any spawn: the profile validates what would actually run.
  const target = await resolveAndValidateTarget(p.profile, p.profile.escalation, deps.presetLookups ?? {})
  const host = target.ok ? deps.createEscalationHost?.(p.profile) : undefined
  let refusal: string | undefined
  if (!target.ok) refusal = `${target.code}: ${target.reason}`
  else if (!host) refusal = "no agent adapter resolver is wired — escalation cannot spawn"

  const replay = asClassifierOutcome(input.classify.rawClassifier)
  const baseDeps = replay
    ? {
        classify: async () => replay,
        classifierIdentity: { kind: "replay" },
      }
    : {}

  if (refusal || !target.ok || !host) {
    const rec = escalation({
      status: "refused",
      reason: refusal ?? "escalation target unavailable",
      wait: "none",
    })
    const decision = await decide(
      p.policy,
      input.evidence,
      {
        ...baseDeps,
        escalate: async () => ({ ok: false as const, error: `refused before spawn — ${rec.reason}` }),
        escalationIdentity: "refused",
      },
      { cache: false },
    )
    return {
      ok: true as const,
      settled: decision.status === "decided",
      decision,
      escalation: rec,
      trace: trace("escalate", input, p, { decisionSource: decision.source, note: rec.reason }),
    }
  }

  const bounded = createBoundedEscalation({
    host,
    target,
    choices: p.policy.choices,
    timeoutMs: p.profile.escalation.timeoutMs,
    owner: { runId: p.runId, workflowId: DECISION_WORKFLOW_ID, stepId: "escalate" },
    label: `decision escalation (${p.runId})`,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    commandSandbox: "workspace",
    ...(input.signal ? { signal: input.signal } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  const decision = await decide(
    p.policy,
    input.evidence,
    {
      ...baseDeps,
      escalate: bounded.escalate,
      escalationIdentity: `${target.adapter}:${target.model}`,
    },
    { cache: false },
  )
  const rec = bounded.record()
  return {
    ok: true as const,
    settled: decision.status === "decided",
    decision,
    escalation: rec,
    trace: trace("escalate", input, p, {
      decisionSource: decision.source,
      harness: rec.adapter ?? target.adapter,
      model: rec.actualModel ?? rec.model ?? target.model,
      wait: rec.wait,
      ...(rec.reason ? { note: rec.reason } : {}),
    }),
  }
}

// ── 5. select-review (choice → binding, preflighted) ──────────────────────

export interface SelectStageInput extends StageContext {
  /** The escalate stage output (its `decision` is the final closed choice). */
  readonly escalate: { readonly ok?: boolean; readonly decision?: DecisionOutcome | null }
  readonly cwd: string
  readonly manifestPath?: string
  /** Closed choice → review binding name (bindings name a check; the check
   *  names a preset — never a model id here). */
  readonly bindings: Record<string, string>
  /** Under a free-only profile, a choice listed here uses this binding instead. */
  readonly freeBindings?: Record<string, string>
}

export interface PreflightedTarget {
  readonly check: string
  readonly role: "preset" | "fallback" | "recovery"
  readonly preset: string
  readonly adapter?: string
  readonly model?: string
  readonly profileRef?: string
  readonly ok: boolean
  readonly code?: string
  readonly reason?: string
}

export async function stageSelectReview(input: SelectStageInput, deps: DecisionWorkflowDeps = {}) {
  const p = prepare(input)
  if (!p.ok) return failed("select-review", p)
  const decision = input.escalate.decision ?? null
  const refuse = (state: "refused" | "no-decision", reason: string, extra: Record<string, unknown> = {}) => ({
    ok: true as const,
    ready: false,
    state,
    reason,
    choice: decision?.choice ?? null,
    decisionStatus: decision?.status ?? null,
    binding: null,
    targets: [] as PreflightedTarget[],
    ...extra,
    trace: trace("select-review", input, p, { decisionSource: decision?.source, note: reason }),
  })
  if (!decision) return refuse("no-decision", "no decision reached this stage")

  const free = p.profile.entitlement === "free-only"
  const bindingName = (free ? input.freeBindings?.[decision.choice] : undefined) ?? input.bindings[decision.choice]
  if (!bindingName) {
    return refuse("refused", `choice "${decision.choice}" has no review binding mapping`)
  }

  let manifest: ReviewManifest
  try {
    manifest = await (deps.loadManifest ?? defaultLoadManifest)(input.cwd, input.manifestPath)
  } catch (e) {
    return refuse("refused", `review manifest not loadable: ${e instanceof Error ? e.message : String(e)}`)
  }
  let binding
  try {
    binding = resolveBinding(manifest, bindingName)
  } catch (e) {
    return refuse("refused", e instanceof Error ? e.message : String(e))
  }

  const lookups = deps.presetLookups ?? {}
  const targets: PreflightedTarget[] = []
  const check = async (
    checkId: string,
    role: PreflightedTarget["role"],
    preset: string,
    override?: { model?: string; profile?: string },
  ) => {
    const r: ResolvedTarget = await resolveAndValidateTarget(p.profile, { preset }, lookups, override)
    targets.push(
      r.ok
        ? {
            check: checkId,
            role,
            preset,
            ok: true,
            adapter: r.adapter,
            model: r.model,
            ...(r.profileRef ? { profileRef: r.profileRef } : {}),
          }
        : { check: checkId, role, preset, ok: false, code: r.code, reason: r.reason },
    )
  }

  for (const id of [...binding.prepare, ...binding.checks]) {
    let c
    try {
      c = getCheck(manifest, id)
    } catch (e) {
      return refuse("refused", e instanceof Error ? e.message : String(e))
    }
    if (c.kind !== "agent") continue
    await check(c.id, "preset", c.preset)
    for (const fb of c.fallbackPresets) await check(c.id, "fallback", fb)
  }
  // The review host's verdict-recovery step is a model call too — a paid
  // recovery preset or role override is refused like a paid lane.
  const hasAgentLane = targets.length > 0
  const recovery = hasAgentLane ? deps.getRecovery?.() : undefined
  if (recovery) {
    for (const preset of recovery.presets) await check("(recovery)", "recovery", preset, recovery.model)
  }

  const bad = targets.filter(t => !t.ok)
  if (bad.length > 0) {
    return refuse(
      "refused",
      `profile ${p.profile.id} (${p.profile.entitlement}) refuses ${bad.length} reviewer target(s) of binding "${bindingName}" — nothing is substituted`,
      { binding: bindingName, targets },
    )
  }
  return {
    ok: true as const,
    ready: true,
    state: "ready" as const,
    reason: `choice "${decision.choice}" → binding "${bindingName}"`,
    choice: decision.choice,
    decisionStatus: decision.status,
    binding: bindingName,
    targets,
    trace: trace("select-review", input, p, { decisionSource: decision.source }),
  }
}

async function defaultLoadManifest(cwd: string, manifestPath?: string): Promise<ReviewManifest> {
  const { root } = await resolveRepo(cwd)
  const path = manifestPath ? resolve(cwd, manifestPath) : join(root, "REVIEW.md")
  const source = await readFile(path, "utf8")
  const parsed = parseReviewManifest(source)
  const loader = createReviewPackLoader({ repoRoot: root, manifestDir: dirname(path) })
  return (await resolvePacks(parsed, loader)).manifest
}

// ── 6. run-review (shadow by default) ─────────────────────────────────────

export interface RunReviewStageInput extends StageContext {
  readonly select: { readonly ready?: boolean; readonly binding?: string | null; readonly state?: string; readonly reason?: string }
  readonly range?: { readonly baseSha?: string; readonly headSha?: string } | null
  readonly cwd: string
  readonly manifestPath?: string
  readonly mode?: DecisionRouteMode
  readonly requesterSessionId?: string
  readonly nocache?: boolean
  readonly pr?: ReviewRunInput["pr"]
}

const REVIEW_CANCEL_GRACE_MS = 10_000

function laneSummary(run: ReviewRun) {
  return run.lanes.map(l => ({
    id: l.id,
    kind: l.kind,
    status: l.status,
    blocking: l.blocking,
    ...(l.preset ? { preset: l.preset } : {}),
    ...(l.model ? { model: l.model } : {}),
    ...(l.sessionId ? { sessionId: l.sessionId } : {}),
    ...(l.error ? { error: l.error } : {}),
    fallbacks: l.fallbacks?.length ?? 0,
    ...(l.recovery ? { recovery: l.recovery } : {}),
  }))
}

export async function stageRunReview(input: RunReviewStageInput, deps: DecisionWorkflowDeps = {}) {
  const p = prepare(input)
  if (!p.ok) return failed("run-review", p)
  const mode: DecisionRouteMode = input.mode === "enforce" ? "enforce" : "shadow"
  const idle = (state: string, reason: string) => ({
    ok: true as const,
    started: false,
    mode,
    state,
    reason,
    binding: input.select.binding ?? null,
    review: null,
    trace: trace("run-review", input, p, { note: reason }),
  })
  if (input.select.ready !== true) {
    return idle("not-started", `review not started: ${input.select.reason ?? input.select.state ?? "selection not ready"}`)
  }
  if (mode === "shadow") {
    return idle("shadow", `shadow mode — would run binding "${input.select.binding}"; no review lane was spawned`)
  }
  const runner = deps.reviewRunner
  if (!runner) return idle("not-started", "no review runner is wired")

  const started = (deps.now ?? Date.now)()
  let run: ReviewRun
  try {
    run = runner.start({
      cwd: input.cwd,
      ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
      binding: input.select.binding as string,
      ...(input.range?.baseSha ? { base: input.range.baseSha } : {}),
      ...(input.range?.headSha ? { head: input.range.headSha } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      requesterSessionId: input.requesterSessionId ?? input.parentSessionId ?? "",
      ...(input.nocache ? { nocache: true } : {}),
      ...(input.pr ? { pr: input.pr } : {}),
    } as ReviewRunInput)
  } catch (e) {
    return idle("failed", `review failed to start: ${e instanceof Error ? e.message : String(e)}`)
  }

  const deadlineMs = p.profile.review.timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted = false
  let onAbort: (() => void) | undefined
  const deadline = new Promise<"deadline">(resolveDeadline => {
    timer = setTimeout(() => resolveDeadline("deadline"), deadlineMs)
  })
  const abort = new Promise<"abort">(resolveAbort => {
    if (!input.signal) return
    onAbort = () => resolveAbort("abort")
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener("abort", onAbort, { once: true })
  })
  let settled: ReviewRun | undefined | "deadline" | "abort"
  try {
    settled = await Promise.race([runner.wait(run.runId), deadline, abort])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) input.signal?.removeEventListener("abort", onAbort)
  }

  let cancelled: "deadline" | "abort" | undefined
  if (settled === "deadline" || settled === "abort") {
    cancelled = settled
    aborted = true
    runner.cancel(run.runId)
    // Cancellation settles the run record; wait a bounded grace for it.
    let grace: ReturnType<typeof setTimeout> | undefined
    const settledAfterCancel = await Promise.race([
      runner.wait(run.runId),
      new Promise<undefined>(r => {
        grace = setTimeout(() => r(undefined), REVIEW_CANCEL_GRACE_MS)
      }),
    ]).finally(() => grace && clearTimeout(grace))
    settled = settledAfterCancel ?? run
  }
  const finalRun = (settled && typeof settled === "object" ? settled : run) as ReviewRun
  const lanes = laneSummary(finalRun)
  const fallbackCount = lanes.reduce((n, l) => n + l.fallbacks, 0)
  const recoveryCount = lanes.filter(l => l.recovery).length
  return {
    ok: true as const,
    started: true,
    mode,
    state: aborted ? (cancelled === "deadline" ? "deadline" : "cancelled") : finalRun.status,
    binding: input.select.binding ?? null,
    review: {
      runId: finalRun.runId,
      status: finalRun.status,
      verdict: finalRun.attestation?.verdict ?? null,
      cached: finalRun.cached === true,
      lanes,
      ...(finalRun.error ? { error: finalRun.error } : {}),
      durationMs: (deps.now ?? Date.now)() - started,
    },
    trace: trace("run-review", input, p, {
      wait: cancelled ? "review-deadline" : "review",
      fallbackCount,
      recoveryCount,
      ...(cancelled ? { note: `review ${cancelled === "deadline" ? "deadline reached" : "aborted"}; run cancelled` } : {}),
    }),
  }
}

// ── 7. validate-verdict ───────────────────────────────────────────────────

export type RouteState =
  | "completed"
  | "provider-unavailable"
  | "human-input-required"
  | "incomplete"
  | "timeout"
  | "cancelled"
  | "refused"
  | "failed"
  | "shadow"

export interface ValidateStageInput extends StageContext {
  readonly escalate: { readonly decision?: DecisionOutcome | null; readonly escalation?: EscalationRecord }
  readonly select: { readonly ready?: boolean; readonly state?: string; readonly reason?: string; readonly binding?: string | null; readonly targets?: readonly PreflightedTarget[] }
  readonly review: {
    readonly started?: boolean
    readonly mode?: string
    readonly state?: string
    readonly reason?: string
    readonly review?: {
      readonly status?: string
      readonly verdict?: string | null
      readonly lanes?: ReadonlyArray<{
        readonly id: string
        readonly kind?: string
        readonly status: string
        readonly blocking?: boolean
        readonly preset?: string
        readonly model?: string
        readonly error?: string
        readonly fallbacks?: number
        readonly recovery?: { readonly outcome: string }
      }>
    } | null
  }
}

/** Fold everything into ONE report. Approval requires an actual passing
 *  verdict from lanes that stayed inside the profile; every other outcome is a
 *  separately named state, never an approval. */
export function stageValidateVerdict(input: ValidateStageInput) {
  const p = prepare(input)
  if (!p.ok) return failed("validate-verdict", p)
  const decision = input.escalate.decision ?? null
  const esc = input.escalate.escalation
  const rv = input.review.review ?? null
  const lanes = rv?.lanes ?? []
  const fallbackCount = lanes.reduce((n, l) => n + (l.fallbacks ?? 0), 0)
  const recoveryCount = lanes.filter(l => l.recovery).length
  const unrecovered = lanes.filter(l => l.recovery && !["recovered", "followup"].includes(l.recovery.outcome))

  // Post-hoc audit: every agent lane must have run on a preset the preflight
  // validated, and (free-only) on a model the profile permits.
  const violations: string[] = []
  const validated = new Map((input.select.targets ?? []).filter(t => t.ok).map(t => [t.preset, t]))
  for (const lane of lanes) {
    if (lane.kind !== "agent" || lane.status === "skipped") continue
    if (lane.preset && validated.size > 0 && !validated.has(lane.preset)) {
      violations.push(`lane ${lane.id} ran on preset "${lane.preset}", which was not preflighted`)
      continue
    }
    const t = lane.preset ? validated.get(lane.preset) : undefined
    if (lane.model && t?.adapter) {
      const v = validateSpawnTarget(p.profile, { adapter: t.adapter, model: lane.model })
      if (!v.ok) violations.push(`lane ${lane.id} reported model "${lane.model}": ${v.reason}`)
    }
  }

  let state: RouteState
  let reason: string
  if (input.review.mode === "shadow" || input.review.state === "shadow") {
    state = "shadow"
    reason = input.review.reason ?? "shadow mode"
  } else if (input.select.ready !== true) {
    state = "refused"
    reason = input.select.reason ?? "review selection not ready"
  } else if (esc?.wait === "human-input-required") {
    state = "human-input-required"
    reason = esc.reason ?? "the escalation session asked for human input"
  } else if (!input.review.started) {
    state = "failed"
    reason = input.review.reason ?? "review did not start"
  } else if (input.review.state === "deadline") {
    state = "timeout"
    reason = "review deadline reached; the run was cancelled"
  } else if (input.review.state === "cancelled") {
    state = "cancelled"
    reason = "review was cancelled"
  } else if (violations.length > 0) {
    state = "failed"
    reason = `profile violation: ${violations.join("; ")}`
  } else if (rv?.status === "failed") {
    state = "failed"
    reason = "review run failed"
  } else if (rv?.status === "done" && (rv.verdict === "pass" || rv.verdict === "block")) {
    state = "completed"
    reason = `review verdict ${rv.verdict}`
  } else if (lanes.some(l => l.status === "skipped" && (l.recovery?.outcome === "unavailable" || (l.fallbacks ?? 0) > 0))) {
    state = "provider-unavailable"
    reason = "a reviewer provider was unavailable — the review is incomplete, not approved"
  } else if (lanes.some(l => l.status === "timeout")) {
    state = "timeout"
    reason = "a review lane timed out — the review is incomplete, not approved"
  } else {
    state = "incomplete"
    reason = rv?.status === "done" ? "review verdict incomplete" : "review did not settle"
  }

  const approved = state === "completed" && rv?.verdict === "pass"
  return {
    ok: true as const,
    approved,
    state,
    reason,
    verdict: rv?.verdict ?? null,
    choice: decision?.choice ?? null,
    decisionStatus: decision?.status ?? null,
    decisionSource: decision?.source ?? null,
    binding: input.select.binding ?? null,
    fallbackCount,
    recoveryCount,
    unrecoveredLanes: unrecovered.map(l => ({ id: l.id, outcome: l.recovery?.outcome })),
    violations,
    escalation: esc ?? null,
    trace: trace("validate-verdict", input, p, {
      ...(decision ? { decisionSource: decision.source } : {}),
      wait: esc && esc.wait !== "none" && esc.status !== "decided" ? esc.wait : "none",
      fallbackCount,
      recoveryCount,
      note: reason,
    }),
  }
}

// ── MCP registration ──────────────────────────────────────────────────────

const profileShape = {
  policy: z.string().min(1).describe("The DECISION.md contents (criteria / closed choices / uncertainty)."),
  profile: z
    .string()
    .optional()
    .describe("Execution profile: `local-free` (default; alias free-only) or `remote-sonnet` (alias subscription)."),
  profileOptions: z
    .object({
      jev: z.boolean().optional(),
      escalation: z
        .object({
          preset: z.string().optional(),
          adapter: z.string().optional(),
          model: z.string().optional(),
          profileRef: z.string().optional(),
          roleDefault: z.boolean().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      reviewTimeoutMs: z.number().int().positive().optional(),
    })
    .optional()
    .describe("Narrow a profile's escalation target / budgets. Cannot change its entitlement."),
  runWorkspace: z.string().optional().describe("`$run.workspace` of the calling workflow run (derives the run id)."),
  parentSessionId: z.string().optional().describe("Session that owns the workflow run; spawned sessions nest under it."),
}

const asJson = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })

/** Never an MCP error for a stage: an exception becomes `{ ok:false }` data. */
async function guarded<T>(step: string, fn: () => Promise<T> | T) {
  try {
    return asJson(await fn())
  } catch (e) {
    return asJson({ ok: false, step, error: e instanceof Error ? e.message : String(e) })
  }
}

export function registerDecisionWorkflowTools(server: McpServer, deps: DecisionWorkflowDeps = {}): void {
  const ctxOf = (
    i: Omit<StageContext, "signal">,
    extra: { signal?: AbortSignal } | undefined,
  ): StageContext => ({ ...i, ...(extra?.signal ? { signal: extra.signal } : {}) })

  server.tool(
    "decision_collect_evidence",
    "Step 1 of `decision-route`: collect BOUNDED metadata evidence for a git range " +
      "(counts, change types, risk categories, completeness) — never code or hunks; " +
      "paths only if the DECISION.md evidence policy opts in; secrets scrubbed. " +
      "Returns the frozen range and a stage `trace`. Failures come back as data.",
    {
      ...profileShape,
      policy: z.string().min(1).optional().describe("The DECISION.md contents. Or pass `policyPath`."),
      policyPath: z.string().optional().describe("DECISION.md path relative to `cwd`; the text is echoed back as `policy`."),
      cwd: z.string().describe("Directory inside the repo to read the range from."),
      base: z.string().optional(),
      head: z.string().optional(),
      supplied: z.record(z.string(), z.unknown()).optional().describe("Consumer-built evidence (same export policy applies)."),
    },
    (i, extra) => guarded("collect-evidence", () => stageCollectEvidence({ ...ctxOf({ ...i, policy: i.policy ?? "" }, extra), policy: i.policy, ...(i.policyPath ? { policyPath: i.policyPath } : {}), cwd: i.cwd, ...(i.base ? { base: i.base } : {}), ...(i.head ? { head: i.head } : {}), ...(i.supplied ? { supplied: i.supplied } : {}) }, deps)),
  )

  server.tool(
    "decision_stage_rules",
    "Step 2 of `decision-route`: apply the DECISION.md rules/floors with ZERO model calls. " +
      "`settled:true` means a rule decided; otherwise later stages run.",
    { ...profileShape, evidence: z.record(z.string(), z.unknown()) },
    (i, extra) => guarded("apply-rules", () => stageRules({ ...ctxOf(i, extra), evidence: i.evidence })),
  )

  server.tool(
    "decision_stage_classify",
    "Step 3 of `decision-route`: ONE unresolved-case Jev direct-API classification (no retries, " +
      "profile-gated). Skipped when rules settled it, the policy disables the classifier or the " +
      "profile disables Jev. Normal low confidence is NOT a human request — it flows to escalation.",
    { ...profileShape, evidence: z.record(z.string(), z.unknown()), rules: z.record(z.string(), z.unknown()) },
    (i, extra) => guarded("classify", () => stageClassify({ ...ctxOf(i, extra), evidence: i.evidence, rules: i.rules }, deps)),
  )

  server.tool(
    "decision_stage_escalate",
    "Step 4 of `decision-route`: at most ONE escalation through the configured agent harness, " +
      "only when still unresolved. The execution profile validates adapter+model (incl. rotate " +
      "fallbacks, auth profile, OpenRouter) BEFORE spawn; unknown identity fails closed; placement " +
      "(e.g. E2B) grants no entitlement. The session is read-only-posture with no MCP servers; " +
      "`escalation.toolControls` reports configured vs enforced limits honestly (the harness's " +
      "built-in tools are not disabled).",
    {
      ...profileShape,
      evidence: z.record(z.string(), z.unknown()),
      classify: z.record(z.string(), z.unknown()),
      rules: z.record(z.string(), z.unknown()),
    },
    (i, extra) =>
      guarded("escalate", () =>
        stageEscalate({ ...ctxOf(i, extra), evidence: i.evidence, classify: i.classify, rules: i.rules }, deps),
      ),
  )

  server.tool(
    "decision_select_review",
    "Step 5 of `decision-route`: map the closed choice to a review BINDING (not a model id) and " +
      "preflight every reviewer preset, fallback preset and recovery preset/role override of that " +
      "binding against the profile. Any non-entitled target refuses the whole selection — nothing is " +
      "substituted, and a conservative deep route cannot bypass the profile.",
    {
      ...profileShape,
      escalate: z.record(z.string(), z.unknown()),
      cwd: z.string(),
      manifestPath: z.string().optional(),
      bindings: z.record(z.string(), z.string()).optional().describe("Default: skip/light→light, standard→local, deep→deep."),
      freeBindings: z.record(z.string(), z.string()).optional().describe("Free-only overrides. Default: deep→deep-free."),
    },
    (i, extra) =>
      guarded("select-review", () =>
        stageSelectReview(
          {
            ...ctxOf(i, extra),
            escalate: i.escalate,
            cwd: i.cwd,
            bindings: i.bindings ?? DEFAULT_BINDINGS,
            freeBindings: i.freeBindings ?? DEFAULT_FREE_BINDINGS,
            ...(i.manifestPath ? { manifestPath: i.manifestPath } : {}),
          },
          deps,
        ),
      ),
  )

  server.tool(
    "decision_run_review",
    "Step 6 of `decision-route`: run the selected review binding through the review runner. " +
      "`mode: \"shadow\"` (default) starts NOTHING and only reports what would run; `\"enforce\"` " +
      "starts the review with a profile deadline and cancels it on deadline/abort.",
    {
      ...profileShape,
      select: z.record(z.string(), z.unknown()),
      range: z.record(z.string(), z.unknown()).nullable().optional(),
      cwd: z.string(),
      manifestPath: z.string().optional(),
      mode: z.enum(["shadow", "enforce"]).optional(),
      requesterSessionId: z.string().optional(),
      nocache: z.boolean().optional(),
    },
    (i, extra) =>
      guarded("run-review", () =>
        stageRunReview(
          {
            ...ctxOf(i, extra),
            select: i.select,
            range: (i.range ?? null) as RunReviewStageInput["range"],
            cwd: i.cwd,
            ...(i.manifestPath ? { manifestPath: i.manifestPath } : {}),
            ...(i.mode ? { mode: i.mode } : {}),
            ...(i.requesterSessionId ? { requesterSessionId: i.requesterSessionId } : {}),
            ...(i.nocache ? { nocache: true } : {}),
          },
          deps,
        ),
      ),
  )

  server.tool(
    "decision_validate_verdict",
    "Step 7 of `decision-route`: fold the decision, escalation and review into one report. " +
      "`approved` is true only for a real passing verdict from lanes that stayed inside the " +
      "profile; completed / provider-unavailable / human-input-required / incomplete / timeout / " +
      "cancelled / refused / failed / shadow are separate states, never approvals.",
    {
      ...profileShape,
      escalate: z.record(z.string(), z.unknown()),
      select: z.record(z.string(), z.unknown()),
      review: z.record(z.string(), z.unknown()),
    },
    (i, extra) =>
      guarded("validate-verdict", () =>
        stageValidateVerdict({
          ...ctxOf(i, extra),
          escalate: i.escalate,
          select: i.select,
          review: i.review,
        }),
      ),
  )
}
