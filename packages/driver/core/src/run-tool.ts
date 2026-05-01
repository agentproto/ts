import {
  ToolError,
  validateContext,
  validateInput,
  validateOutput,
  type ToolContext,
  type ToolHandle,
} from "@agentproto/tool"
import { resolveDriver, type DriverAvailability } from "./resolver.js"
import type {
  ImplementsEntry,
  MappingValue,
  DriverContext,
  DriverHandle,
  ResolverContext,
} from "./types.js"

/**
 * End-to-end dispatch of a TOOL contract through the AIP-30 resolver.
 *
 *  1. Resolve a provider via the 6-phase resolver.
 *  2. Validate input + context against the contract's schemas (host's job, not provider's).
 *  3. Apply mapping + schema-narrowing (refuse calls using dropped inputs).
 *  4. Build per-call DriverContext (resolved secrets, signal).
 *  5. Invoke `provider.execute[tool.id]({ input, context, driverCtx, signal })`.
 *  6. Validate output against contract's outputSchema.
 *  7. Return the typed result.
 *
 * Errors throw {@link ToolError}; consumers wrap into the standard
 * `ToolResult<T>` envelope at the boundary.
 */
export async function runTool<TInput, TOutput, TContext extends ToolContext>(args: {
  tool: ToolHandle<TInput, TOutput, TContext>
  candidates: readonly DriverHandle[]
  input: unknown
  context?: unknown
  resolverContext?: ResolverContext
  availability?: Map<string, DriverAvailability>
  /** Resolved secrets to inject into DriverContext. */
  secrets?: Record<string, string>
  /** Caller-set abort signal. Must be honoured. */
  signal?: AbortSignal
}): Promise<TOutput> {
  const { tool, candidates, input, context = {} } = args
  const resolverContext = args.resolverContext ?? {}
  const signal = args.signal ?? new AbortController().signal

  // 1. Resolve.
  const inputKeys = isPlainObject(input) ? Object.keys(input) : []
  const resolution = resolveDriver({
    tool,
    candidates,
    context: resolverContext,
    inputKeys,
    availability: args.availability,
  })
  if (!resolution.ok) {
    throw new ToolError({
      code: resolution.error.code,
      message: resolution.error.message,
      cause: resolution.error.rejected,
    })
  }
  const { provider, implementsEntry } = resolution

  // 2. Validate input + context.
  const inputValidation = validateInput(tool, input)
  if (!inputValidation.ok) {
    throw new ToolError(inputValidation.error)
  }
  const contextValidation = validateContext(tool, context)
  if (!contextValidation.ok) {
    throw new ToolError(contextValidation.error)
  }

  // 3. Apply mapping. Schema-narrowing was already enforced in resolver
  //    Phase 1; mapping is the rename/transform pass.
  const mapped = applyMapping(inputValidation.value, implementsEntry.mapping)

  // 4. Build DriverContext.
  const driverCtx: DriverContext = {
    secrets: args.secrets ?? {},
    authState: "authed",
    providerId: provider.id,
    driverKind: provider.kind,
    implementsEntry,
  }

  // 5. Invoke.
  const executeFn = provider.execute[tool.id]
  if (!executeFn) {
    throw new ToolError({
      code: "execute_binding_mismatch",
      message: `provider '${provider.id}' has no execute['${tool.id}'] body`,
    })
  }
  const timeoutMs =
    provider.timeoutOverrideMs ??
    implementsEntry.timeoutOverrideMs ??
    tool.timeoutMs
  const rawOutput = await runWithTimeout(timeoutMs, signal, async sig =>
    executeFn({
      input: mapped,
      context: contextValidation.value,
      driverCtx,
      signal: sig,
    })
  )

  // 6. Validate output. Throws ToolError on mismatch.
  return validateOutput(tool, rawOutput)
}

/**
 * Apply the implements entry's `mapping` to the input shape. v1
 * supports identity rename (`prompt: prompt`), key rename
 * (`style: artistic_style`), and `{ from, transform }` (the runtime
 * looks up `transform` on the provider's transformer registry — out
 * of scope for v1; we pass through the original value).
 *
 * When `mapping` is omitted, the input is returned verbatim.
 */
export function applyMapping(
  input: unknown,
  mapping: Record<string, MappingValue> | undefined
): unknown {
  if (!mapping || !isPlainObject(input)) return input
  const out: Record<string, unknown> = {}
  // 1) Pass through unmapped keys verbatim.
  const mappedSrcKeys = new Set<string>()
  for (const [destKey, value] of Object.entries(mapping)) {
    if (typeof value === "string") mappedSrcKeys.add(value)
    else mappedSrcKeys.add(value.from)
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!mappedSrcKeys.has(k)) {
      out[k] = v
    }
  }
  // 2) Apply mapping.
  const inputObj = input as Record<string, unknown>
  for (const [destKey, value] of Object.entries(mapping)) {
    if (typeof value === "string") {
      // Identity / rename: out[destKey] = input[value]
      const srcKey = value
      if (srcKey in inputObj) out[destKey] = inputObj[srcKey]
    } else {
      // { from, transform } — v1 passes through; transformers reserved
      // for the kind-specific runtime to override (each runtime can
      // expose a transformer registry the entry's `metadata` keys into).
      if (value.from in inputObj) out[destKey] = inputObj[value.from]
    }
  }
  return out
}

async function runWithTimeout<T>(
  timeoutMs: number,
  parentSignal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal.aborted) controller.abort(parentSignal.reason)
  else parentSignal.addEventListener("abort", onParentAbort, { once: true })

  const timer = setTimeout(() => {
    controller.abort(new ToolError({ code: "timeout", message: `exceeded ${timeoutMs}ms` }))
  }, timeoutMs)

  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", onParentAbort)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export type { ImplementsEntry, DriverContext, DriverHandle, ResolverContext }
