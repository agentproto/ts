/**
 * @agentproto/adapter-mastra — Mastra adapter for AIP-30
 * `ToolImplementation`s.
 *
 * One function: {@link toMastraTool} takes a typed `ToolImplementation`
 * (an `(contract, body)` pair produced by
 * {@link "@agentproto/driver".implementTool}) and returns a Mastra
 * `createTool({...})` result. Same role as the AI SDK / LangChain
 * adapters — re-express the canonical typed binding in a host
 * framework's tool shape, without re-declaring the contract metadata.
 *
 * Why `ToolImplementation` (not `(handle, execute)`) is the input:
 * the typed binding flows the contract's `inputSchema`, `outputSchema`,
 * and `contextSchema` generics into the body, so the compiler enforces
 * shape match between body and contract — Solidity's `is IERC20`
 * pattern in TS. An adapter that consumed handle + execute separately
 * would defeat that guarantee.
 *
 * Resolver / multi-provider dispatch: when the body should pick a
 * provider per call instead of being statically bound, the caller
 * wraps `runTool` in `implementTool` once — the adapter is unchanged.
 *
 * ```ts
 * import { implementTool, runTool } from "@agentproto/driver"
 *
 * // Static body:
 * const impl = implementTool(handle, async ({ input, context }) => …)
 *
 * // Resolver-driven body:
 * const dispatchImpl = implementTool(handle, async args =>
 *   runTool({ tool: handle, candidates: [...], ...args })
 * )
 * ```
 *
 * Spec: https://agentproto.sh/docs/aip-14, https://agentproto.sh/docs/aip-30
 */

import { createTool } from "@mastra/core/tools"
import { toToolError, type ToolContext } from "@agentproto/tool"
import type {
  DriverContext,
  ToolImplementation,
} from "@agentproto/driver"

/**
 * Default {@link DriverContext} used when the caller doesn't pass
 * one. `kind: "builtin"` reflects the typical adapter use-case
 * (in-process bodies that don't read provider secrets / sandbox
 * handles). Override via `bind.driverCtx` for non-builtin bodies.
 */
const DEFAULT_PROVIDER_CTX: DriverContext = Object.freeze({
  secrets: {},
  authState: "authed",
  providerId: "mastra-adapter",
  driverKind: "builtin",
  implementsEntry: { tool: "mastra-adapter", version: "0.0.0" },
})

/**
 * Per-call context source. Two modes:
 *
 *  - **Static** (`{ context }`) — bind a fixed `TContext` once at
 *    adapter time. Same value for every invocation. Use for tools
 *    whose context is process-scoped (e.g. `governanceConfig` from
 *    a single workspace).
 *
 *  - **Dynamic** (`{ fromMastraContext }`) — resolve `TContext`
 *    per-call from Mastra's native execution context (agent,
 *    workflow, requestContext, observability). Use when context
 *    depends on per-request state (multi-tenant `guildId`, scoped
 *    DB connections, …).
 */
export type MastraContextSource<TContext extends ToolContext> =
  | { context: TContext }
  | { fromMastraContext: (mastraContext: unknown) => TContext }

export interface ToMastraToolOptions<TContext extends ToolContext> {
  /** Where the body's `context` arg comes from per call. */
  source: MastraContextSource<TContext>
  /** Optional provider context (for non-builtin bodies). */
  driverCtx?: DriverContext
}

/**
 * Adapt a {@link ToolImplementation} into a Mastra tool.
 *
 * Type inference: `TContext` is inferred from `impl` only —
 * `options.source` is wrapped in `NoInfer<>` so a literal context
 * doesn't narrow the contract's `TContext` and reject an impl whose
 * body accepts a broader set (TS contravariant-position bug otherwise).
 *
 * Drop the result into `agent.stream({ tools: { [id]: adapted } })`
 * or pass to Mastra's tool registry directly — same shape as
 * authoring with `createTool` by hand, minus the duplication of
 * contract metadata and minus the type drift risk between contract
 * and body.
 */
export function toMastraTool<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(
  impl: ToolImplementation<TInput, TOutput, TContext>,
  options: ToMastraToolOptions<NoInfer<TContext>>
): ReturnType<typeof createTool> {
  return createTool({
    id: impl.tool.id,
    description: impl.tool.description,
    inputSchema: impl.tool.inputSchema,
    outputSchema: impl.tool.outputSchema,
    execute: async (inputData, mastraContext) => {
      // Pull context per-call: static binding closes over `options.source.context`;
      // dynamic binding reads from Mastra's native context.
      const context: TContext =
        "context" in options.source
          ? options.source.context
          : options.source.fromMastraContext(mastraContext)

      // Mastra validates `inputData` against `inputSchema` BEFORE
      // calling execute, so the structural shape matches `TInput` at
      // this point. The local typed binding documents the post-
      // validation contract.
      const typedInput: TInput = inputData as TInput

      try {
        return await impl.body({
          input: typedInput,
          context,
          driverCtx: options.driverCtx ?? DEFAULT_PROVIDER_CTX,
          signal:
            (mastraContext as { abortSignal?: AbortSignal } | undefined)
              ?.abortSignal ?? new AbortController().signal,
        })
      } catch (thrown) {
        // Re-throw as a structured error; Mastra catches and surfaces.
        throw toToolError(thrown)
      }
    },
  })
}

export { ToolError } from "@agentproto/tool"
export type { ToolImplementation } from "@agentproto/driver"
