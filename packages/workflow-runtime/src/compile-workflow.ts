/**
 * Compile a declarative AIP-15 `WorkflowHandle` into a runnable
 * {@link RuntimeWorkflow} for {@link runWorkflow}. This is the bridge that makes
 * an authored WORKFLOW.md actually execute.
 *
 * AIP-15 leaves the IO seam (`step.inputs`, `map.over`, `loop.while`) to a
 * meta-validator. This compiler pins a concrete, minimal **reference grammar**
 * for it — the convention a manifest author writes:
 *
 *   - data refs:   `$input` · `$input.a.b` · `$steps.<id>` · `$steps.<id>.a`
 *                  · `$item` · `$item.a` · `$index`   (`$$` escapes a literal `$`)
 *   - `step.inputs`: a JSON object whose leaf strings may be refs (resolved
 *                    recursively); non-`$` strings are literals
 *   - `map.over`:    a ref to an array
 *   - `loop.while` / approval prompt: `<ref> <op> <literal>` (`== != < <= > >=`)
 *                    or a bare ref (truthiness)
 *
 * Scope: the **linear / structured subset** of AIP-15 — steps run in document
 * order; `map`/`loop`/`parallel` nest their child step lists. Non-linear `next`
 * gotos are rejected with a clear diagnostic. `kind:"branch"` compiles in its
 * **forward-only** form: every `branches[].next`/`default` must name a later
 * sibling in the SAME step list (not backward, not into a nested map/loop/
 * parallel body) — see `compileBranchChain` below. Compiling a full goto graph
 * (backward jumps, cross-scope targets) is a separable follow-up; hand-author
 * a `loop` step for retry-style control flow instead.
 */

import type { WorkflowHandle } from "@agentproto/workflow"
import type { DriverHandle } from "@agentproto/driver"
import type { ToolHandle } from "@agentproto/tool"
import type { AgentRefResolution, AgentStep, Bindings, GateStep, RunStep, RuntimeWorkflow } from "./types.js"
import { buildAgentStep } from "./build-agent-step.js"

export interface CompileWorkflowOptions {
  /** TOOL contracts by id — each `tool` step resolves its handle here. */
  tools: ReadonlyMap<string, ToolHandle> | Record<string, ToolHandle>
  /** DRIVER candidates the resolver dispatches over for every tool step. */
  candidates: readonly DriverHandle[]
  /** Resolve a tool step's injected context (live capabilities) from bindings. */
  contextFor?: (toolId: string, bindings: Bindings) => unknown
  /** Sub-workflows by id, for `subworkflow` steps. */
  workflows?:
    | ReadonlyMap<string, WorkflowHandle>
    | Record<string, WorkflowHandle>
  /** App-scoped agent ids for a declarative `kind:"agent"` step's
   *  `agent.ref` — e.g. `{ "@app/reviewer": { adapter: "mastra-agent",
   *  options: { agent: "<dir>/.agentproto/agents/reviewer/AGENT.md" } } }`.
   *  Built by the host from its own app-install state (see
   *  `@agentproto/runtime`'s `resolveAgentRefsForWorkflow`). A step using
   *  `agent.ref` with this unset, or naming a ref this map doesn't have,
   *  fails compilation — never the runtime. */
  agentRefs?: ReadonlyMap<string, AgentRefResolution> | Record<string, AgentRefResolution>
}

export class WorkflowCompileError extends Error {
  constructor(message: string) {
    super(`compileWorkflow: ${message}`)
    this.name = "WorkflowCompileError"
  }
}

// ── reference + predicate resolution (the AIP-16 IO seam) ────────────

const get = <T>(
  m: ReadonlyMap<string, T> | Record<string, T>,
  key: string,
): T | undefined =>
  m instanceof Map ? m.get(key) : (m as Record<string, T>)[key]

function dig(value: unknown, path: readonly string[]): unknown {
  let v = value
  for (const seg of path) {
    if (v == null) return undefined
    v = (v as Record<string, unknown>)[seg]
  }
  return v
}

/** Resolve a single `$…` reference string against the run bindings. */
export function resolveRef(ref: string, b: Bindings): unknown {
  if (ref === "$index") return b.index
  const m = ref.match(/^\$(input|item|steps)((?:\.[^.]+)*)$/)
  if (!m) throw new WorkflowCompileError(`bad reference '${ref}'`)
  const segs = m[2] ? m[2].slice(1).split(".") : []
  switch (m[1]) {
    case "input":
      return dig(b.input, segs)
    case "item":
      return dig(b.item, segs)
    case "steps": {
      const [stepId, ...rest] = segs
      if (!stepId) throw new WorkflowCompileError(`'$steps' needs a step id`)
      return dig(b.steps[stepId], rest)
    }
  }
}

/** Recursively resolve a value node: refs in strings, into arrays/objects. */
export function resolveValue(node: unknown, b: Bindings): unknown {
  if (typeof node === "string") {
    if (node.startsWith("$$")) return node.slice(1) // $$ → literal $
    if (node.startsWith("$")) return resolveRef(node, b)
    return node
  }
  if (Array.isArray(node)) return node.map((n) => resolveValue(n, b))
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>))
      out[k] = resolveValue(v, b)
    return out
  }
  return node
}

/** Like {@link resolveRef} but reports whether the referenced path actually
 *  exists in the bindings — a strict subworkflow projection uses this to turn
 *  a silently-`undefined` reference into a named error instead. */
function refPathExists(ref: string, b: Bindings): boolean {
  const m = ref.match(/^\$(input|item|steps)((?:\.[^.]+)*)$/)
  if (!m) return false
  const segs = m[2] ? m[2].slice(1).split(".") : []
  let v: unknown
  if (m[1] === "steps") {
    const [stepId, ...rest] = segs
    if (!stepId || !(stepId in b.steps)) return false
    v = b.steps[stepId]
    segs.length = 0
    segs.push(...rest)
  } else {
    v = m[1] === "input" ? b.input : b.item
  }
  for (const seg of segs) {
    if (v === null || typeof v !== "object") return false
    const o = v as Record<string, unknown>
    if (!(seg in o)) return false
    v = o[seg]
  }
  return true
}

/** Strict variant of {@link resolveValue} for a subworkflow step's input
 *  projection: an exact `$…` reference that resolves to `undefined` AND names
 *  a path that doesn't exist in the bindings is a hard error naming the step
 *  and key — never a silent `undefined` handed to the child. */
export function resolveValueStrict(node: unknown, b: Bindings, label: string): unknown {
  if (typeof node === "string") {
    if (node.startsWith("$$")) return node.slice(1) // $$ → literal $
    if (node.startsWith("$")) {
      const v = resolveRef(node, b)
      if (v === undefined && !refPathExists(node, b)) {
        throw new WorkflowCompileError(
          `${label}: reference '${node}' resolves to nothing — the referenced field does not exist`,
        )
      }
      return v
    }
    return node
  }
  if (Array.isArray(node)) return node.map((n) => resolveValueStrict(n, b, label))
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>))
      out[k] = resolveValueStrict(v, b, label)
    return out
  }
  return node
}

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, c) => a < c,
  "<=": (a, c) => a <= c,
  ">": (a, c) => a > c,
  ">=": (a, c) => a >= c,
}

function literal(token: string, b: Bindings): unknown {
  if (token.startsWith("$")) return resolveRef(token, b)
  if (token === "true") return true
  if (token === "false") return false
  if (token === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token)
  return token.replace(/^['"]|['"]$/g, "")
}

/** Evaluate a `while`/`when` predicate string against the bindings. */
export function evalPredicate(expr: string, b: Bindings): boolean {
  const m = expr.match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/)
  if (!m) return Boolean(literal(expr.trim(), b)) // bare ref → truthiness
  const left = literal(m[1]!.trim(), b)
  const right = literal(m[3]!.trim(), b)
  switch (m[2]) {
    case "==":
      return left === right
    case "!=":
      return left !== right
    default: {
      const cmp = COMPARATORS[m[2]!]!
      return cmp(Number(left), Number(right))
    }
  }
}

// ── step compilation ─────────────────────────────────────────────────

/** AIP step ids may be paths/refs; the runtime key is the last segment. */
function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  const slash = s.lastIndexOf("/")
  return slash === -1 ? s : s.slice(slash + 1)
}

// AIP step frontmatter leaves IO fields as opaque `{}`; read them dynamically.
const f = <T>(step: object, key: string): T =>
  (step as Record<string, unknown>)[key] as T

function assertLinear(steps: readonly { id: string; kind: string; next?: string }[]): void {
  steps.forEach((s, i) => {
    const next = (s as { next?: string }).next
    const followingId = steps[i + 1]?.id
    if (next && next !== followingId) {
      throw new WorkflowCompileError(
        `step '${s.id}' has a non-linear next='${next}' — the structured-subset ` +
          `compiler only runs steps in document order. Hand-author a BranchStep ` +
          `or nest structurally.`,
      )
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectStepIds(steps: any[], ids: Set<string> = new Set()): Set<string> {
  for (const s of steps) {
    if (typeof s?.id === "string") ids.add(s.id)
    if (Array.isArray(s?.steps)) collectStepIds(s.steps, ids)
    if (Array.isArray(s?.branches)) {
      for (const br of s.branches) {
        if (Array.isArray(br?.steps)) collectStepIds(br.steps, ids)
      }
    }
  }
  return ids
}

/** Statically reject a `$steps.<id>` reference to a step id that doesn't
 *  exist anywhere in this workflow — the same typo class an unresolved
 *  reference would otherwise silently pass through as `undefined` at
 *  runtime. */
function assertKnownStepRefs(node: unknown, knownStepIds: ReadonlySet<string>, label: string): void {
  if (typeof node === "string") {
    if (node.startsWith("$$")) return
    const m = node.match(/^\$steps\.([^.]+)/)
    if (m && !knownStepIds.has(m[1]!)) {
      throw new WorkflowCompileError(
        `${label} references unknown step '${m[1]}' via '${node}' — no step with that id exists in this workflow`,
      )
    }
    return
  }
  if (Array.isArray(node)) {
    node.forEach((n) => assertKnownStepRefs(n, knownStepIds, label))
    return
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) assertKnownStepRefs(v, knownStepIds, label)
  }
}

/** Per-compile context: the public options plus the full set of step ids
 *  declared anywhere in THIS workflow (recomputed fresh for each nested
 *  `subworkflow` child, which has its own id namespace). */
interface Ctx {
  opts: CompileWorkflowOptions
  knownStepIds: ReadonlySet<string>
}

export function compileWorkflow(
  handle: WorkflowHandle,
  opts: CompileWorkflowOptions,
): RuntimeWorkflow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = handle.steps as unknown as any[]
  if (handle.start && handle.start !== steps[0]?.id) {
    throw new WorkflowCompileError(
      `start='${handle.start}' is not the first step — structured-subset runs in order`,
    )
  }
  const ctx: Ctx = { opts, knownStepIds: collectStepIds(steps) }
  // `result` is the optional output value-expression (AIP-15): map it through
  // the same ref grammar as a step's inputs. Absent ⇒ no output selector, so
  // runWorkflow falls back to the final step's result.
  const result = (handle as { result?: unknown }).result
  const output =
    result !== undefined ? (b: Bindings) => resolveValue(result, b) : undefined
  return {
    id: handle.id,
    description: handle.description,
    steps: compileSiblingsToSteps(steps, ctx),
    ...(output ? { output } : {}),
  }
}

/**
 * Compile a sibling step list in document order. A `kind:"branch"` step
 * swallows every sibling after it at this level (they're reachable only
 * through its arms — see {@link compileBranchChain}), so this stops emitting
 * as soon as it hits one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileSiblingsToSteps(steps: any[], ctx: Ctx): RunStep[] {
  assertLinear(steps)
  const out: RunStep[] = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.kind === "branch") {
      out.push(compileBranchChain(steps, i, ctx))
      return out
    }
    out.push(compileStep(s, ctx))
  }
  return out
}

function compileStepList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: any[],
  id: string,
  ctx: Ctx,
): RunStep {
  const compiled = compileSiblingsToSteps(steps, ctx)
  if (compiled.length === 1) return compiled[0]!
  return { kind: "group", id, steps: compiled }
}

/**
 * Compile a forward-only goto `kind:"branch"` step (index `i` in `steps`)
 * into a nested runtime {@link BranchStep} chain: `branches[]` evaluate in
 * order, the first truthy `when` jumps to its `next` sibling and falls
 * through in document order from there; no match jumps to `default` (or
 * falls through to `i + 1`). Every target MUST be a later sibling in this
 * SAME list — an unknown id, a backward target, or a target inside a nested
 * map/loop/parallel body all fail compilation here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileBranchChain(steps: any[], i: number, ctx: Ctx): RunStep {
  const branchStep = steps[i]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const branches = f<{ when: string; next: string }[]>(branchStep, "branches")
  const defaultTarget = f<string | undefined>(branchStep, "default")

  const resolveTarget = (targetId: string, label: string): number => {
    const idx = steps.findIndex((s) => s.id === targetId)
    if (idx === -1 || idx <= i) {
      throw new WorkflowCompileError(
        `branch '${branchStep.id}' ${label} targets '${targetId}', which is not a sibling later in this ` +
          `step list — the forward-only branch compiler only supports jumping to a later sibling in the ` +
          `SAME list (not backward, and not into a nested map/loop/parallel body). Hand-author a 'loop' ` +
          `step for retry-style control flow instead.`,
      )
    }
    return idx
  }

  const defaultIdx = defaultTarget !== undefined ? resolveTarget(defaultTarget, "default") : i + 1
  let otherwise: RunStep[] = compileSiblingsToSteps(steps.slice(defaultIdx), ctx)

  for (let k = branches.length - 1; k >= 0; k--) {
    const br = branches[k]!
    const targetIdx = resolveTarget(br.next, `branches[${k}].next`)
    const thenSteps = compileSiblingsToSteps(steps.slice(targetIdx), ctx)
    const condExpr = br.when
    const nodeId = k === 0 ? branchStep.id : `${branchStep.id}__branch${k}`
    otherwise = [
      {
        kind: "branch",
        id: nodeId,
        cond: (b: Bindings) => evalPredicate(condExpr, b),
        then: thenSteps,
        ...(otherwise.length > 0 ? { otherwise } : {}),
      },
    ]
  }
  return otherwise[0]!
}

/**
 * Compile a declarative `kind:"agent"` manifest step — `{ agent: { ref },
 * prompt, adapter?, sessionRef?, sandbox?, cacheable?, policy?, outputSchema?,
 * maxRetries? }` — into a real {@link AgentStep}. `prompt` runs through the
 * same `$input`/`$steps.<id>` ref grammar as a `tool` step's `inputs`.
 * `agent.ref` resolves via `opts.agentRefs` — unresolvable (no map, or an id
 * the map doesn't have) fails HERE, at compile time, never at the runtime
 * spawn.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileAgentStep(step: any, id: string, ctx: Ctx): AgentStep {
  const opts = ctx.opts
  const prompt = f<string>(step, "prompt")
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new WorkflowCompileError(`agent step '${id}' needs a non-empty 'prompt'`)
  }

  let adapter: string | undefined = typeof step.adapter === "string" ? step.adapter : undefined
  let options: Record<string, boolean | number | string> | undefined =
    step.options !== undefined ? step.options : undefined

  const agentRef: unknown = step.agent?.ref
  if (agentRef !== undefined) {
    if (typeof agentRef !== "string" || agentRef.trim().length === 0) {
      throw new WorkflowCompileError(`agent step '${id}' has an empty 'agent.ref'`)
    }
    const resolved = opts.agentRefs ? get(opts.agentRefs, agentRef) : undefined
    if (!resolved) {
      const available = opts.agentRefs
        ? opts.agentRefs instanceof Map
          ? [...opts.agentRefs.keys()]
          : Object.keys(opts.agentRefs)
        : []
      throw new WorkflowCompileError(
        `agent step '${id}' references unknown agent ref '${agentRef}'` +
          (available.length > 0
            ? ` — available refs: ${available.join(", ")}`
            : " — no agent refs are configured for this compile (not running in an app context?)"),
      )
    }
    adapter = resolved.adapter
    options = resolved.options
  }

  return buildAgentStep(id, {
    prompt: (b: Bindings) => String(resolveValue(prompt, b)),
    ...(adapter !== undefined ? { adapter } : {}),
    ...(step.sessionRef !== undefined ? { sessionRef: step.sessionRef } : {}),
    ...(step.sandbox !== undefined ? { sandbox: step.sandbox } : {}),
    ...(step.cacheable ? { cacheable: true } : {}),
    ...(options !== undefined ? { options } : {}),
    policy: step.policy,
    ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
    ...(step.maxRetries !== undefined ? { maxRetries: step.maxRetries } : {}),
    ...(step.harness !== undefined ? { harness: step.harness } : {}),
  })
}

/**
 * Compile a declarative `kind:"gate"` manifest step — `{ command, args?,
 * cwd?, report?, timeout_ms?, retry?, on_fail? }` — into a real
 * {@link GateStep}. `command` is re-validated here (compile time) even
 * though `@agentproto/workflow`'s `defineWorkflow` already rejects an
 * empty one at LOAD time — an ENTRY-based handle that hand-builds a gate
 * step in TS bypasses that manifest-only check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileGateStep(step: any, id: string): GateStep {
  const command = f<string>(step, "command")
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new WorkflowCompileError(`gate step '${id}' needs a non-empty 'command'`)
  }
  const args = f<string[] | undefined>(step, "args")
  const cwd = f<string | undefined>(step, "cwd")
  const reportPath = f<string | undefined>(step, "report")
  const timeoutMs = f<number | undefined>(step, "timeout_ms")
  const retry = f<
    { max_attempts: number; backoff: "fixed" | "exponential"; initial_ms?: number } | undefined
  >(step, "retry")
  const onFail = f<{ reprompt: string; with?: Record<string, unknown> } | undefined>(
    step,
    "on_fail",
  )
  return {
    kind: "gate",
    id,
    command,
    ...(args !== undefined ? { args } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retry !== undefined
      ? {
          retry: {
            maxAttempts: retry.max_attempts,
            backoff: retry.backoff,
            ...(retry.initial_ms !== undefined ? { initialMs: retry.initial_ms } : {}),
          },
        }
      : {}),
    ...(onFail !== undefined
      ? { onFail: { reprompt: onFail.reprompt, ...(onFail.with !== undefined ? { with: onFail.with } : {}) } }
      : {}),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileStep(step: any, ctx: Ctx): RunStep {
  const opts = ctx.opts
  const id: string = step.id
  switch (step.kind) {
    case "tool": {
      const ref = typeof step.tool === "string" ? step.tool : step.tool.entry
      const toolId = normalizeToolId(ref)
      const tool = get(opts.tools, toolId)
      if (!tool)
        throw new WorkflowCompileError(`no tool registered for '${toolId}'`)
      const inputs = f<unknown>(step, "inputs") ?? {}
      assertKnownStepRefs(inputs, ctx.knownStepIds, `tool step '${id}' inputs`)
      return {
        kind: "tool",
        id,
        tool,
        candidates: opts.candidates,
        input: (b) => resolveValue(inputs, b),
        context: opts.contextFor
          ? (b) => opts.contextFor!(toolId, b)
          : undefined,
      }
    }

    case "map": {
      const over = f<string>(step, "over")
      const inner = compileStepList(f(step, "steps"), `${id}__body`, ctx)
      const onError = f<"throw" | "collect" | undefined>(step, "onError")
      return {
        kind: "map",
        id,
        parallelism: f<number | undefined>(step, "parallelism"),
        over: (b) => resolveRef(over, b) as readonly unknown[],
        body: () => inner,
        ...(onError !== undefined ? { onError } : {}),
      }
    }

    case "loop": {
      const whileExpr = f<string>(step, "while")
      return {
        kind: "loop",
        id,
        maxIterations: f<number>(step, "max_iterations"),
        while: (b) => evalPredicate(whileExpr, b),
        body: [compileStepList(f(step, "steps"), `${id}__body`, ctx)],
      }
    }

    case "parallel": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const branches = f<any[]>(step, "branches")
      return {
        kind: "parallel",
        id,
        branches: branches.map((br) => ({
          id: br.id,
          steps: [compileStepList(br.steps, `${id}__${br.id}`, ctx)],
        })),
      }
    }

    case "approval": {
      const prompt = f<string>(step, "prompt")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const approvers = (f<any[]>(step, "approvers") ?? []).map(
        (a) => a.role ?? a.userId ?? String(a),
      )
      return {
        kind: "approval",
        id,
        approvers,
        prompt: (b) => String(resolveValue(prompt, b)),
      }
    }

    case "suspend": {
      const resume = f<{ on: string[]; timeout_ms?: number }>(step, "resume")
      return { kind: "suspend", id, on: resume.on, timeoutMs: resume.timeout_ms }
    }

    case "subworkflow": {
      const wfId = f<string>(step, "workflow")
      const child = opts.workflows ? get(opts.workflows, wfId) : undefined
      if (!child)
        throw new WorkflowCompileError(
          `subworkflow '${wfId}' not found — pass it in opts.workflows`,
        )
      const compiledChild = compileWorkflow(child, opts)
      // `inputs` is an optional projection into the child's `$input` — the
      // same ref grammar as a `tool` step's `inputs` (refs resolved against
      // THIS (parent) workflow's bindings). Absent ⇒ today's behavior: the
      // child runs with the parent's own workflow input, unchanged.
      const inputs = f<unknown>(step, "inputs")
      if (inputs === undefined) {
        return { kind: "subworkflow", id, workflow: compiledChild }
      }
      assertKnownStepRefs(inputs, ctx.knownStepIds, `subworkflow step '${id}' inputs`)
      const entries = Object.entries(inputs as Record<string, unknown>)
      return {
        kind: "subworkflow",
        id,
        workflow: compiledChild,
        // Each top-level key resolves strictly: a missing referenced field
        // throws at run time naming this step + key (no silent `undefined`).
        input: (b) => {
          const out: Record<string, unknown> = {}
          for (const [k, v] of entries)
            out[k] = resolveValueStrict(v, b, `subworkflow step '${id}' input key '${k}'`)
          return out
        },
      }
    }

    case "agent": {
      // Two shapes reach here under the same `kind:"agent"`: an ENTRY-based
      // handle's already-built runtime AgentStep (function-valued `prompt`
      // selector — nothing declarative left to resolve, pass through
      // unchanged), or a purely-declarative manifest step (`prompt` is a
      // plain string) that this compiler must turn into a real AgentStep,
      // the same way `translateStages` does for `workflow_start`.
      if (typeof step.prompt === "function") {
        const passthrough: RunStep = step
        return passthrough
      }
      return compileAgentStep(step, id, ctx)
    }

    case "gate":
      return compileGateStep(step, id)

    case "transform": {
      // Not a declarative manifest kind — no string expression language for
      // `compute` — so it only reaches the compiler from an ENTRY-based
      // handle, already built as a runtime TransformStep (function-valued
      // `compute`). Passes through unchanged: this is what lets an entry.mjs
      // step shape/serialize an earlier tool step's output (e.g.
      // `JSON.stringify` a prior `$steps.<id>` value) for a later tool step
      // to consume as a plain string input, something the `$steps.*` ref
      // grammar alone can't do. `step` is `any`, so no cast is needed.
      const passthrough: RunStep = step
      return passthrough
    }

    case "branch":
      // Unreachable through the normal entry points: `compileSiblingsToSteps`
      // intercepts every `branch` step and routes it to `compileBranchChain`
      // before it would ever reach here (that's what makes the forward-only
      // swallow-the-rest-of-the-list semantics work). A direct call would be
      // an internal invariant violation, not a manifest problem.
      throw new WorkflowCompileError(
        `internal: branch step '${id}' reached compileStep directly — branch ` +
          `steps must be compiled via the sibling-list walker`,
      )

    default:
      throw new WorkflowCompileError(
        `unsupported step kind '${step.kind}' (step '${id}')`,
      )
  }
}
