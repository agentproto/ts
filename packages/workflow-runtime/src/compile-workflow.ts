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
 * gotos and goto-style `branch` routing are rejected with a clear diagnostic
 * (hand-author a structured `BranchStep`, or nest). Compiling the full goto
 * graph is a separable follow-up.
 */

import type { WorkflowHandle } from "@agentproto/workflow"
import type { DriverHandle } from "@agentproto/driver"
import type { ToolHandle } from "@agentproto/tool"
import type { Bindings, RunStep, RuntimeWorkflow } from "./types.js"

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
  assertLinear(steps)
  // `result` is the optional output value-expression (AIP-15): map it through
  // the same ref grammar as a step's inputs. Absent ⇒ no output selector, so
  // runWorkflow falls back to the final step's result.
  const result = (handle as { result?: unknown }).result
  const output =
    result !== undefined ? (b: Bindings) => resolveValue(result, b) : undefined
  return {
    id: handle.id,
    description: handle.description,
    steps: steps.map((s) => compileStep(s, opts)),
    ...(output ? { output } : {}),
  }
}

function compileStepList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: any[],
  id: string,
  opts: CompileWorkflowOptions,
): RunStep {
  assertLinear(steps)
  if (steps.length === 1) return compileStep(steps[0], opts)
  return { kind: "group", id, steps: steps.map((s) => compileStep(s, opts)) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileStep(step: any, opts: CompileWorkflowOptions): RunStep {
  const id: string = step.id
  switch (step.kind) {
    case "tool": {
      const ref = typeof step.tool === "string" ? step.tool : step.tool.entry
      const toolId = normalizeToolId(ref)
      const tool = get(opts.tools, toolId)
      if (!tool)
        throw new WorkflowCompileError(`no tool registered for '${toolId}'`)
      const inputs = f<unknown>(step, "inputs") ?? {}
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
      const inner = compileStepList(f(step, "steps"), `${id}__body`, opts)
      return {
        kind: "map",
        id,
        parallelism: f<number | undefined>(step, "parallelism"),
        over: (b) => resolveRef(over, b) as readonly unknown[],
        body: () => inner,
      }
    }

    case "loop": {
      const whileExpr = f<string>(step, "while")
      return {
        kind: "loop",
        id,
        maxIterations: f<number>(step, "max_iterations"),
        while: (b) => evalPredicate(whileExpr, b),
        body: [compileStepList(f(step, "steps"), `${id}__body`, opts)],
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
          steps: [compileStepList(br.steps, `${id}__${br.id}`, opts)],
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
      return { kind: "subworkflow", id, workflow: compiledChild }
    }

    case "agent": {
      // `agent` is not a declarative manifest kind — it only reaches the
      // compiler from an ENTRY-based handle, where it is already a runtime
      // AgentStep (function-valued adapter/cwd/prompt selectors). There is
      // nothing declarative to resolve, so pass it through unchanged. This is
      // what lets a WORKFLOW.md whose entry.mjs is a chain of agent steps run
      // via startFromFile. `step` is `any`, so no cast is needed.
      const agent: RunStep = step
      return agent
    }

    case "branch":
      throw new WorkflowCompileError(
        `goto-style 'branch' (step '${id}') is unsupported in the structured ` +
          `subset — hand-author a structured BranchStep, or nest.`,
      )

    default:
      throw new WorkflowCompileError(
        `unsupported step kind '${step.kind}' (step '${id}')`,
      )
  }
}
