/**
 * The step-walker. Executes a {@link RuntimeWorkflow} top-to-bottom, threading
 * each step's output into a run-scoped binding bag, and dispatching `tool`
 * steps through `@agentproto/driver` `runTool` (resolve DRIVER → validate input
 * + context → execute body → validate output). Composite steps (`map` /
 * `branch` / `loop` / `parallel` / `approval` / `subworkflow`) recurse over the
 * same bindings; `suspend` defers to the host's resume hook.
 */

import { runTool } from "@agentproto/driver"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { resolveRefString } from "./ref-string.js"
import type {
  AgentStep,
  ApprovalDecision,
  Bindings,
  FanOutOutcome,
  GateCommandResult,
  GateStep,
  KnowledgeAppliedRecord,
  OutputSchemaLike,
  RunStep,
  RunWorkflowArgs,
  RuntimeWorkflow,
  StepHookInfo,
  TolerantFanOutResult,
  WorkflowRunResult,
} from "./types.js"
import { materializeKnowledge, resolveKnowledgeSelectors } from "./knowledge.js"

/** Thrown by a `suspend` step when no host `resume` hook is provided. */
export class WorkflowSuspendedError extends Error {
  constructor(
    readonly stepId: string,
    readonly on: readonly string[],
  ) {
    super(
      `workflow suspended at step '${stepId}' awaiting [${on.join(", ")}] — ` +
        `no resume hook supplied`,
    )
    this.name = "WorkflowSuspendedError"
  }
}

/**
 * AIP-58 §3(a) — thrown when an {@link AgentStep}'s session signals
 * `run.requestInput` but no host `onInputRequired` hook is provided (the
 * same "no resume hook supplied" shape {@link WorkflowSuspendedError} uses
 * for {@link SuspendStep}). A host that wires `onInputRequired` never sees
 * this thrown — it durably suspends the step instead.
 */
export class AgentInputRequiredError extends Error {
  constructor(
    readonly stepId: string,
    readonly prompt: string,
    readonly schema?: Record<string, unknown>,
  ) {
    super(
      `step '${stepId}' requires input ("${prompt}") — no onInputRequired hook supplied`,
    )
    this.name = "AgentInputRequiredError"
  }
}

/**
 * AIP-58 §3 Outcome rule — thrown when an {@link AgentStep} declares an
 * `outputSchema` and its turn ends (after exhausting retries) without ever
 * producing output that validates against it, and no explicit
 * input-required signal (§3(a)/(b)) was observed either. `hint` is set when
 * the final message matches the "trailing question mark" heuristic — it is
 * ONLY a triage aid; it never changes the outcome (still `missing-output`).
 */
export class StepOutcomeError extends Error {
  constructor(
    readonly stepId: string,
    readonly code: "missing-output",
    message: string,
    readonly hint?: "possible-input-request",
  ) {
    super(message)
    this.name = "StepOutcomeError"
  }
}

interface RunState {
  readonly input: unknown
  readonly steps: Record<string, unknown>
  readonly maxTotalCostUsd?: number
  /** Last-known cost per session id; summed to get the run's total spend.
   *  A Map (not a running delta) so a session reused across steps via
   *  sessionRef is counted once, not double-counted. */
  readonly costBySession: Map<string, number>
  /** Journal keys ({@link cachedHitKey}) of steps whose output was replayed
   *  from the cache this run and whose completion hasn't been reported yet —
   *  consumed by {@link completeStep} to tag `onStepComplete` with
   *  `{ cached: true }` (F35). */
  readonly cachedHits: Set<string>
}

interface RunCtx {
  readonly state: RunState
  readonly approve?: RunWorkflowArgs["approve"]
  readonly resume?: RunWorkflowArgs["resume"]
  readonly onInputRequired?: RunWorkflowArgs["onInputRequired"]
  readonly signal?: AbortSignal
  readonly agents?: RunWorkflowArgs["agents"]
  readonly cwd?: string
  readonly workspaceSlug?: string
  readonly cache?: RunWorkflowArgs["cache"]
  readonly cacheKey?: RunWorkflowArgs["cacheKey"]
  /** Set inside a `map`/`pipeline` fan-out body — the `[<index>]` path
   *  (nested maps append their own `[<index>]`) appended to every cache
   *  journal key computed under this ctx, so each item of a shared-id
   *  body caches independently instead of overwriting one shared entry
   *  (F33). Mirrors the id-suffixing {@link withIndexedHooks} already does
   *  for `onStepStart`/`onStepComplete`. */
  readonly cacheKeySuffix?: string
  readonly onStepStart?: RunWorkflowArgs["onStepStart"]
  readonly onStepComplete?: RunWorkflowArgs["onStepComplete"]
  readonly runGateCommand?: RunWorkflowArgs["runGateCommand"]
  readonly onGateReport?: RunWorkflowArgs["onGateReport"]
}

function view(state: RunState, item?: unknown, index?: number): Bindings {
  return { input: state.input, steps: state.steps, item, index }
}

/**
 * A `map`/`pipeline` fan-out body can't be enumerated at compile time (the
 * item list is only known at runtime — see `collectStaticSteps` in
 * `runtime/workflow-runner.ts`), so its per-item steps all share one static
 * compiled id (e.g. "clean"). Reporting every iteration under that same id
 * makes the host's step list unable to tell iterations apart (AIP-58 §5 /
 * F28). Wrapping `onStepStart`/`onStepComplete` for the duration of ONE
 * item's execution suffixes every step id it reports with `[<index>]`
 * (e.g. "clean[0]", "clean[1]") — the host discovers these dynamically,
 * same as any other step it didn't see at compile time.
 */
function withIndexedHooks(ctx: RunCtx, index: number): RunCtx {
  const cacheKeySuffix = `${ctx.cacheKeySuffix ?? ""}[${index}]`
  if (!ctx.onStepStart && !ctx.onStepComplete) return { ...ctx, cacheKeySuffix }
  return {
    ...ctx,
    cacheKeySuffix,
    onStepStart: ctx.onStepStart
      ? (id: string, info?: StepHookInfo) => ctx.onStepStart!(`${id}[${index}]`, info)
      : undefined,
    onStepComplete: ctx.onStepComplete
      ? (id: string, out: unknown, info?: StepHookInfo) => ctx.onStepComplete!(`${id}[${index}]`, out, info)
      : undefined,
  }
}

/** Resolve a value that is either a static string or a binding selector. */
function resolveSel(sel: string | ((bindings: Bindings) => string), b: Bindings): string {
  return typeof sel === "function" ? sel(b) : sel
}

/** Extract a JSON candidate from raw assistant text:
 *  1. last ```json fenced block if present, else
 *  2. last generic ``` fenced block if present, else
 *  3. the whole trimmed string. */
function extractJsonCandidate(raw: string): string {
  const jsonFence = /```json\s*([\s\S]*?)```/g
  const lastJson = lastMatch(jsonFence, raw)
  if (lastJson !== undefined) return lastJson

  const anyFence = /```\s*([\s\S]*?)```/g
  const lastAny = lastMatch(anyFence, raw)
  if (lastAny !== undefined) return lastAny

  return raw.trim()
}

function lastMatch(re: RegExp, s: string): string | undefined {
  let m: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((m = re.exec(s)) !== null) last = m
  return last ? last[1]?.trim() : undefined
}

function spentUsd(state: RunState): number {
  let total = 0
  for (const c of state.costBySession.values()) total += c
  return total
}

/** Deterministic content hash of a step's resolved inputs. */
function hashResolvedInputs(kind: string, resolved: unknown): string {
  return createHash("sha256")
    .update(`${kind}\u0000${JSON.stringify(resolved) ?? "undefined"}`)
    .digest("hex")
}

/** Namespaced journal key for a step under a run's cacheKey. A step inside a
 *  `map`/`pipeline` body shares its static compiled id (and kind) across
 *  every item — `ctx.cacheKeySuffix` (the item's `[<index>]` path, set by
 *  {@link withIndexedHooks}) disambiguates them so each item's cache entry
 *  is independent instead of every item overwriting one shared key (F33). */
function stepJournalKey(ctx: RunCtx, step: RunStep): string {
  return `${ctx.cacheKey}\u0000${step.id}\u0000${step.kind}${ctx.cacheKeySuffix ?? ""}`
}

/** True when this step should consult/populate the journal. */
function isCacheEnabled(ctx: RunCtx, step: { cacheable?: boolean }): boolean {
  return step.cacheable === true && ctx.cache !== undefined && ctx.cacheKey !== undefined
}

/** Identity of one step execution under `ctx` for {@link RunState.cachedHits}
 *  — the step id plus the map/pipeline item path, so concurrent items of a
 *  shared-id body don't see each other's hits. */
function cachedHitKey(ctx: RunCtx, stepId: string): string {
  return `${stepId}${ctx.cacheKeySuffix ?? ""}`
}

/** Report a step's completion — `{ cached: true }` when {@link execStep}
 *  replayed it from the journal (F35: a cache hit still surfaces as a step). */
function completeStep(ctx: RunCtx, stepId: string, out: unknown): void {
  const cached = ctx.state.cachedHits.delete(cachedHitKey(ctx, stepId))
  ctx.onStepComplete?.(stepId, out, cached ? { cached: true } : undefined)
}

/** Read the journal; on a hit return the output, else the key+hash to write on miss. */
async function readStepCache(
  ctx: RunCtx,
  step: RunStep,
  resolvedInputs: unknown,
): Promise<{ hit: true; output: unknown } | { hit: false; key: string; hash: string }> {
  const key = stepJournalKey(ctx, step)
  const hash = hashResolvedInputs(step.kind, resolvedInputs)
  const entry = await ctx.cache!.get(key)
  if (entry !== undefined && entry.resolvedInputHash === hash) {
    return { hit: true, output: entry.output }
  }
  return { hit: false, key, hash }
}

/** `err.message` if `err` is an `Error`, else its string coercion. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Formats the failure branch of {@link OutputSchemaLike.safeParse} — a real
 *  zod `ZodError` satisfies this structurally (its `issues[]` carry `path`/
 *  `message` plus extra fields TS ignores here), so this reads either a zod
 *  schema's rejection or the ajv-backed JSON Schema adapter's. */
function formatSchemaError(err: Extract<ReturnType<OutputSchemaLike["safeParse"]>, { success: false }>["error"]): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join(", ")
}

/**
 * F27: render an agent step's `outputSchema` into a prompt-affordance note —
 * appended to BOTH the first prompt and every retry, so the model sees the
 * contract before it ever replies, not just after a rejected first attempt.
 * Prefers the exact schema: `compileOutputSchema`'s `jsonSchema` marker for a
 * WORKFLOW.md-authored step, else a live zod schema's own `z.toJSONSchema()`
 * (a TS-authored `buildAgentStep` caller commonly passes one directly — see
 * `OutputSchemaLike`'s doc). Degrades to a short field list when neither
 * conversion is possible (an exotic zod type, or a hand-built
 * `OutputSchemaLike` with no `jsonSchema` marker) — never throws, since a
 * step's prompt must never fail to build over an unrelated schema quirk.
 */
function describeOutputSchemaForPrompt(schema: OutputSchemaLike): string | undefined {
  if (schema.jsonSchema !== undefined) {
    return `When done, reply with ONLY a JSON object matching this JSON Schema: ${JSON.stringify(schema.jsonSchema)}`
  }
  try {
    const jsonSchema = z.toJSONSchema(schema as unknown as z.ZodType)
    return `When done, reply with ONLY a JSON object matching this JSON Schema: ${JSON.stringify(jsonSchema)}`
  } catch {
    // Not a convertible zod schema — fall through to the short field list.
  }
  const shape = (schema as { shape?: unknown }).shape
  if (shape && typeof shape === "object") {
    const fields = Object.keys(shape)
    if (fields.length > 0) {
      return `When done, reply with ONLY a JSON object with these fields: ${fields.join(", ")}`
    }
  }
  return undefined
}

/** Run an ordered list of steps, binding each output under its id; return last. */
async function runSequence(
  steps: readonly RunStep[],
  ctx: RunCtx,
  item: unknown,
  index: number | undefined,
): Promise<unknown> {
  let last: unknown
  for (const s of steps) {
    const out = await execStep(s, ctx, item, index)
    ctx.state.steps[s.id] = out
    completeStep(ctx, s.id, out)
    last = out
  }
  return last
}

/**
 * Send a prompt and wait for the turn to end; if the session signals AIP-58
 * §3(a) (`run.requestInput`) before this returns, durably suspend via
 * `ctx.onInputRequired` — the promise only resolves once an external event
 * supplies the resume payload — then forward that payload (JSON) as the
 * step's NEXT prompt to the SAME session and repeat. So a step may suspend,
 * resume, and suspend again before this ever returns to its caller. No
 * signal observed ⇒ an ordinary one-shot send.
 */
async function sendPromptAndAwaitOutcome(
  ctx: RunCtx,
  step: AgentStep,
  sessionId: string,
  prompt: string,
): Promise<void> {
  let next = prompt
  for (;;) {
    await ctx.agents!.sendPromptAndWait(sessionId, next)
    const req = ctx.agents!.takeInputRequest?.(sessionId)
    if (!req) return
    if (!ctx.onInputRequired) {
      throw new AgentInputRequiredError(step.id, req.prompt, req.schema)
    }
    const payload = await ctx.onInputRequired({ stepId: step.id, prompt: req.prompt, schema: req.schema })
    next = JSON.stringify(payload)
  }
}

/** Execute the full AgentStep body — spawn, prompt, policy, budget, outputSchema retry loop. */
async function execAgentStep(step: AgentStep, ctx: RunCtx, b: Bindings): Promise<unknown> {
  // Notify step start before any execution
  ctx.onStepStart?.(step.id)

  if (
    step.adapter &&
    ctx.state.maxTotalCostUsd !== undefined &&
    spentUsd(ctx.state) >= ctx.state.maxTotalCostUsd
  ) {
    throw new Error(
      `step '${step.id}': budget_exceeded — run spend $${spentUsd(ctx.state).toFixed(4)} >= cap $${ctx.state.maxTotalCostUsd}`,
    )
  }
  // Harness precedence: step `harness.cwd` (highest, among what this runtime
  // sees) beats the step's own `cwd` selector, which beats the run-level
  // `ctx.cwd` — see `AgentHarness`'s doc for the full chain (AGENT.md
  // frontmatter / app_run args / adapter default are resolved upstream of
  // this runtime, by the host's spawn implementation).
  const cwd = step.harness?.cwd ?? (step.cwd ? resolveSel(step.cwd, b) : ctx.cwd)
  // AIP-15 P2 `harness.knowledge`: materialize matched corpus entries into
  // the step cwd's `.knowledge/` BEFORE the spawn, and prepend the prompt
  // note pointing the session at the INDEX. An empty match is not an error —
  // it's recorded (`matched: 0`) and surfaced as a harness warning after the
  // spawn gives us a session to attribute it to.
  let knowledgeOut: KnowledgeAppliedRecord[] | undefined
  let knowledgeWarnings: readonly string[] = []
  if (step.harness?.knowledge && step.harness.knowledge.length > 0) {
    if (cwd === undefined) {
      throw new Error(
        `step '${step.id}': harness.knowledge requires a resolvable working directory (set step cwd, harness.cwd, or the run cwd)`,
      )
    }
    // Deferred selectors (loader-flagged `$…` refs) resolve per run against
    // the bindings; a relative resolved workspace joins to this run cwd.
    const knowledgeSelectors = resolveKnowledgeSelectors(step.id, step.harness.knowledge, b).map(
      (sel) => ({
        ...sel,
        workspace: isAbsolute(sel.workspace) ? sel.workspace : join(cwd, sel.workspace),
      }),
    )
    const materialized = await materializeKnowledge(step.id, knowledgeSelectors, cwd)
    knowledgeOut = materialized.records
    knowledgeWarnings = materialized.warnings
    if (materialized.written > 0) {
      const note =
        `Knowledge for this step is materialized under .knowledge/ ` +
        `(see .knowledge/INDEX.md, ${materialized.written} entries).`
      const inner = step.prompt
      step = { ...step, prompt: (b: Bindings) => `${note}\n\n${inner(b)}` }
    }
  }
  // Sandbox ref: a selector resolves per-run (undefined ⇒ host spawn); a
  // literal (slug string or inline spec object) passes through as-is.
  const sandbox =
    typeof step.sandbox === "function" ? step.sandbox(b) : step.sandbox
  // Step-level `model` (same semantics as `agent_start.model`): a selector
  // resolves per-run against the bindings. It is folded into the spawn's
  // harness slot — the channel both spawn paths already forward as the
  // session's model — but an explicit `harness.model` pinning (AIP-15 P2)
  // still wins: the block is the more specific pinning layer.
  const model = step.model !== undefined ? resolveSel(step.model, b) : undefined
  const harness =
    step.harness !== undefined || model !== undefined
      ? {
          ...(step.harness ?? {}),
          ...(model !== undefined && step.harness?.model === undefined ? { model } : {}),
        }
      : undefined
  const sessionId = step.adapter
    ? await ctx.agents!.spawn(resolveSel(step.adapter, b), {
        cwd,
        workspaceSlug: ctx.workspaceSlug,
        stepId: step.id,
        ...(sandbox !== undefined ? { sandbox } : {}),
        ...(step.options !== undefined ? { options: step.options } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(step.agentTools !== undefined ? { agentTools: step.agentTools } : {}),
      })
    : ctx.agents!.resolveByLabel(step.sessionRef!)
  if (!sessionId) throw new Error(`step '${step.id}': no session (adapter and sessionRef both unresolved)`)
  if (knowledgeWarnings.length > 0 && ctx.agents!.emitHarnessWarning) {
    ctx.agents!.emitHarnessWarning({
      sessionId,
      warnings: knowledgeWarnings,
      label: step.id,
    })
  }
  // `harness.tools` has no generic per-spawn allowlist mechanism reaching
  // this runtime today (see `AgentHarness.tools`'s doc) — record that
  // honestly on the run record rather than silently dropping the field.
  const harnessOut =
    harness !== undefined
      ? {
          ...harness,
          ...(harness.tools && harness.tools.length > 0
            ? { toolsApplied: false as const }
            : {}),
        }
      : undefined
  // AIP-15 P2 prompt affordance: only when the host actually exposes the
  // `run_request_input` tool (signalled by `takeInputRequest` existing) —
  // a host without it never suspends on this signal, so telling the model
  // to call a tool that doesn't exist would be actively misleading.
  const inputRequestAffordance = ctx.agents!.takeInputRequest
    ? "\n\nIf you need information you don't have, call the run_request_input tool instead of asking in your reply."
    : ""
  // F27: an `outputSchema` step states its contract on the FIRST prompt, not
  // only on a rejected-reply retry — the model should never have to guess
  // the shape and then get corrected.
  const outputSchemaNote = step.outputSchema ? describeOutputSchemaForPrompt(step.outputSchema) : undefined
  const outputSchemaAffordance = outputSchemaNote ? `\n\n${outputSchemaNote}` : ""
  await sendPromptAndAwaitOutcome(ctx, step, sessionId, step.prompt(b) + inputRequestAffordance + outputSchemaAffordance)
  if (step.policy && ctx.agents!.onAwaitingInput) {
    await ctx.agents!.onAwaitingInput(sessionId, step.policy)
  }

  if (ctx.agents!.readCostUsd) {
    ctx.state.costBySession.set(sessionId, await ctx.agents!.readCostUsd(sessionId))
  }

  if (!step.outputSchema) {
    let text: string | undefined
    if (ctx.agents!.readFinalMessage) {
      try {
        text = await ctx.agents!.readFinalMessage(sessionId)
      } catch {
        // ignore
      }
    }
    return { sessionId, ...(text !== undefined ? { text } : {}), ...(harnessOut ? { harness: harnessOut } : {}), ...(knowledgeOut ? { knowledgeApplied: knowledgeOut } : {}) }
  }

  // Validate-and-retry loop
  if (!ctx.agents!.readFinalMessage) {
    throw new Error(`step '${step.id}': outputSchema requires a host with readFinalMessage`)
  }
  const maxRetries = step.maxRetries ?? 2
  let lastErr = ""
  let lastRaw = ""
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await ctx.agents!.readFinalMessage(sessionId)
    lastRaw = raw
    const candidate = extractJsonCandidate(raw)
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      lastErr = "not valid JSON"
      if (attempt < maxRetries) {
        await sendPromptAndAwaitOutcome(
          ctx,
          step,
          sessionId,
          `Your previous reply did not match the required schema: ${lastErr}. ` +
            `Reply again with ONLY a JSON object that matches. No prose, no code fence needed.` +
            outputSchemaAffordance,
        )
      }
      continue
    }
    const res = step.outputSchema.safeParse(value)
    if (res.success) return { sessionId, output: res.data, ...(harnessOut ? { harness: harnessOut } : {}), ...(knowledgeOut ? { knowledgeApplied: knowledgeOut } : {}) }
    lastErr = formatSchemaError(res.error)
    if (attempt < maxRetries) {
      await sendPromptAndAwaitOutcome(
        ctx,
        step,
        sessionId,
        `Your previous reply did not match the required schema: ${lastErr}. ` +
          `Reply again with ONLY a JSON object that matches. No prose, no code fence needed.` +
          outputSchemaAffordance,
      )
    }
  }
  // AIP-58 §3 Outcome rule: a turn ending without producing a validated
  // output is `missing-output`, regardless of how the final message reads.
  // A trailing "?" is ONLY a triage hint — it never upgrades this to
  // `suspended` (that requires one of the two explicit signals above).
  const hint = lastRaw.trim().endsWith("?") ? ("possible-input-request" as const) : undefined
  throw new StepOutcomeError(
    step.id,
    "missing-output",
    `step '${step.id}': missing-output — final message never matched outputSchema (${lastErr})`,
    hint,
  )
}

/** Best-effort `JSON.parse` — `undefined` (never a throw) on blank/invalid text. */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * The runtime's own subprocess runner for `kind: "gate"` steps, used when no
 * `runGateCommand` host hook is injected — a plain `node:child_process`
 * argv-vector invocation (no shell interpolation). Exit code 0 always
 * resolves (never rejects on a non-zero exit); a timeout resolves with
 * `timedOut: true` and whatever partial output was captured.
 */
function defaultRunGateCommand(spec: {
  command: string
  args: readonly string[]
  cwd: string
  timeoutMs?: number
}): Promise<GateCommandResult> {
  return new Promise((resolve) => {
    execFile(
      spec.command,
      [...spec.args],
      { cwd: spec.cwd, timeout: spec.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout, stderr })
          return
        }
        const nodeErr = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }
        const timedOut = nodeErr.killed === true && nodeErr.signal !== undefined && spec.timeoutMs !== undefined
        const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : 1
        resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) })
      },
    )
  })
}

/** Resolve a gate's report: the command's stdout if it parses as JSON, else
 *  the file at `reportPath` (relative to `cwd`), parsed as JSON. `undefined`
 *  when neither yields parseable JSON — never a throw (a gate that emits no
 *  structured report is still a valid pass/fail signal on its own). */
async function resolveGateReport(
  cmd: GateCommandResult,
  cwd: string,
  reportPath: string | undefined,
): Promise<unknown> {
  const fromStdout = tryParseJson(cmd.stdout)
  if (fromStdout !== undefined) return fromStdout
  if (!reportPath) return undefined
  try {
    const abs = isAbsolute(reportPath) ? reportPath : join(cwd, reportPath)
    const raw = await readFile(abs, "utf8")
    return tryParseJson(raw)
  } catch {
    return undefined
  }
}

/**
 * Resolve a gate step's `cwd` against the run bindings. The same string-ref
 * rule as {@link resolveRefString} (leading `$input|$item|$steps.<id>|$index`
 * token + trailing literal text; `$$` escapes a literal `$`; an unresolvable
 * or malformed ref throws naming the step and the field). The RESOLVED cwd is
 * then made absolute: an absolute value stays as-is, a RELATIVE one (incl.
 * `.`) resolves against the run's own `ctx.cwd` — never the daemon process
 * cwd. No `cwd` (or a selector resolving to one) falls back to the run cwd.
 */
function resolveGateCwd(step: GateStep, ctx: RunCtx, b: Bindings): string {
  const fallback = ctx.cwd ?? process.cwd()
  if (!step.cwd) return fallback
  const resolved = resolveRefString(step.id, "cwd", resolveSel(step.cwd, b), b, "error")
  return isAbsolute(resolved) ? resolved : resolve(fallback, resolved)
}

/** Execute the full GateStep body — run, parse report, retry-with-reprompt. */
async function execGateStep(step: GateStep, ctx: RunCtx, b: Bindings): Promise<unknown> {
  const cwd = resolveGateCwd(step, ctx, b)
  const args = (step.args ?? []).map((arg, index) =>
    resolveRefString(step.id, `args[${index}]`, resolveSel(arg, b), b, "error"),
  )
  const maxAttempts = Math.max(1, step.retry?.maxAttempts ?? 1)

  let last: { ok: boolean; exitCode: number; report: unknown } | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && step.onFail?.reprompt) {
      if (!ctx.agents) {
        throw new Error(`step '${step.id}': on_fail.reprompt requires a host agents implementation`)
      }
      const targetSessionId = ctx.agents.resolveByLabel(step.onFail.reprompt)
      if (!targetSessionId) {
        throw new Error(
          `step '${step.id}': on_fail.reprompt targets unknown step '${step.onFail.reprompt}' — no session found`,
        )
      }
      const reportText = JSON.stringify(last?.report ?? null, null, 2)
      const extra = step.onFail.with ? `\n\nAdditional context:\n${JSON.stringify(step.onFail.with, null, 2)}` : ""
      await ctx.agents.sendPromptAndWait(
        targetSessionId,
        `Gate '${step.id}' failed (exit code ${last?.exitCode}). Report:\n${reportText}${extra}\n\n` +
          `Please address the findings above, then reply when done.`,
      )
    }

    if (attempt > 1 && step.retry?.initialMs) {
      const delayMs =
        step.retry.backoff === "exponential"
          ? step.retry.initialMs * 2 ** (attempt - 2)
          : step.retry.initialMs
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    const cmdResult = await (ctx.runGateCommand ?? defaultRunGateCommand)({
      command: step.command,
      args,
      cwd,
      timeoutMs: step.timeoutMs,
    })
    const report = await resolveGateReport(cmdResult, cwd, step.reportPath)
    const ok = cmdResult.exitCode === 0
    last = { ok, exitCode: cmdResult.exitCode, report }
    ctx.onGateReport?.({ stepId: step.id, ok, exitCode: cmdResult.exitCode, report, attempt })
    if (ok) break
  }

  if (!last!.ok) {
    const err = new Error(
      `step '${step.id}': gate failed after ${maxAttempts} attempt(s) — exit code ${last!.exitCode}`,
    ) as Error & { exitCode?: number; report?: unknown }
    err.exitCode = last!.exitCode
    err.report = last!.report
    throw err
  }
  return last
}

/** A cache hit still surfaces as a step (F35): fire `onStepStart` with
 *  `{ cached: true }` and flag it so its completion is tagged too. */
function cacheHit(ctx: RunCtx, step: RunStep, output: unknown): unknown {
  ctx.state.cachedHits.add(cachedHitKey(ctx, step.id))
  ctx.onStepStart?.(step.id, { cached: true })
  return output
}

async function execStep(
  step: RunStep,
  ctx: RunCtx,
  item: unknown,
  index: number | undefined,
): Promise<unknown> {
  const { state, signal } = ctx
  const b = view(state, item, index)

  // Notify step start for non-agent steps (agent steps notify in
  // execAgentStep; a tool step notifies in its case, once it knows whether
  // it's a cache hit).
  if (step.kind !== "agent" && step.kind !== "tool") {
    ctx.onStepStart?.(step.id)
  }

  switch (step.kind) {
    case "tool": {
      const input = step.input(b)
      const runIt = (): Promise<unknown> =>
        runTool({
          tool: step.tool,
          candidates: step.candidates,
          input,
          context: step.context ? step.context(b) : undefined,
          resolverContext: step.resolverContext,
          secrets: step.secrets,
          signal,
        })
      if (!isCacheEnabled(ctx, step)) {
        ctx.onStepStart?.(step.id)
        return runIt()
      }
      const c = await readStepCache(ctx, step, input)
      if (c.hit) return cacheHit(ctx, step, c.output)
      ctx.onStepStart?.(step.id)
      const out = await runIt()
      await ctx.cache!.set(c.key, { output: out, resolvedInputHash: c.hash })
      return out
    }

    case "transform":
      return step.compute(b)

    case "map": {
      const arr = [...step.over(b)]
      const parallelism = Math.max(1, step.parallelism ?? 1)
      const tolerant = step.onError === "collect"
      const results: unknown[] = new Array(arr.length)
      // Sliding window, not fixed batches: each of `parallelism` workers
      // pulls the next item as soon as its current one settles, so one slow
      // item never holds idle slots hostage. Same pool shape as `pipeline`.
      // Non-tolerant: after the first failure no NEW item starts (in-flight
      // ones finish), and the map rethrows that first error.
      let next = 0
      let failed = false
      const runItem = async (idx: number): Promise<void> => {
        const el = arr[idx]
        const inner = step.body(el, idx, view(state, el, idx))
        const wrapped = withIndexedHooks(ctx, idx)
        try {
          const out = await execStep(inner, wrapped, el, idx)
          completeStep(wrapped, inner.id, out)
          results[idx] = tolerant ? { status: "fulfilled", index: idx, value: out } : out
        } catch (err) {
          if (!tolerant) {
            failed = true
            throw err
          }
          results[idx] = { status: "rejected", index: idx, item: el, error: errorMessage(err) }
        }
      }
      const worker = async (): Promise<void> => {
        while (!failed && next < arr.length) {
          const idx = next++
          await runItem(idx)
        }
      }
      await Promise.all(Array.from({ length: Math.min(parallelism, arr.length) }, () => worker()))
      if (!tolerant) return results
      const outcomes = results as FanOutOutcome[]
      return {
        results: outcomes,
        succeeded: outcomes.filter((r) => r.status === "fulfilled").length,
        failed: outcomes.filter((r) => r.status === "rejected").length,
      } satisfies TolerantFanOutResult
    }

    case "pipeline": {
      const items = [...step.over(b)]
      const tolerant = step.onError === "collect"
      if (items.length === 0) return tolerant ? { results: [], succeeded: 0, failed: 0 } : []
      const cap = Math.max(1, step.concurrency ?? items.length)
      const results: unknown[] = new Array(items.length)
      let next = 0
      const runItem = async (idx: number): Promise<void> => {
        let prev: unknown = undefined
        const wrapped = withIndexedHooks(ctx, idx)
        try {
          for (const stage of step.stages) {
            const inner = stage(items[idx], idx, prev, view(state, items[idx], idx))
            prev = await execStep(inner, wrapped, items[idx], idx)
            completeStep(wrapped, inner.id, prev)
          }
          results[idx] = tolerant ? { status: "fulfilled", index: idx, value: prev } : prev
        } catch (err) {
          if (!tolerant) throw err
          results[idx] = { status: "rejected", index: idx, item: items[idx], error: errorMessage(err) }
        }
      }
      const worker = async (): Promise<void> => {
        while (next < items.length) {
          const idx = next++
          await runItem(idx)
        }
      }
      await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()))
      if (!tolerant) return results
      const outcomes = results as FanOutOutcome[]
      return {
        results: outcomes,
        succeeded: outcomes.filter((r) => r.status === "fulfilled").length,
        failed: outcomes.filter((r) => r.status === "rejected").length,
      } satisfies TolerantFanOutResult
    }

    case "branch": {
      const chosen = step.cond(b) ? step.then : (step.otherwise ?? [])
      return runSequence(chosen, ctx, item, index)
    }

    case "loop": {
      let iterations = 0
      let last: unknown
      while (
        iterations < step.maxIterations &&
        step.while(view(state, item, index))
      ) {
        last = await runSequence(step.body, ctx, item, index)
        iterations++
      }
      return last
    }

    case "parallel": {
      const outs = await Promise.all(
        step.branches.map((br) =>
          runSequence(br.steps, ctx, item, index).then((last) => ({
            id: br.id,
            last,
          })),
        ),
      )
      const record: Record<string, unknown> = {}
      for (const { id, last } of outs) record[id] = last
      return record
    }

    case "approval": {
      const prompt = step.prompt(b)
      const approvers = step.approvers ?? []
      const raw = ctx.approve
        ? await ctx.approve({
            stepId: step.id,
            prompt,
            approvers,
            ...(step.artifacts !== undefined ? { artifacts: step.artifacts } : {}),
            ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          })
        : true
      // A bare boolean is a host that doesn't record who decided — normalize
      // it to a full decision so downstream ledger/audit writes always have a
      // `who`.
      const decision: ApprovalDecision =
        typeof raw === "boolean" ? { approved: raw, who: "host" } : raw
      const approved = decision.approved
      const followups = approved
        ? (step.onApprove ?? [])
        : (step.onReject ?? [])
      await runSequence(followups, ctx, item, index)
      return { approved, who: decision.who, ...(decision.note !== undefined ? { note: decision.note } : {}) }
    }

    case "suspend": {
      if (!ctx.resume) throw new WorkflowSuspendedError(step.id, step.on)
      return ctx.resume({ stepId: step.id, on: step.on })
    }

    case "group":
      return runSequence(step.steps, ctx, item, index)

    case "subworkflow": {
      const childInput = step.input ? step.input(b) : state.input
      const child = await runWorkflowInner(step.workflow, childInput, {
        approve: ctx.approve,
        resume: ctx.resume,
        onInputRequired: ctx.onInputRequired,
        signal,
        agents: ctx.agents,
        cwd: ctx.cwd,
        workspaceSlug: ctx.workspaceSlug,
        cache: ctx.cache,
        cacheKey: ctx.cacheKey,
        runGateCommand: ctx.runGateCommand,
        onGateReport: ctx.onGateReport,
      })
      return child.output
    }

    case "agent": {
      if (!ctx.agents) throw new Error(`step '${step.id}': AgentStep requires a host agents implementation`)
      if (!isCacheEnabled(ctx, step)) return execAgentStep(step, ctx, b)
      const resolved = {
        prompt: step.prompt(b),
        adapter: step.adapter ? resolveSel(step.adapter, b) : undefined,
        model: step.model ? resolveSel(step.model, b) : undefined,
        sessionRef: step.sessionRef,
      }
      const c = await readStepCache(ctx, step, resolved)
      if (c.hit) return cacheHit(ctx, step, c.output) // cache hit ⇒ NO spawn, NO budget spend
      const out = await execAgentStep(step, ctx, b)
      await ctx.cache!.set(c.key, { output: out, resolvedInputHash: c.hash })
      return out
    }

    case "gate":
      return execGateStep(step, ctx, b)
  }
}

async function runWorkflowInner(
  workflow: RuntimeWorkflow,
  input: unknown,
  hooks: Pick<RunCtx, "approve" | "resume" | "onInputRequired" | "signal" | "agents" | "cwd" | "workspaceSlug" | "cache" | "cacheKey" | "onStepStart" | "onStepComplete" | "runGateCommand" | "onGateReport">,
  maxTotalCostUsd?: number,
): Promise<WorkflowRunResult> {
  const state: RunState = { input, steps: {}, costBySession: new Map(), maxTotalCostUsd, cachedHits: new Set() }
  const ctx: RunCtx = { state, ...hooks }
  let lastId: string | undefined
  for (const step of workflow.steps) {
    const out = await execStep(step, ctx, undefined, undefined)
    state.steps[step.id] = out
    completeStep(ctx, step.id, out)
    lastId = step.id
  }
  const bindings = view(state)
  const output = workflow.output
    ? workflow.output(bindings)
    : lastId !== undefined
      ? state.steps[lastId]
      : undefined
  return { output, bindings }
}

export async function runWorkflow(
  args: RunWorkflowArgs,
): Promise<WorkflowRunResult> {
  return runWorkflowInner(args.workflow, args.input, {
    approve: args.approve,
    resume: args.resume,
    onInputRequired: args.onInputRequired,
    signal: args.signal,
    agents: args.agents,
    cwd: args.cwd,
    workspaceSlug: args.workspaceSlug,
    cache: args.cache,
    cacheKey: args.cacheKey,
    onStepStart: args.onStepStart,
    onStepComplete: args.onStepComplete,
    runGateCommand: args.runGateCommand,
    onGateReport: args.onGateReport,
  }, args.maxTotalCostUsd)
}
