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

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/
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
 * Conformance highlights ([§ Conformance rules](https://agentproto.sh/docs/aip-14)):
 *  - No `execute` field on the contract — bodies are providers' job.
 *  - `defineTool` MUST refuse a definition carrying `execute` (migration error).
 *  - No I/O at module load — `defineTool(...)` is pure construction.
 */
export function defineTool<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(
  definition: ToolDefinition<TInput, TOutput, TContext>
): ToolHandle<TInput, TOutput, TContext> {
  if (!ID_RE.test(definition.id)) {
    throw new Error(
      `defineTool: invalid id '${definition.id}' — must match ${ID_RE}`
    )
  }
  if (!definition.description || definition.description.length > 2000) {
    throw new Error(
      `defineTool: id='${definition.id}' description must be 1–2000 chars`
    )
  }
  // Migration guard: catch authors trying to ship a body on the contract.
  // The body lives on a PROVIDER (per AIP-30); reject at construction.
  if ("execute" in (definition as unknown as Record<string, unknown>)) {
    throw new Error(
      `defineTool: id='${definition.id}' carries an 'execute' property. ` +
        `Bodies live on AIP-30 PROVIDER manifests, not on the TOOL contract. ` +
        `See https://agentproto.sh/docs/aip-30 for migration.`
    )
  }

  const constraints = freezeProviderConstraints(definition.driverConstraints)

  const handle: ToolHandle<TInput, TOutput, TContext> = Object.freeze({
    id: definition.id,
    name: definition.name ?? definition.id,
    description: definition.description,
    version: definition.version,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    contextSchema: definition.contextSchema,
    mutates: Object.freeze([...(definition.mutates ?? [])]),
    requires: freezeCapabilities(definition.requires),
    approval: defaultApproval(definition.approval, definition.mutates),
    riskLevel: definition.riskLevel ?? 0,
    costClass: definition.costClass ?? "trivial",
    timeoutMs: definition.timeoutMs ?? 30_000,
    retry: definition.retry,
    tags: Object.freeze([...(definition.tags ?? [])]),
    metadata: Object.freeze({ ...(definition.metadata ?? {}) }),
    idempotent: definition.idempotent ?? false,
    defaultDriver: definition.defaultDriver,
    driverConstraints: constraints,
  })

  return handle
}

/**
 * Validate input against a tool's `inputSchema`. Returns a typed
 * {@link ValidationResult}; provider runtimes MUST call this BEFORE
 * dispatching to the provider's body.
 */
export function validateInput<TInput>(
  handle: Pick<ToolHandle<TInput>, "id" | "inputSchema">,
  input: unknown
): ValidationResult<TInput> {
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

/**
 * Validate context against a tool's `contextSchema` (when declared).
 * Returns a typed {@link ValidationResult}; provider runtimes MUST
 * call this BEFORE dispatching when the contract has a contextSchema.
 *
 * Tools without a contextSchema accept any context shape; this helper
 * returns the input verbatim in that case.
 */
export function validateContext<TContext extends ToolContext = ToolContext>(
  handle: Pick<ToolHandle<unknown, unknown, TContext>, "id" | "contextSchema">,
  context: unknown
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
 * {@link ValidationResult}; provider runtimes MUST call this AFTER
 * the body returns and BEFORE handing the value to the caller.
 *
 * On failure, hosts SHOULD throw {@link ToolError} with code
 * `"output_invalid"` — the tool produced a contract violation.
 */
export function validateOutput<TOutput>(
  handle: Pick<ToolHandle<unknown, TOutput>, "id" | "outputSchema">,
  output: unknown
): TOutput {
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

function defaultApproval(
  declared: ApprovalClass | undefined,
  mutates: readonly string[] | undefined
): ApprovalClass {
  if (declared) return declared
  return mutates && mutates.length > 0 ? "on-mutate" : "auto"
}

function freezeCapabilities(
  caps: ToolCapabilities | undefined
): Readonly<ToolCapabilities> {
  return Object.freeze({
    network: Object.freeze([...(caps?.network ?? [])]),
    secrets: Object.freeze([...(caps?.secrets ?? [])]),
    tools: Object.freeze([...(caps?.tools ?? [])]),
  })
}

function freezeProviderConstraints(
  c: DriverConstraints | undefined
): Required<DriverConstraints> {
  const forbid = (c?.forbid ?? []).filter((k): k is DriverKind =>
    PROVIDER_KINDS.includes(k as DriverKind)
  )
  const requireKind = (c?.requireKind ?? []).filter((k): k is DriverKind =>
    PROVIDER_KINDS.includes(k as DriverKind)
  )
  return Object.freeze({
    forbid: Object.freeze(forbid) as readonly DriverKind[],
    requireKind: Object.freeze(requireKind) as readonly DriverKind[],
  })
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
): string {
  return issues
    .map(i => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ")
}

export type { ZodType }
