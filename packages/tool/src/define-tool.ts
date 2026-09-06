import { createDoctype } from "@agentproto/define-doctype"
import Ajv from "ajv"
import type { ZodType } from "zod"
import { ToolError } from "./errors.js"
import type {
  ApprovalClass,
  DriverConstraints,
  DriverKind,
  ToolCapabilities,
  ToolContext,
  ToolDefinition,
  ToolHandle,
  ValidationResult,
} from "./types.js"

const PROVIDER_KINDS: readonly DriverKind[] = [
  "cli",
  "http",
  "mcp",
  "sdk",
  "builtin",
]

/**
 * AIP-14 reference implementation of `defineTool`.
 *
 * Returns a {@link ToolHandle} with defaults applied. The handle is a
 * pure contract — schemas, governance metadata, provider routing
 * hints. Bodies live on AIP-30 PROVIDER manifests; invocation goes
 * through provider-runtime's resolver.
 *
 * Built on `createDoctype` from `@agentproto/define-doctype`: the
 * id-pattern + description-length validation and the top-level
 * `Object.freeze` are shared with every other AIP defineX. The
 * spec-14-specific parts (migration guard for `execute`, defaulting
 * `approval` from `mutates`, freezing nested arrays/objects) live in
 * `validate` and `build` below.
 *
 * Conformance highlights ([§ Conformance rules](https://agentproto.sh/docs/aip-14)):
 *  - No `execute` field on the contract — bodies are providers' job.
 *  - `defineTool` MUST refuse a definition carrying `execute` (migration error).
 *  - No I/O at module load — `defineTool(...)` is pure construction.
 */
const constructTool = createDoctype<
  ToolDefinition<unknown, unknown, ToolContext>,
  ToolHandle<unknown, unknown, ToolContext>
>({
  aip: 14,
  name: "tool",
  validate(def) {
    // Migration guard: catch authors trying to ship a body on the contract.
    // The body lives on a PROVIDER (per AIP-30); reject at construction.
    if ("execute" in (def as unknown as Record<string, unknown>)) {
      throw new Error(
        `defineTool: id='${def.id}' carries an 'execute' property. ` +
          `Bodies live on AIP-30 PROVIDER manifests, not on the TOOL contract. ` +
          `See https://agentproto.sh/docs/aip-30 for migration.`,
      )
    }
  },
  build(def) {
    return {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description,
      version: def.version,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      inputs: def.inputs ? Object.freeze({ ...def.inputs }) : undefined,
      outputs: def.outputs ? Object.freeze({ ...def.outputs }) : undefined,
      contextSchema: def.contextSchema,
      mutates: Object.freeze([...(def.mutates ?? [])]),
      requires: freezeCapabilities(def.requires),
      approval: defaultApproval(def.approval, def.mutates),
      riskLevel: def.riskLevel ?? 0,
      costClass: def.costClass ?? "trivial",
      timeoutMs: def.timeoutMs ?? 30_000,
      retry: def.retry,
      tags: Object.freeze([...(def.tags ?? [])]),
      metadata: Object.freeze({ ...(def.metadata ?? {}) }),
      idempotent: def.idempotent ?? false,
      defaultImplementation: def.defaultImplementation,
      driverConstraints: freezeProviderConstraints(def.driverConstraints),
      transformers: def.transformers
        ? Object.freeze([...def.transformers])
        : undefined,
    }
  },
})

/**
 * Public-facing `defineTool` — typed wrapper around `constructTool`
 * that preserves the per-call `<TInput, TOutput, TContext>` inference
 * so callers don't write any generics. The wrapper exists purely for
 * generic propagation; the runtime body is the meta-factory above.
 */
export function defineTool<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(
  definition: ToolDefinition<TInput, TOutput, TContext>,
): ToolHandle<TInput, TOutput, TContext> {
  return constructTool(
    definition as ToolDefinition<unknown, unknown, ToolContext>,
  ) as unknown as ToolHandle<TInput, TOutput, TContext>
}

/**
 * Validate input against a tool's `inputSchema`. Returns a typed
 * {@link ValidationResult}; provider runtimes MUST call this BEFORE
 * dispatching to the provider's body.
 *
 * Priority:
 *  1. zod `inputSchema` (v0.1) — used when present.
 *  2. JSON Schema `inputs` (v0.2) — fallback for manifest-only tools.
 *  3. No schema — passthrough (returns `ok: true`).
 */
export function validateInput<TInput>(
  handle: Pick<ToolHandle<TInput>, "id" | "inputSchema" | "inputs">,
  input: unknown,
): ValidationResult<TInput> {
  if (handle.inputSchema) {
    const result = handle.inputSchema.safeParse(input)
    if (!result.success) {
      return {
        ok: false,
        error: {
          code: "input_invalid",
          message: `id='${handle.id}': ${formatZodIssues(result.error.issues)}`,
          cause: result.error.issues,
        },
      }
    }
    return { ok: true, value: result.data as TInput }
  }
  if (handle.inputs) {
    return validateJsonSchema<TInput>(handle.id, handle.inputs, input)
  }
  return { ok: true, value: input as TInput }
}

/**
 * Validate context against a tool's `contextSchema` (when declared).
 * Returns a typed {@link ValidationResult}; provider runtimes MUST
 * call this BEFORE dispatching when the contract has a contextSchema.
 *
 * Tools without a contextSchema accept any context shape; this helper
 * returns the input verbatim in that case.
 *
 * Context validation uses only zod (no JSON Schema fallback) — context
 * schemas are always authored in TS, never in manifests.
 */
export function validateContext<TContext extends ToolContext = ToolContext>(
  handle: Pick<ToolHandle<unknown, unknown, TContext>, "id" | "contextSchema">,
  context: unknown,
): ValidationResult<TContext> {
  if (!handle.contextSchema) {
    return { ok: true, value: context as TContext }
  }
  const result = handle.contextSchema.safeParse(context)
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "input_invalid",
        message: `id='${handle.id}': context does not match contextSchema — ${formatZodIssues(result.error.issues)}`,
        field: "context",
        cause: result.error.issues,
      },
    }
  }
  return { ok: true, value: result.data as TContext }
}

/**
 * Validate output against a tool's `outputSchema`. Returns the typed
 * value on success; throws {@link ToolError} with code `"output_invalid"`
 * on contract violation.
 *
 * Priority:
 *  1. zod `outputSchema` (v0.1) — used when present.
 *  2. JSON Schema `outputs` (v0.2) — fallback for manifest-only tools.
 *  3. No schema — passthrough (returns the value as-is).
 */
export function validateOutput<TOutput>(
  handle: Pick<ToolHandle<unknown, TOutput>, "id" | "outputSchema" | "outputs">,
  output: unknown,
): TOutput {
  if (handle.outputSchema) {
    const result = handle.outputSchema.safeParse(output)
    if (!result.success) {
      throw new ToolError({
        code: "output_invalid",
        message: `id='${handle.id}': provider produced output that does not match outputSchema — ${formatZodIssues(result.error.issues)}`,
        cause: result.error.issues,
      })
    }
    return result.data as TOutput
  }
  if (handle.outputs) {
    const result = validateJsonSchema<TOutput>(handle.id, handle.outputs, output)
    if (!result.ok) {
      throw new ToolError({
        code: "output_invalid",
        message: result.error.message,
        cause: result.error.cause,
      })
    }
    return result.value
  }
  return output as TOutput
}

function defaultApproval(
  declared: ApprovalClass | undefined,
  mutates: readonly string[] | undefined,
): ApprovalClass {
  if (declared) return declared
  return mutates && mutates.length > 0 ? "on-mutate" : "auto"
}

function freezeCapabilities(
  caps: ToolCapabilities | undefined,
): Readonly<ToolCapabilities> {
  return Object.freeze({
    network: Object.freeze([...(caps?.network ?? [])]),
    secrets: Object.freeze([...(caps?.secrets ?? [])]),
    tools: Object.freeze([...(caps?.tools ?? [])]),
  })
}

function freezeProviderConstraints(
  c: DriverConstraints | undefined,
): Required<DriverConstraints> {
  const forbid = (c?.forbid ?? []).filter((k): k is DriverKind =>
    PROVIDER_KINDS.includes(k as DriverKind),
  )
  const requireKind = (c?.requireKind ?? []).filter((k): k is DriverKind =>
    PROVIDER_KINDS.includes(k as DriverKind),
  )
  return Object.freeze({
    forbid: Object.freeze(forbid) as readonly DriverKind[],
    requireKind: Object.freeze(requireKind) as readonly DriverKind[],
  })
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ")
}

// Shared Ajv instance — created once at module load.
// allErrors: true so we surface all violations, not just the first.
const _ajv = new Ajv({ allErrors: true })

// Validator cache keyed by schema object identity. Avoids repeated _ajv.compile()
// calls (which go through Ajv's internal registry) and lets GC collect validators
// when a tool handle is no longer referenced.
const _validatorCache = new WeakMap<
  object,
  ReturnType<typeof _ajv.compile>
>()

function validateJsonSchema<T>(
  toolId: string,
  schema: Record<string, unknown>,
  value: unknown,
): ValidationResult<T> {
  let validate = _validatorCache.get(schema)
  if (!validate) {
    validate = _ajv.compile(schema as Parameters<typeof _ajv.compile>[0])
    _validatorCache.set(schema, validate)
  }
  const valid = validate(value)
  if (!valid) {
    const errors = validate.errors ?? []
    const message = errors
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ")
    return {
      ok: false,
      error: {
        code: "input_invalid",
        message: `id='${toolId}': ${message}`,
        cause: errors,
      },
    }
  }
  return { ok: true, value: value as T }
}

export type { ZodType }
