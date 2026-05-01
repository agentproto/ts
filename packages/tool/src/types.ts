import type { ZodType } from "zod"

/**
 * AIP-14 ToolDefinition — the abstract agent contract.
 *
 * Field set mirrors `TOOL.md` frontmatter so a manifest and a TS
 * module are interchangeable inputs to the runtime. The contract
 * carries identity, schemas, side-effect profile, approval class,
 * and resource budget — but **not** the body. Bodies live on
 * AIP-30 PROVIDER manifests + their `execute[<toolId>]` entries.
 *
 * Generic over context: tools that depend on host-injected state
 * (database connections, governance config, …) declare a
 * `contextSchema` — analogous to `inputSchema` but for the per-call
 * context object — and the host validates context against it before
 * dispatching to the resolved provider's body.
 */
export interface ToolDefinition<
  TInput = unknown,
  TOutput = unknown,
  TContext extends ToolContext = ToolContext,
> {
  /** Machine identifier. Lowercase, digits, dashes, dots. 2–80 chars. */
  id: string
  /** Human-readable display name. Optional; falls back to `id`. */
  name?: string
  /** One-paragraph purpose, written for the LLM caller. */
  description: string
  /** Spec version of THIS tool (semver). */
  version?: string

  /**
   * Input shape — zod schema in v0.1. Hosts validate args.input against
   * it before dispatching to the resolved provider; bodies MUST NOT
   * re-validate.
   *
   * v0.2 will also accept JSON Schema directly.
   */
  inputSchema: ZodType<TInput>
  outputSchema: ZodType<TOutput>

  /**
   * Optional context schema. When provided, the host validates
   * `args.context` against it before dispatching to the provider,
   * rejecting with `input_invalid` (field=`context`) on mismatch.
   * Providers receive the narrowed, typed context.
   */
  contextSchema?: ZodType<TContext>

  /** Resources the tool may modify. Format: `<class>:<scope>`. */
  mutates?: readonly string[]
  /** Capability requirements (governance/gating per AIP-7). */
  requires?: ToolCapabilities
  approval?: ApprovalClass
  riskLevel?: 0 | 1 | 2 | 3
  costClass?: "trivial" | "metered" | "expensive"
  /** Hard wall-clock contract ceiling. Providers MAY narrow; never widen. */
  timeoutMs?: number
  retry?: RetryPolicy
  /** Free-form discovery tags. */
  tags?: readonly string[]
  /** Free-form metadata under namespaced keys (`mastra.…`, `langchain.…`). */
  metadata?: Record<string, unknown>
  /** Whether retries are observably free of extra effect. Defaults to `false`. */
  idempotent?: boolean

  /**
   * Optional pin for the canonical provider. The AIP-30 resolver uses
   * this in Phase 5 (cost ranking) when no other signal differentiates
   * candidates. Null/undefined = pick by resolver policy.
   */
  defaultDriver?: string

  /**
   * Author-side allowlist/denylist on which provider kinds the contract
   * permits. Use to express "this tool MUST NOT be served via untrusted
   * HTTP" (`forbid: ["http"]`) for self-hosted-only contracts.
   */
  driverConstraints?: DriverConstraints
}

export type DriverKind = "cli" | "http" | "mcp" | "sdk" | "builtin"

export interface DriverConstraints {
  /** Provider kinds the contract refuses. */
  forbid?: readonly DriverKind[]
  /** Whitelist of allowed provider kinds. Empty/missing = all permitted. */
  requireKind?: readonly DriverKind[]
}

export type ToolContext = Record<string, unknown> & {
  signal?: AbortSignal
}

export type ApprovalClass = "auto" | "always" | "on-mutate" | `policy:${string}`

export interface ToolCapabilities {
  network?: readonly string[]
  secrets?: readonly string[]
  tools?: readonly string[]
}

export interface RetryPolicy {
  maxAttempts: number
  backoff: "fixed" | "exponential"
  initialMs: number
}

/**
 * The host-registrable contract handle returned by `defineTool`.
 *
 * Adapters (`toMastraTool`, …) AND provider runtimes (`http-runtime`,
 * `cli-runtime`, …) consume this shape. The handle does **not** carry
 * an invoke method — invocation goes through provider-runtime, which
 * resolves a provider per call and dispatches to its `execute[id]`.
 */
export interface ToolHandle<
  TInput = unknown,
  TOutput = unknown,
  TContext extends ToolContext = ToolContext,
> {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly inputSchema: ZodType<TInput>
  readonly outputSchema: ZodType<TOutput>
  readonly contextSchema?: ZodType<TContext>
  readonly mutates: readonly string[]
  readonly requires: ToolCapabilities
  readonly approval: ApprovalClass
  readonly riskLevel: 0 | 1 | 2 | 3
  readonly costClass: "trivial" | "metered" | "expensive"
  readonly timeoutMs: number
  readonly retry?: RetryPolicy
  readonly tags: readonly string[]
  readonly metadata: Record<string, unknown>
  readonly idempotent: boolean
  readonly defaultDriver?: string
  readonly driverConstraints: Required<DriverConstraints>
}

/**
 * Standard out-of-band result envelope. Provider runtimes wrap thrown
 * errors into this shape; consumers consume `ToolResult<T>` rather than
 * `Promise<T>`.
 */
export type ToolResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code: string
        message: string
        retryable?: boolean
        cause?: unknown
      }
    }

/**
 * Validation helpers exposed for provider-runtime to reuse the same
 * input/output/context validation logic AIP-14 prescribes. Provider
 * runtimes MUST validate args.input against `tool.inputSchema` and
 * (when declared) args.context against `tool.contextSchema` BEFORE
 * dispatching to a provider's body.
 */
export interface ValidationFailure {
  ok: false
  error: { code: "input_invalid"; message: string; field?: string; cause?: unknown }
}

export interface ValidationSuccess<T> {
  ok: true
  value: T
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure
