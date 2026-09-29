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
import { spawn } from "node:child_process"
import { copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { resolveRefString } from "./ref-string.js"
import type {
  AgentStep,
  ApprovalDecision,
  ArtifactEntry,
  ArtifactStep,
  Bindings,
  FanOutOutcome,
  GateCommandResult,
  GateStep,
  KnowledgeAppliedRecord,
  OutputSchemaLike,
  OutputsFileContract,
  RunStep,
  RunWorkflowArgs,
  RuntimeWorkflow,
  StepCacheEntry,
  StepFailedInfo,
  StepHookInfo,
  StepSkippedInfo,
  TolerantFanOutResult,
  WorkflowRunResult,
} from "./types.js"
import { DEFAULT_MAX_CONSECUTIVE_SPAWN_FAILURES, DEFAULT_STEP_TIMEOUT_MS } from "./types.js"
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

/**
 * AIP-58 §4/§10 — thrown when a declared `outputsFiles.<key>` (`required`
 * absent or `true`) does not exist under the run workspace once every
 * top-level step has finished. `stepId` is the last top-level step that ran
 * (the manifest names no step for a workflow-level contract, so the last one
 * to finish is the best available attribution).
 */
export class MissingArtifactError extends Error {
  readonly code = "missing-artifact" as const
  constructor(
    readonly key: string,
    readonly stepId: string | undefined,
  ) {
    super(`outputsFiles.${key} was required but is missing from the run workspace`)
    this.name = "MissingArtifactError"
  }
}

/**
 * Thrown when an {@link AgentStep}'s session could not be spawned at all
 * (`AgentSessionHost.spawn` rejected) — distinct from a session that spawned
 * and then failed its turn. A tolerant fan-out counts these toward its spawn
 * circuit breaker ({@link MapStep.maxConsecutiveSpawnFailures}): a spawn that
 * fails for one item usually fails for every item (missing cwd, adapter
 * gone, process limits), so burning through the rest is pure noise.
 */
export class AgentSpawnError extends Error {
  constructor(
    readonly stepId: string,
    readonly cause: unknown,
  ) {
    super(`step '${stepId}': agent spawn failed — ${errorMessage(cause)}`)
    this.name = "AgentSpawnError"
  }
}

/**
 * Thrown instead of dispatching a step whose run was cancelled
 * (`ctx.signal.aborted`) — checked BEFORE any work for the step begins (see
 * {@link execStepBody}'s entry guard), so a cancel stops the run from
 * starting any further step, including a sibling within the SAME stage/
 * fan-out, not just a later one. Never journaled: it's thrown before a
 * cacheable step's `cache.set` call, so `workflow_retry` re-executes it.
 */
export class WorkflowCancelledError extends Error {
  constructor(readonly stepId: string) {
    super(`step '${stepId}': run cancelled — not started`)
    this.name = "WorkflowCancelledError"
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
  /** AIP-58 §4 — see {@link RunWorkflowArgs.workspace}. */
  readonly workspace?: string
  /** AIP-58 §4 — see {@link RunWorkflowArgs.artifactsDir}. */
  readonly artifactsDir?: string
  readonly runId?: string
  readonly onArtifact?: RunWorkflowArgs["onArtifact"]
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
  readonly onStepSkipped?: RunWorkflowArgs["onStepSkipped"]
  readonly onStepFailed?: RunWorkflowArgs["onStepFailed"]
  readonly runGateCommand?: RunWorkflowArgs["runGateCommand"]
  readonly onGateReport?: RunWorkflowArgs["onGateReport"]
  /** Sessions spawned in the current release scope (the run, or one
   *  `map`/`pipeline` item) — released when that scope settles. */
  readonly spawned?: string[]
  /** F42 — on-disk artifact filenames already claimed this run, under
   *  `artifactsDir` (one flat namespace, no subdirectories). One Set per
   *  top-level run, shared by every nested `subworkflow` call (they write
   *  into the SAME `artifactsDir` — see the `"subworkflow"` case in
   *  `execStep`), so a parent's and a child's artifacts can't silently
   *  collide either. See {@link reserveArtifactDestName}. */
  readonly usedArtifactNames?: Set<string>
}

/** Open a release scope for one fan-out item: sessions its steps spawn are
 *  released as soon as the item settles, not held until the run ends. */
function withReleaseScope(ctx: RunCtx): RunCtx {
  return { ...ctx, spawned: [] }
}

/** Release every session collected in `ctx`'s scope (see
 *  `AgentSessionHost.releaseSession`). Never throws. */
async function releaseScope(ctx: RunCtx): Promise<void> {
  const release = ctx.agents?.releaseSession
  if (!release || !ctx.spawned || ctx.spawned.length === 0) return
  const ids = ctx.spawned.splice(0)
  const agents = ctx.agents
  await Promise.all(ids.map((id) => Promise.resolve().then(() => release.call(agents, id)).catch(() => undefined)))
}

function view(ctx: RunCtx, item?: unknown, index?: number): Bindings {
  return {
    input: ctx.state.input,
    steps: ctx.state.steps,
    item,
    index,
    ...(ctx.workspace !== undefined ? { run: { workspace: ctx.workspace } } : {}),
  }
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
  if (!ctx.onStepStart && !ctx.onStepComplete && !ctx.onStepSkipped && !ctx.onStepFailed) {
    return { ...ctx, cacheKeySuffix }
  }
  return {
    ...ctx,
    cacheKeySuffix,
    onStepStart: ctx.onStepStart
      ? (id: string, info?: StepHookInfo) => ctx.onStepStart!(`${id}[${index}]`, info)
      : undefined,
    onStepComplete: ctx.onStepComplete
      ? (id: string, out: unknown, info?: StepHookInfo) => ctx.onStepComplete!(`${id}[${index}]`, out, info)
      : undefined,
    onStepSkipped: ctx.onStepSkipped
      ? (id: string, info: StepSkippedInfo) => ctx.onStepSkipped!(`${id}[${index}]`, info)
      : undefined,
    onStepFailed: ctx.onStepFailed
      ? (id: string, info: StepFailedInfo) => ctx.onStepFailed!(`${id}[${index}]`, info)
      : undefined,
  }
}

/**
 * The innermost step an in-flight error came from, as a reporter bound to
 * that step's own (indexed) hooks — set by the first {@link execStep} frame
 * the error unwinds through, so a tolerant fan-out that swallows the error
 * can still fail the step that actually threw (not its item's wrapper).
 */
const failureOrigin = new WeakMap<object, (info: StepFailedInfo) => void>()

/** A tolerant fan-out item threw: report it via `onStepFailed` on the step
 *  that threw (see {@link failureOrigin}), else on the item's body step. */
function reportItemFailure(err: unknown, itemCtx: RunCtx, bodyId: string): void {
  const info = { error: errorMessage(err) }
  const origin = typeof err === "object" && err !== null ? failureOrigin.get(err) : undefined
  if (origin) {
    // Consume it: a host may reject every item with the SAME error object.
    failureOrigin.delete(err as object)
    origin(info)
  } else {
    itemCtx.onStepFailed?.(bodyId, info)
  }
}

/**
 * Spawn circuit breaker for one tolerant fan-out — see
 * {@link MapStep.maxConsecutiveSpawnFailures}. `settle` is fed every
 * item's outcome in completion order; `open` is the first error of the
 * streak that tripped it (undefined while closed). Once open it stays open.
 */
function spawnBreaker(threshold: number): { settle: (err?: unknown) => void; readonly open: string | undefined } {
  let streak = 0
  let streakFirst: string | undefined
  let open: string | undefined
  return {
    settle(err?: unknown): void {
      if (open !== undefined) return
      if (!(err instanceof AgentSpawnError)) {
        streak = 0
        streakFirst = undefined
        return
      }
      if (streak === 0) streakFirst = err.message
      streak++
      if (threshold > 0 && streak >= threshold) open = streakFirst
    },
    get open() {
      return open
    },
  }
}

/** Report every item never started as `skipped` (each of its body's
 *  statically-known steps, indexed like a started item's) — either because a
 *  tripped spawn circuit breaker (`kind: "circuit-open"`) or the run being
 *  cancelled (`kind: "run-cancelled"`) stopped the fan-out from starting any
 *  more items. */
function skipUnstartedItems(
  ctx: RunCtx,
  fanOutId: string,
  from: number,
  items: readonly unknown[],
  bodiesOf: (item: unknown, idx: number) => readonly RunStep[],
  kind: StepSkippedInfo["reason"],
  reason: string,
  results: unknown[],
): void {
  for (let idx = from; idx < items.length; idx++) {
    results[idx] = { status: "skipped", index: idx, item: items[idx], reason: `${kind}: ${reason}` }
    const itemCtx = withIndexedHooks(ctx, idx)
    if (!itemCtx.onStepSkipped) continue
    let bodies: readonly RunStep[]
    try {
      bodies = bodiesOf(items[idx], idx)
    } catch {
      // A body builder that needs a started item's state (a pipeline stage
      // reading its prevOutput) — the item's outcome above still records it.
      continue
    }
    for (const id of new Set(skippableStepIds(bodies))) {
      itemCtx.onStepSkipped(id, { reason: kind, branchId: fanOutId, message: reason })
    }
  }
}

/** The bound output of a tolerant fan-out. */
function tolerantResult(results: unknown[], circuitOpen: string | undefined): TolerantFanOutResult {
  const outcomes = results as FanOutOutcome[]
  return {
    results: outcomes,
    succeeded: outcomes.filter((r) => r.status === "fulfilled").length,
    failed: outcomes.filter((r) => r.status === "rejected").length,
    skipped: outcomes.filter((r) => r.status === "skipped").length,
    ...(circuitOpen !== undefined ? { circuitOpen: { error: circuitOpen } } : {}),
  }
}

/** Resolve a value that is either a static string or a binding selector. */
function resolveSel(sel: string | ((bindings: Bindings) => string), b: Bindings): string {
  return typeof sel === "function" ? sel(b) : sel
}

/** An AgentStep's `sessionRef` with `{{index}}` bound to the current fan-out
 *  item (see `AgentStep.sessionRef`). Outside a fan-out it stays literal. */
function resolveSessionRef(ref: string, b: Bindings): string {
  return b.index === undefined ? ref : ref.replace(/\{\{\s*index\s*\}\}/g, String(b.index))
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

/** Sentinel a resolved input/prompt's absolute run-workspace path is
 *  replaced with before hashing (see {@link hashResolvedInputs}). */
const WORKSPACE_HASH_PLACEHOLDER = "\u0000$run.workspace\u0000"

/** Deterministic content hash of a step's resolved inputs. `workspace` —
 *  this run's `$run.workspace` / `_workflowFsRoot` absolute path, when the
 *  host wires one — is replaced by a stable placeholder wherever it occurs
 *  as a substring (including trailing subpaths, e.g.
 *  `<workspace>/cleaned/out.txt`) before hashing. AIP-58 §4 gives every run
 *  its OWN, disjoint workspace directory — a fresh absolute path each
 *  time — so without this a step whose resolved input/prompt embeds
 *  `$run.workspace` would hash differently on every run and never hit the
 *  journal even though nothing about the step's actual work changed
 *  (regression: AIP-58 P4 / #1467 broke #1421's cache this way). */
function hashResolvedInputs(kind: string, resolved: unknown, workspace: string | undefined): string {
  const serialized = `${kind}\u0000${JSON.stringify(resolved) ?? "undefined"}`
  const normalized = workspace ? serialized.split(workspace).join(WORKSPACE_HASH_PLACEHOLDER) : serialized
  return createHash("sha256").update(normalized).digest("hex")
}

/** `value`, recursively, with every string that is `from` (or `from` plus a
 *  trailing subpath) rewritten to start with `to` instead. Used both to
 *  normalize resolved inputs (`hashResolvedInputs` — via a literal split/join
 *  rather than this walk, since inputs are hashed as one serialized blob)
 *  and — here — to rewrite a cache hit's RECORDED OUTPUT so a path naming
 *  the ORIGINAL run's workspace points at the CURRENT run's own instead
 *  ({@link relocateCachedOutput}). Arrays/plain objects are copied; anything
 *  else (numbers, booleans, class instances, `null`) passes through as-is. */
function rewriteWorkspacePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to)
  if (Array.isArray(value)) return value.map((v) => rewriteWorkspacePaths(v, from, to))
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteWorkspacePaths(v, from, to)
    return out
  }
  return value
}

/** Every string in `value` (recursively) that names a path under `workspace`,
 *  as a workspace-relative path — collected into `out`. A candidate only,
 *  not yet checked against the filesystem (see {@link collectWorkspaceFiles}). */
function collectWorkspaceCandidates(value: unknown, workspace: string, out: Set<string>): void {
  if (typeof value === "string") {
    if (value === workspace || value.startsWith(`${workspace}/`)) {
      const rel = relative(workspace, value)
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) out.add(rel)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectWorkspaceCandidates(v, workspace, out)
    return
  }
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    for (const v of Object.values(value as Record<string, unknown>)) collectWorkspaceCandidates(v, workspace, out)
  }
}

/** Every workspace-relative file/directory a cacheable step's output points
 *  at — checked against the real filesystem (so a string that merely LOOKS
 *  like a workspace path, but names nothing, isn't recorded as something a
 *  later cache hit must relocate). Recorded on the journal entry
 *  ({@link StepCacheEntry.workspaceFiles}) and copied forward by
 *  {@link relocateCachedOutput} on a hit in a later run's own workspace. */
async function collectWorkspaceFiles(out: unknown, workspace: string): Promise<string[]> {
  const candidates = new Set<string>()
  collectWorkspaceCandidates(out, workspace, candidates)
  const files: string[] = []
  for (const rel of candidates) {
    try {
      await stat(join(workspace, rel))
      files.push(rel)
    } catch {
      // Not a real file/dir under the workspace — nothing to relocate.
    }
  }
  return files
}

/** Journal entry for a fresh (non-hit) cacheable `tool`/`agent` step —
 *  records the workspace it ran under, and (best-effort) every file/dir its
 *  output pointed at under that workspace, so a cache hit in a LATER run
 *  (necessarily a different workspace — AIP-58 §4) can relocate them
 *  (see {@link relocateCachedOutput}) instead of replaying an output that
 *  names a path that only ever existed in this now-gone run. */
async function buildCacheEntry(ctx: RunCtx, out: unknown, hash: string): Promise<StepCacheEntry> {
  if (ctx.workspace === undefined) return { output: out, resolvedInputHash: hash }
  const workspaceFiles = await collectWorkspaceFiles(out, ctx.workspace)
  return {
    output: out,
    resolvedInputHash: hash,
    workspaceAtCache: ctx.workspace,
    ...(workspaceFiles.length > 0 ? { workspaceFiles } : {}),
  }
}

/** A `tool`/`agent` cache hit's recorded output, relocated onto the CURRENT
 *  run: every file/dir the entry recorded under the ORIGINAL run's workspace
 *  is copied into the matching path under this run's own (same relocation
 *  spirit as `kind:"artifact"`'s cache hit — "two runs MUST NEVER share a
 *  workspace", AIP-58 §4), then the recorded output's path strings are
 *  rewritten to point there. Best-effort: a source the original run's
 *  `scratch/` retention already swept is not this run's problem to recover
 *  (same posture `kind:"artifact"`'s relocation takes). A no-op when the
 *  entry predates this field, or this run has no workspace wired at all. */
async function relocateCachedOutput(ctx: RunCtx, entry: StepCacheEntry): Promise<unknown> {
  const from = entry.workspaceAtCache
  const to = ctx.workspace
  if (from === undefined || to === undefined || from === to) return entry.output
  for (const rel of entry.workspaceFiles ?? []) {
    const dest = join(to, rel)
    try {
      await mkdir(dirname(dest), { recursive: true })
      await cp(join(from, rel), dest, { recursive: true })
    } catch {
      // Best-effort — see doc above.
    }
  }
  return rewriteWorkspacePaths(entry.output, from, to)
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
  const hash = hashResolvedInputs(step.kind, resolvedInputs, ctx.workspace)
  const entry = await ctx.cache!.get(key)
  if (entry !== undefined && entry.resolvedInputHash === hash) {
    return { hit: true, output: await relocateCachedOutput(ctx, entry) }
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

/**
 * The statically-known steps under `steps` that a skipped `branch` arm
 * reports via `onStepSkipped`: leaf steps, plus `map`/`pipeline`/
 * `subworkflow` steps by their own id (their bodies aren't enumerable here or
 * don't report through this run's hooks). Structural wrappers (group,
 * parallel, branch, loop) are walked, never reported themselves.
 */
function skippableStepIds(steps: readonly RunStep[], acc: string[] = []): string[] {
  for (const s of steps) {
    switch (s.kind) {
      case "group":
        skippableStepIds(s.steps, acc)
        break
      case "parallel":
        for (const br of s.branches) skippableStepIds(br.steps, acc)
        break
      case "branch":
        skippableStepIds(s.then, acc)
        if (s.otherwise) skippableStepIds(s.otherwise, acc)
        break
      case "loop":
        skippableStepIds(s.body, acc)
        break
      default:
        acc.push(s.id)
    }
  }
  return acc
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
  // A relative step cwd resolves against the run cwd, never the daemon's own.
  const stepCwd = step.cwd ? resolveSel(step.cwd, b) : undefined
  const cwd =
    step.harness?.cwd ??
    (stepCwd !== undefined ? (ctx.cwd !== undefined ? resolve(ctx.cwd, stepCwd) : stepCwd) : ctx.cwd)
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
  let sessionId: string | undefined
  if (step.adapter) {
    // A cancelled run winds down (its `finally` still runs) — it must not
    // start new agent sessions on the way (a fan-out would otherwise keep
    // spawning reviewers after the cancel killed the running ones). The
    // entry guard in `execStepBody` already catches this for a step that
    // hadn't started at all; this second check covers a cancel landing
    // WHILE this step's own body is already running (knowledge
    // materialization, sandbox/model resolution, …), before it reaches spawn.
    if (ctx.signal?.aborted) throw new WorkflowCancelledError(step.id)
    try {
      sessionId = await ctx.agents!.spawn(resolveSel(step.adapter, b), {
        cwd,
        workspaceSlug: ctx.workspaceSlug,
        stepId: step.id,
        ...(sandbox !== undefined ? { sandbox } : {}),
        ...(step.options !== undefined ? { options: step.options } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(step.agentTools !== undefined ? { agentTools: step.agentTools } : {}),
        ...(b.index !== undefined ? { stepKey: `${step.id}[${b.index}]` } : {}),
      })
    } catch (err) {
      throw new AgentSpawnError(step.id, err)
    }
  } else {
    sessionId = ctx.agents!.resolveByLabel(resolveSessionRef(step.sessionRef!, b))
  }
  if (!sessionId) throw new Error(`step '${step.id}': no session (adapter and sessionRef both unresolved)`)
  if (step.adapter) ctx.spawned?.push(sessionId)
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

/** Ceiling on how long to wait, after a gate's DIRECT child exits, for its
 *  stdio to finish draining before giving up on it — see {@link
 *  defaultRunGateCommand}'s doc. The ordinary case (no orphaned grandchild
 *  sharing the pipe) resolves far sooner: as soon as both streams `end`. */
const GATE_STDIO_DRAIN_MS = 2_000

/** How long a killed gate process group gets before an unresponsive survivor
 *  is escalated from SIGTERM to SIGKILL. */
const GATE_KILL_GRACE_MS = 2_000

/**
 * The runtime's own subprocess runner for `kind: "gate"` steps, used when no
 * `runGateCommand` host hook is injected — a plain `node:child_process`
 * argv-vector invocation (no shell interpolation). Exit code 0 always
 * resolves (never rejects on a non-zero exit); a timeout resolves with
 * `timedOut: true` and whatever partial output was captured.
 *
 * Settles on the DIRECT child's own `exit`, never on `close` — `close` only
 * fires once the child's stdout/stderr pipes have also closed, and a
 * subprocess that spawns its own child with inherited/piped stdio (e.g.
 * headless Chrome) can leave an orphaned grandchild holding that pipe open
 * long after the gate command itself finished, hanging the step forever
 * even though the command already completed (F45). A short drain window
 * after `exit` still gives any already-in-flight `data` a chance to land.
 *
 * `spec.timeoutMs` defaults to {@link DEFAULT_STEP_TIMEOUT_MS} when unset —
 * a gate's subprocess is never left unbounded. On timeout, or when
 * `spec.signal` aborts (a cancelled run must not leave a gate's subprocess
 * running any more than it leaves an agent step's session running —
 * {@link execGateStep} re-checks the signal right after this resolves to
 * turn the kill into a `WorkflowCancelledError`), the WHOLE process group is
 * killed via `process.kill(-pid)` (spawned detached), not just the direct
 * child — so an orphaned grandchild sharing that group doesn't survive it.
 */
function defaultRunGateCommand(spec: {
  command: string
  args: readonly string[]
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<GateCommandResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let stdoutEnded = !child.stdout
    let stderrEnded = !child.stderr
    let exitCode: number | undefined
    let drainTimer: NodeJS.Timeout | undefined

    const killGroup = (sig: NodeJS.Signals): void => {
      if (typeof child.pid !== "number") return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        // Already gone.
      }
    }

    let killTimer: NodeJS.Timeout | undefined
    const kill = (): void => {
      killGroup("SIGTERM")
      killTimer = setTimeout(() => killGroup("SIGKILL"), GATE_KILL_GRACE_MS).unref()
    }

    const onAbort = () => kill()
    if (spec.signal?.aborted) kill()
    else spec.signal?.addEventListener("abort", onAbort, { once: true })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs).unref()

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(timeoutTimer)
      clearTimeout(drainTimer)
      spec.signal?.removeEventListener("abort", onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ exitCode: code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) })
    }

    // See the CLI driver's `runSubprocess` for why this resolves on `exit` +
    // both streams' own `end` (the ordinary case, near-instant) with
    // `drainTimer` only as a ceiling for the orphan-holds-the-pipe case.
    const maybeFinish = (): void => {
      if (exitCode !== undefined && stdoutEnded && stderrEnded) finish(exitCode)
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stdout?.on("end", () => {
      stdoutEnded = true
      maybeFinish()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stderr?.on("end", () => {
      stderrEnded = true
      maybeFinish()
    })

    child.on("error", () => {
      exitCode = 1
      drainTimer = setTimeout(() => finish(1), GATE_STDIO_DRAIN_MS).unref()
      maybeFinish()
    })
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 1 : 0)
      drainTimer = setTimeout(() => finish(exitCode!), GATE_STDIO_DRAIN_MS).unref()
      maybeFinish()
    })
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
    // A cancel landing between retry attempts must not reprompt a session
    // that cancel's releaseAll() may have already killed (which would
    // surface as a confusing "session not found" error instead of a clean
    // WorkflowCancelledError), nor wait out a retry backoff pointlessly.
    if (ctx.signal?.aborted) throw new WorkflowCancelledError(step.id)
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
      signal: ctx.signal,
    })
    // The signal killed the subprocess mid-command (see
    // `defaultRunGateCommand`) — report the step as cancelled, not as
    // whatever exit code the kill happened to produce, so it's never
    // journaled as succeeded/failed and `workflow_retry` re-runs it.
    if (ctx.signal?.aborted) throw new WorkflowCancelledError(step.id)
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

/**
 * Bound a `tool` step's dispatch with its own hard wall-clock cap
 * (independent of any tool-contract-level `timeoutMs` `runTool` already
 * enforces — F45 found NEITHER layer actually terminated a step whose
 * driver never settled its promise). `fn` receives a signal that aborts
 * either when `timeoutMs` elapses OR `parentSignal` (the run's own cancel
 * signal) aborts first — either way the driver underneath (the CLI driver's
 * `runSubprocess`, `defaultRunGateCommand`) is expected to kill its
 * subprocess on abort, same as a cancelled run already relies on. Only the
 * TIMER-triggered abort is reported as `'step '<id>': timed out after
 * <n>ms'`; a parent-signal abort rethrows whatever `fn` itself produced, so
 * a run cancel keeps its existing error shape.
 */
async function withStepTimeout<T>(
  stepId: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parentSignal!.reason)
  if (parentSignal?.aborted) controller.abort(parentSignal.reason)
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`step '${stepId}': timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    return await fn(controller.signal)
  } catch (err) {
    if (timedOut) throw new Error(`step '${stepId}': timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
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
  try {
    return await execStepBody(step, ctx, item, index)
  } catch (err) {
    // Innermost frame wins: an outer (composite) frame sees it already set.
    if (typeof err === "object" && err !== null && !failureOrigin.has(err)) {
      failureOrigin.set(err, (info) => ctx.onStepFailed?.(step.id, info))
    }
    throw err
  }
}

async function execStepBody(
  step: RunStep,
  ctx: RunCtx,
  item: unknown,
  index: number | undefined,
): Promise<unknown> {
  const { state, signal } = ctx

  // A cancelled run must not dispatch ANY further step — a sibling still
  // queued in the same stage/fan-out included, not just a later stage (the
  // old contract, "no new stages will be started", left a same-stage
  // successor like a `map`'s next item or the step right after it free to
  // start). Checked before `onStepStart` fires, so a step that never ran
  // never reports as started. `runFinally` clears `signal` on its own ctx
  // (cleanup must survive a cancel), so this never blocks a `finally` step.
  if (signal?.aborted) throw new WorkflowCancelledError(step.id)

  const b = view(ctx, item, index)

  // Notify step start for non-agent steps (agent steps notify in
  // execAgentStep; a tool/artifact step notifies in its own case, once it
  // knows whether it's a cache hit).
  if (step.kind !== "agent" && step.kind !== "tool" && step.kind !== "artifact") {
    ctx.onStepStart?.(step.id)
  }

  switch (step.kind) {
    case "tool": {
      const input = step.input(b)
      const runIt = (): Promise<unknown> =>
        withStepTimeout(step.id, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, signal, (sig) =>
          runTool({
            tool: step.tool,
            candidates: step.candidates,
            input,
            context: step.context ? step.context(b) : undefined,
            resolverContext: step.resolverContext,
            secrets: step.secrets,
            signal: sig,
          }),
        )
      if (!isCacheEnabled(ctx, step)) {
        ctx.onStepStart?.(step.id)
        return runIt()
      }
      const c = await readStepCache(ctx, step, input)
      if (c.hit) return cacheHit(ctx, step, c.output)
      ctx.onStepStart?.(step.id)
      const out = await runIt()
      await ctx.cache!.set(c.key, await buildCacheEntry(ctx, out, c.hash))
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
      // ones finish), and the map rethrows that first error. Tolerant: a
      // failed item is reported on the step that threw, and the spawn
      // circuit breaker stops new items once spawning is systemically broken.
      let next = 0
      let failed = false
      const breaker = spawnBreaker(step.maxConsecutiveSpawnFailures ?? DEFAULT_MAX_CONSECUTIVE_SPAWN_FAILURES)
      const runItem = async (idx: number): Promise<void> => {
        const el = arr[idx]
        const inner = step.body(el, idx, view(ctx, el, idx))
        const wrapped = withReleaseScope(withIndexedHooks(ctx, idx))
        try {
          const out = await execStep(inner, wrapped, el, idx)
          completeStep(wrapped, inner.id, out)
          results[idx] = tolerant ? { status: "fulfilled", index: idx, value: out } : out
          breaker.settle()
        } catch (err) {
          if (!tolerant) {
            failed = true
            throw err
          }
          results[idx] = { status: "rejected", index: idx, item: el, error: errorMessage(err) }
          reportItemFailure(err, wrapped, inner.id)
          breaker.settle(err)
        } finally {
          await releaseScope(wrapped)
        }
      }
      const worker = async (): Promise<void> => {
        while (!failed && breaker.open === undefined && signal?.aborted !== true && next < arr.length) {
          const idx = next++
          await runItem(idx)
        }
      }
      await Promise.all(Array.from({ length: Math.min(parallelism, arr.length) }, () => worker()))
      // The run was cancelled while items remained unstarted: a non-tolerant
      // map must not report success over an incomplete `results` array — a
      // tolerant one instead marks the rest `skipped` (same shape a tripped
      // circuit breaker leaves), same as {@link skipUnstartedItems}'s other caller.
      if (signal?.aborted === true && next < arr.length) {
        if (!tolerant) throw new WorkflowCancelledError(step.id)
        skipUnstartedItems(ctx, step.id, next, arr, (el, idx) => [step.body(el, idx, view(ctx, el, idx))], "run-cancelled", "run cancelled", results)
        return tolerantResult(results, breaker.open)
      }
      if (!tolerant) return results
      if (breaker.open !== undefined) {
        skipUnstartedItems(ctx, step.id, next, arr, (el, idx) => [step.body(el, idx, view(ctx, el, idx))], "circuit-open", breaker.open, results)
      }
      return tolerantResult(results, breaker.open)
    }

    case "pipeline": {
      const items = [...step.over(b)]
      const tolerant = step.onError === "collect"
      if (items.length === 0) return tolerant ? tolerantResult([], undefined) : []
      const cap = Math.max(1, step.concurrency ?? items.length)
      const results: unknown[] = new Array(items.length)
      let next = 0
      const breaker = spawnBreaker(step.maxConsecutiveSpawnFailures ?? DEFAULT_MAX_CONSECUTIVE_SPAWN_FAILURES)
      const runItem = async (idx: number): Promise<void> => {
        let prev: unknown = undefined
        let stageId = step.id
        const wrapped = withReleaseScope(withIndexedHooks(ctx, idx))
        try {
          for (const stage of step.stages) {
            const inner = stage(items[idx], idx, prev, view(ctx, items[idx], idx))
            stageId = inner.id
            prev = await execStep(inner, wrapped, items[idx], idx)
            completeStep(wrapped, inner.id, prev)
          }
          results[idx] = tolerant ? { status: "fulfilled", index: idx, value: prev } : prev
          breaker.settle()
        } catch (err) {
          if (!tolerant) throw err
          results[idx] = { status: "rejected", index: idx, item: items[idx], error: errorMessage(err) }
          reportItemFailure(err, wrapped, stageId)
          breaker.settle(err)
        } finally {
          await releaseScope(wrapped)
        }
      }
      const worker = async (): Promise<void> => {
        while ((!tolerant || breaker.open === undefined) && signal?.aborted !== true && next < items.length) {
          const idx = next++
          await runItem(idx)
        }
      }
      await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()))
      // See the `"map"` case's identical guard above.
      if (signal?.aborted === true && next < items.length) {
        if (!tolerant) throw new WorkflowCancelledError(step.id)
        skipUnstartedItems(
          ctx,
          step.id,
          next,
          items,
          (el, idx) => step.stages.map((stage) => stage(el, idx, undefined, view(ctx, el, idx))),
          "run-cancelled",
          "run cancelled",
          results,
        )
        return tolerantResult(results, breaker.open)
      }
      if (!tolerant) return results
      if (breaker.open !== undefined) {
        skipUnstartedItems(
          ctx,
          step.id,
          next,
          items,
          (el, idx) => step.stages.map((stage) => stage(el, idx, undefined, view(ctx, el, idx))),
          "circuit-open",
          breaker.open,
          results,
        )
      }
      return tolerantResult(results, breaker.open)
    }

    case "branch": {
      const taken = step.cond(b)
      const chosen = taken ? step.then : (step.otherwise ?? [])
      if (ctx.onStepSkipped) {
        // Report the untaken arm's steps as skipped (AIP-58 `step.skipped`)
        // — minus any id that also sits on the chosen path (arms sharing a
        // body, or a nested branch node that still has to decide).
        const onChosenPath = new Set(skippableStepIds(chosen))
        const untaken = taken ? (step.otherwise ?? []) : step.then
        for (const id of new Set(skippableStepIds(untaken))) {
          if (!onChosenPath.has(id)) ctx.onStepSkipped(id, { reason: "branch-not-taken", branchId: step.sourceId ?? step.id })
        }
      }
      return runSequence(chosen, ctx, item, index)
    }

    case "loop": {
      let iterations = 0
      let last: unknown
      while (
        iterations < step.maxIterations &&
        step.while(view(ctx, item, index))
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
        workspace: ctx.workspace,
        artifactsDir: ctx.artifactsDir,
        runId: ctx.runId,
        onArtifact: ctx.onArtifact,
        cache: ctx.cache,
        cacheKey: ctx.cacheKey,
        runGateCommand: ctx.runGateCommand,
        onGateReport: ctx.onGateReport,
        spawned: ctx.spawned,
        usedArtifactNames: ctx.usedArtifactNames,
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
        sessionRef: step.sessionRef !== undefined ? resolveSessionRef(step.sessionRef, b) : undefined,
      }
      const c = await readStepCache(ctx, step, resolved)
      if (c.hit) return cacheHit(ctx, step, c.output) // cache hit ⇒ NO spawn, NO budget spend
      const out = await execAgentStep(step, ctx, b)
      await ctx.cache!.set(c.key, await buildCacheEntry(ctx, out, c.hash))
      return out
    }

    case "gate":
      return execGateStep(step, ctx, b)

    case "artifact":
      return execArtifactStep(step, ctx, b)
  }
}

/** Filesystem-safe filename — sanitizes either a bare artifact key (the
 *  empty-basename fallback) or a declared file's basename. */
function sanitizeArtifactFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_")
  return cleaned.length > 0 ? cleaned : "artifact"
}

/**
 * F42 — an artifact's on-disk name under `artifactsDir` is the declared
 * source file's own basename (sanitized), not its key: `outputsFiles.pdf:
 * {path: transcript.pdf}` lands at `artifacts/transcript.pdf`, keeping the
 * extension, instead of P4's extension-less `artifacts/pdf`.
 *
 * Two keys whose source files share a basename (e.g. two different steps
 * each producing their own `report.json`) would otherwise silently
 * overwrite one another in the flat `artifactsDir` namespace — disambiguated
 * deterministically by prefixing a colliding name with its own sanitized
 * key (and a counter, in the practically-unreachable case that ALSO
 * collides), so the same workflow produces the same names run to run.
 * `usedNames` is one Set per top-level run, shared across subworkflows —
 * see `RunCtx.usedArtifactNames`.
 */
function reserveArtifactDestName(rawPath: string, key: string, usedNames: Set<string>): string {
  const base = sanitizeArtifactFilename(basename(rawPath))
  let candidate = base
  if (usedNames.has(candidate)) {
    const keyPart = sanitizeArtifactFilename(key)
    candidate = `${keyPart}-${base}`
    for (let n = 2; usedNames.has(candidate); n++) {
      candidate = `${keyPart}-${n}-${base}`
    }
  }
  usedNames.add(candidate)
  return candidate
}

/** Read + hash the file at `rawPath` (resolved against `workspace`, which
 *  MUST contain it) and copy it into `artifactsDir/<basename, disambiguated>`
 *  (see {@link reserveArtifactDestName}). Shared by {@link execArtifactStep}'s
 *  fresh path and {@link checkOutputsFiles}. */
async function copyIntoArtifacts(
  stepId: string,
  key: string,
  rawPath: string,
  workspace: string,
  artifactsDir: string,
  contentType: string | undefined,
  usedNames: Set<string>,
): Promise<ArtifactEntry> {
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspace, rawPath)
  const rel = relative(workspace, abs)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`step '${stepId}': artifact path '${rawPath}' resolves outside the run workspace`)
  }
  const buf = await readFile(abs)
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const destName = reserveArtifactDestName(rawPath, key, usedNames)
  await mkdir(artifactsDir, { recursive: true })
  await writeFile(join(artifactsDir, destName), buf)
  return {
    key,
    path: `artifacts/${destName}`,
    sha256,
    size: buf.length,
    stepId,
    ...(contentType !== undefined ? { contentType } : {}),
  }
}

/** `kind: "artifact"` — see {@link ArtifactStep}'s doc for the cache/relocate
 *  mechanics. */
async function execArtifactStep(step: ArtifactStep, ctx: RunCtx, b: Bindings): Promise<ArtifactEntry> {
  if (ctx.workspace === undefined || ctx.artifactsDir === undefined) {
    throw new Error(`step '${step.id}': kind:"artifact" requires a run workspace (no workspace/artifactsDir wired)`)
  }
  const workspace = ctx.workspace
  const artifactsDir = ctx.artifactsDir
  const key = resolveSel(step.key, b)
  const rawPath = resolveSel(step.path, b)
  const contentType = step.contentType ? resolveSel(step.contentType, b) : undefined
  const resolvedInputs = { key, path: rawPath }
  const cacheOn = ctx.cache !== undefined && ctx.cacheKey !== undefined
  const journalKey = cacheOn ? stepJournalKey(ctx, step) : undefined
  const hash = cacheOn ? hashResolvedInputs(step.kind, resolvedInputs, ctx.workspace) : undefined

  if (cacheOn) {
    const entry = await ctx.cache!.get(journalKey!)
    if (entry !== undefined && entry.resolvedInputHash === hash) {
      const out = entry.output as ArtifactEntry
      // F42: reuse the EXACT name recorded at cache-write time — it may have
      // been collision-disambiguated (see `reserveArtifactDestName`), so
      // recomputing it fresh from `key` here could pick a different name
      // than what THIS run's other artifacts already claimed.
      const destName = out.path.slice("artifacts/".length)
      ctx.usedArtifactNames?.add(destName)
      const destAbs = join(artifactsDir, destName)
      const srcAbs = join(entry.artifactsDirAtCache ?? artifactsDir, destName)
      if (srcAbs !== destAbs) {
        // AIP-58 §4 — "two runs MUST NEVER share a workspace": relocate the
        // bytes into THIS run's own artifactsDir rather than reading from
        // (or worse, pointing the run record at) the prior run's directory.
        await mkdir(dirname(destAbs), { recursive: true })
        try {
          await copyFile(srcAbs, destAbs)
        } catch {
          // Best-effort — the source may have been cleaned up by a host
          // retention policy (AIP-58 §4 permits discarding `scratch/`, but
          // `artifacts/` SHOULD be retained; a missing source here is a
          // deployment/retention issue, not something this run can fix).
        }
      }
      ctx.onArtifact?.(out)
      return cacheHit(ctx, step, out) as ArtifactEntry
    }
  }

  ctx.onStepStart?.(step.id)
  const out = await copyIntoArtifacts(step.id, key, rawPath, workspace, artifactsDir, contentType, ctx.usedArtifactNames!)
  if (cacheOn) {
    await ctx.cache!.set(journalKey!, { output: out, resolvedInputHash: hash!, artifactsDirAtCache: artifactsDir })
  }
  ctx.onArtifact?.(out)
  return out
}

/** Replace AIP-16's `<runId>`/`<workflowId>`/`<isoDate>` interpolation tokens
 *  in a declared `outputsFiles.<key>.path`. `<toolId>` has no meaning at the
 *  workflow level and is left literal. */
function interpolateFileContractPath(path: string, workflowId: string, runId: string | undefined): string {
  return path
    .replace(/<runId>/g, runId ?? "")
    .replace(/<workflowId>/g, workflowId)
    .replace(/<isoDate>/g, new Date().toISOString().slice(0, 10))
}

/**
 * AIP-58 §4 / AIP-16 §Amendments — checked once every top-level step has
 * finished successfully. For each declared `outputsFiles.<key>`: present ⇒
 * copied into `artifactsDir` and reported via `onArtifact`, same as a
 * `kind:"artifact"` step (but never cache-aware — see the README's "Cache/
 * replay interplay" section for why that's a deliberate, documented limit —
 * route a step's file-shaped output through an explicit `kind:"artifact"`
 * step instead, if it needs to survive a cache hit in a later run);
 * absent + `required === true` ⇒ throws {@link MissingArtifactError}. Absent
 * OR `false` (the default — `required` is opt-in, matching AIP-16
 * `IO.schema.json`'s `fileContractEntry.required` doc and the V3 vector's own
 * note: "with required absent or false, the same scenario would be a
 * warning") ⇒ advisory only, a `console.warn`, the run still succeeds.
 */
async function checkOutputsFiles(
  outputsFiles: RuntimeWorkflow["outputsFiles"],
  ctx: RunCtx,
  workflowId: string,
  lastStepId: string | undefined,
): Promise<void> {
  if (!outputsFiles) return
  if (ctx.workspace === undefined || ctx.artifactsDir === undefined) return
  for (const [key, contract] of Object.entries(outputsFiles)) {
    const rawPath = interpolateFileContractPath(contract.path, workflowId, ctx.runId)
    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.workspace, rawPath)
    let out: ArtifactEntry
    try {
      out = await copyIntoArtifacts(lastStepId ?? workflowId, key, abs, ctx.workspace, ctx.artifactsDir, contract.contentType, ctx.usedArtifactNames!)
    } catch {
      if (contract.required === true) {
        throw new MissingArtifactError(key, lastStepId)
      }
      console.warn(
        `[workflow-runtime] outputsFiles.${key} ('${contract.path}') is missing and not marked required — the run still succeeds (AIP-58 §4)`,
      )
      continue
    }
    ctx.onArtifact?.(out)
  }
}

/**
 * A workflow's `finally` steps ({@link RuntimeWorkflow.finally}): every one
 * runs, in order, without the run's abort signal (cleanup must survive a
 * cancel). After a failed body, a cleanup error is reported on its step and
 * swallowed so the original error wins; after a successful body the first
 * cleanup error is rethrown once every cleanup step has had its turn.
 */
async function runFinally(steps: readonly RunStep[], ctx: RunCtx, bodyFailed: boolean): Promise<void> {
  const cleanupCtx: RunCtx = { ...ctx, signal: undefined }
  let firstError: unknown
  for (const step of steps) {
    try {
      const out = await execStep(step, cleanupCtx, undefined, undefined)
      cleanupCtx.state.steps[step.id] = out
      completeStep(cleanupCtx, step.id, out)
    } catch (err) {
      cleanupCtx.onStepFailed?.(step.id, { error: errorMessage(err) })
      if (firstError === undefined) firstError = err
    }
  }
  if (!bodyFailed && firstError !== undefined) throw firstError
}

async function runWorkflowInner(
  workflow: RuntimeWorkflow,
  input: unknown,
  hooks: Pick<RunCtx, "approve" | "resume" | "onInputRequired" | "signal" | "agents" | "cwd" | "workspaceSlug" | "workspace" | "artifactsDir" | "runId" | "onArtifact" | "cache" | "cacheKey" | "onStepStart" | "onStepComplete" | "onStepSkipped" | "onStepFailed" | "runGateCommand" | "onGateReport" | "spawned" | "usedArtifactNames">,
  maxTotalCostUsd?: number,
): Promise<WorkflowRunResult> {
  const state: RunState = { input, steps: {}, costBySession: new Map(), maxTotalCostUsd, cachedHits: new Set() }
  // A subworkflow shares its parent's release scope (a parent step may
  // `sessionRef` a child's session); only the outermost run owns one — same
  // test (`hooks.spawned === undefined`) doubles as "own a fresh
  // `usedArtifactNames`", since a subworkflow always passes both down
  // together (see the `"subworkflow"` case above).
  const ownsScope = hooks.spawned === undefined
  const ctx: RunCtx = {
    state,
    ...hooks,
    ...(ownsScope ? { spawned: [], usedArtifactNames: new Set<string>() } : {}),
  }
  let lastId: string | undefined
  let bodyFailed = false
  try {
    for (const step of workflow.steps) {
      const out = await execStep(step, ctx, undefined, undefined)
      state.steps[step.id] = out
      completeStep(ctx, step.id, out)
      lastId = step.id
    }
    await checkOutputsFiles(workflow.outputsFiles, ctx, workflow.id, lastId)
  } catch (err) {
    bodyFailed = true
    throw err
  } finally {
    try {
      if (workflow.finally && workflow.finally.length > 0) await runFinally(workflow.finally, ctx, bodyFailed)
    } finally {
      if (ownsScope) await releaseScope(ctx)
    }
  }
  const bindings = view(ctx)
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
    workspace: args.workspace,
    artifactsDir: args.artifactsDir,
    runId: args.runId,
    onArtifact: args.onArtifact,
    cache: args.cache,
    cacheKey: args.cacheKey,
    onStepStart: args.onStepStart,
    onStepComplete: args.onStepComplete,
    onStepSkipped: args.onStepSkipped,
    onStepFailed: args.onStepFailed,
    runGateCommand: args.runGateCommand,
    onGateReport: args.onGateReport,
  }, args.maxTotalCostUsd)
}
