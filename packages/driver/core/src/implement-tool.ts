import type { ToolContext, ToolHandle } from "@agentproto/tool"
import type { ExecuteFn, DriverContext } from "./types.js"

/**
 * Body signature derived from a contract handle's generics.
 *
 * Analogous to a Solidity function `override` against an interface
 * declaration: `input` matches the contract's `inputSchema` type,
 * `context` matches `contextSchema`, and the return is checked against
 * `outputSchema`. Drift between the body and its contract is a compile
 * error, not a runtime one.
 *
 * Compare with the legacy {@link ExecuteFn} — `unknown`-typed inputs
 * that require manual `as InputType` casts at every body. That form
 * stays available for `.md`-driven dynamic loading where the contract
 * handle isn't in scope; TypeScript authors should prefer the typed
 * form via {@link implementTool}.
 */
export type TypedExecuteFn<TInput, TOutput, TContext extends ToolContext> = (
  args: {
    input: TInput
    context: TContext
    driverCtx: DriverContext
    signal: AbortSignal
  }
) => Promise<TOutput> | TOutput

/**
 * Typed `(contract, body)` pair — the missing "concrete tool" layer
 * between AIP-14 `ITool` (the contract handle) and AIP-30 PROVIDER
 * (the shared-infra bundle).
 *
 * Authored via {@link implementTool}, consumed by {@link defineDriver}
 * via `implementations: [...]` and by per-surface adapters
 * (`toAiSdkTool`, `toMastraTool`) that close the body over a
 * per-request `context`.
 */
export interface ToolImplementation<
  TInput = unknown,
  TOutput = unknown,
  TContext extends ToolContext = ToolContext,
> {
  /** The AIP-14 contract handle this implementation binds to. */
  readonly tool: ToolHandle<TInput, TOutput, TContext>
  /** Typed body — see {@link TypedExecuteFn}. */
  readonly body: TypedExecuteFn<TInput, TOutput, TContext>
}

/**
 * Bind a typed body to an AIP-14 `ITool` contract handle.
 *
 * Equivalent to Solidity's `MyToken is IERC20` pattern: the compiler
 * enforces that the body's input/output/context match the contract's
 * generics. No string-keyed indirection, no manual `as` casts at
 * call sites.
 *
 * The returned {@link ToolImplementation} is the canonical typed
 * binding; downstream surfaces consume it via:
 *
 * - {@link defineDriver} — bundle ≥1 implementations into a
 *   shared-infra provider for the AIP-30 resolver to dispatch through.
 * - `toAiSdkTool(impl, { context })` — adapt to AI SDK's
 *   `tool({...})` shape for `streamText` / `generateText` consumers.
 * - `toMastraTool(impl, { context })` — adapt to Mastra's `createTool`
 *   for `agent.stream` / `agent.generate` consumers.
 *
 * The same `impl` can be re-adapted with different per-request
 * contexts; the body is captured once and the context flows through
 * the closure each time.
 */
export function implementTool<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(
  tool: ToolHandle<TInput, TOutput, TContext>,
  body: TypedExecuteFn<TInput, TOutput, TContext>
): ToolImplementation<TInput, TOutput, TContext> {
  return Object.freeze({ tool, body })
}
