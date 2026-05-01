/**
 * @agentproto/adapter-ai-sdk — AI SDK adapter for AIP-30
 * `ToolImplementation`s.
 *
 * One function: {@link toAiSdkTool} takes a typed `ToolImplementation`
 * (an `(contract, body)` pair produced by
 * {@link "@agentproto/driver".implementTool}) and returns an AI SDK
 * `Tool` that drops into `streamText({ tools })`, `generateText`, or
 * any downstream consumer that speaks the AI SDK tool surface (Mastra
 * wraps it, LangChain has interop, …).
 *
 * Same shape and semantics as `@agentproto/adapter-mastra` so apps
 * authoring tools once via `defineTool` + `implementTool` can ship
 * to either runtime — or both — without re-writing the body.
 *
 * Spec: https://agentproto.sh/docs/aip-14, https://agentproto.sh/docs/aip-30
 */

import { dynamicTool } from "ai"
import type { Tool as AiTool, ToolCallOptions } from "ai"
import type { ToolContext } from "@agentproto/tool"
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
  providerId: "ai-sdk-adapter",
  driverKind: "builtin",
  implementsEntry: { tool: "ai-sdk-adapter", version: "0.0.0" },
})

export interface ToAiSdkToolOptions<TContext extends ToolContext> {
  /** Per-request context passed through to the body's `context` arg. */
  context: TContext
  /**
   * Optional provider context — typically only needed for non-builtin
   * adapters that read `driverCtx.secrets` or `driverCtx.region`.
   * Builtin bodies usually leave this defaulted.
   */
  driverCtx?: DriverContext
}

/**
 * Adapt a {@link ToolImplementation} into an AI SDK v5 `Tool`.
 *
 * Type inference: `TContext` is inferred from `impl` only —
 * `bind.context` is wrapped in `NoInfer<>` so a literal like
 * `{ locale: "en" }` doesn't narrow the contract's
 * `{ locale: "en" | "fr" }` and reject the impl via TS's
 * contravariant-position function check.
 *
 * Implementation note: we dispatch through `dynamicTool` rather than
 * the typed `tool` overloads. The static `Tool<INPUT, OUTPUT>` type
 * uses a `NeverOptional<OUTPUT, …>` conditional that TS can't
 * evaluate through generic type parameters — the structural
 * assignment fails at the overload-resolution level even though the
 * shape is valid. `dynamicTool` accepts `FlexibleSchema<unknown>` +
 * `ToolExecuteFn<unknown, unknown>` directly (no NeverOptional gate),
 * runs the same identity adapter at runtime, and returns a marked
 * Tool that AI SDK's streamText / generateText accept everywhere.
 * Schema-level validation is preserved because we pass the contract's
 * Zod inputSchema through unchanged.
 */
export function toAiSdkTool<TInput, TOutput, TContext extends ToolContext>(
  impl: ToolImplementation<TInput, TOutput, TContext>,
  bind: ToAiSdkToolOptions<NoInfer<TContext>>
): AiTool<unknown, unknown> & { type: "dynamic" } {
  return dynamicTool({
    description: impl.tool.description,
    // AI SDK v5 uses `inputSchema` and accepts Zod schemas natively
    // via `FlexibleSchema<unknown>`; our Zod handle widens cleanly.
    inputSchema: impl.tool.inputSchema,
    execute: async (input: unknown, options: ToolCallOptions) => {
      // AI SDK validates `input` against `inputSchema` BEFORE calling
      // execute (per its docs and verified in `@ai-sdk/provider-
      // utils@3.0.20` source). At this point `input` is structurally
      // `TInput`; TS's `unknown` here reflects only the dynamicTool
      // signature, not the runtime contract. Narrowing via a noop
      // assignment to a TInput-typed variable expresses the post-
      // validation type without adding a runtime parse.
      const typedInput: TInput = input as TInput
      return impl.body({
        input: typedInput,
        context: bind.context,
        driverCtx: bind.driverCtx ?? DEFAULT_PROVIDER_CTX,
        signal: options.abortSignal ?? new AbortController().signal,
      })
    },
  })
}

export type { ToolImplementation } from "@agentproto/driver"
