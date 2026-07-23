/**
 * @agentproto/code-brain — the pure, backend-agnostic code-intelligence
 * contract.
 *
 * `ICodeBrainProvider` is net-new (it is NOT AIP-26 `code`, which is a
 * permissive manifest-block record, not a symbol graph). It is deliberately
 * *idiom-free*: no concrete backend's query dialect leaks into these types.
 * A backend adapter (e.g. one fronting an external code-intel engine)
 * translates this contract onto its own vocabulary — its query verbs,
 * source-scope wildcards, and CLI subcommands live in that adapter, never
 * here. Keeping the contract clean is what lets `ask_codebase` be authored,
 * typed, and tested against a fake provider before any real backend exists.
 */

import { z } from "zod"

/** A source span within a file. Lines/columns are 1-based. */
export interface SourceSpan {
  readonly startLine: number
  readonly startColumn?: number
  readonly endLine: number
  readonly endColumn?: number
}

/**
 * A resolved definition for a symbol. `kind` is a backend-normalised,
 * free-form label (e.g. "function", "class", "method") — not an enum, so
 * the contract never has to enumerate one backend's taxonomy.
 */
export interface SymbolDef {
  readonly symbol: string
  readonly kind: string
  readonly file: string
  readonly span: SourceSpan
  readonly signature: string
  readonly doc?: string
}

/** A directed call relationship between two symbols. */
export interface CallEdge {
  readonly from: string
  readonly to: string
  readonly file: string
  readonly span: SourceSpan
}

/**
 * A free-form federated query over the code graph — the "blend" path.
 * `scope` is a backend-neutral hint (which corpus/source to search); it is
 * intentionally NOT named after any backend's source-scoping flag.
 */
export interface GraphQuery {
  readonly question: string
  readonly scope?: string
  readonly limit?: number
}

/** One hit returned by {@link ICodeBrainProvider.graphQuery}. */
export interface GraphHit {
  readonly title: string
  readonly body: string
  readonly file?: string
  readonly span?: SourceSpan
  readonly score?: number
}

/** The result of a {@link ICodeBrainProvider.graphQuery}. */
export interface GraphResult {
  readonly hits: readonly GraphHit[]
}

/**
 * The pure code-brain contract. Every method is async and returns plain
 * data — no backend handles, no streaming iterators, no dialect strings.
 * A concrete backend implements this; the `ask_codebase` tool dispatches
 * over it via the per-call tool context.
 */
export interface ICodeBrainProvider {
  /** Resolve a symbol's definition, or `null` when it is unknown. */
  defineSymbol(symbol: string): Promise<SymbolDef | null>
  /** Inbound call edges — who calls `symbol`. */
  callers(symbol: string): Promise<readonly CallEdge[]>
  /** Outbound call edges — what `symbol` calls. */
  callees(symbol: string): Promise<readonly CallEdge[]>
  /** Free-form federated query over the code graph. */
  graphQuery(query: GraphQuery): Promise<GraphResult>
}

/** Zod mirror of {@link SourceSpan} — used by the tool's output schema. */
export const sourceSpanSchema: z.ZodType<SourceSpan> = z.object({
  startLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative().optional(),
})

/** Zod mirror of {@link SymbolDef}. */
export const symbolDefSchema: z.ZodType<SymbolDef> = z.object({
  symbol: z.string(),
  kind: z.string(),
  file: z.string(),
  span: sourceSpanSchema,
  signature: z.string(),
  doc: z.string().optional(),
})

/** Zod mirror of {@link CallEdge}. */
export const callEdgeSchema: z.ZodType<CallEdge> = z.object({
  from: z.string(),
  to: z.string(),
  file: z.string(),
  span: sourceSpanSchema,
})

/** Zod mirror of {@link GraphHit}. */
export const graphHitSchema: z.ZodType<GraphHit> = z.object({
  title: z.string(),
  body: z.string(),
  file: z.string().optional(),
  span: sourceSpanSchema.optional(),
  score: z.number().optional(),
})

/**
 * Zod mirror of {@link ICodeBrainProvider} for the tool `contextSchema`.
 * The provider is a live object with methods; zod can't deep-validate its
 * behaviour, so — exactly like `@agentproto/governance`'s host-injected
 * `filesystem`/`anchorSink` — its presence is asserted with `z.custom` and
 * its methods are exercised by the body downstream.
 */
export const codeBrainProviderSchema: z.ZodType<ICodeBrainProvider> =
  z.custom<ICodeBrainProvider>(
    (value) => typeof value === "object" && value !== null,
  )

/**
 * The `ask_codebase` tool context: the host injects an
 * {@link ICodeBrainProvider} at invocation time, so the tool body stays
 * backend-agnostic.
 */
export const codeBrainToolContextSchema = z.object({
  codeBrain: codeBrainProviderSchema,
})

export type CodeBrainToolContext = z.infer<typeof codeBrainToolContextSchema>
